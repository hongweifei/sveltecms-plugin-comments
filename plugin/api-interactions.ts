/**
 * 评论插件互动端点域（A 方案拆分自 plugin.ts）：like / report / delete / edit。
 * 身份判定与 B1 口径一致（登录 userId / 游客 visitorId）；写路径 bustCount 失效计数。
 */

import { type RequestEvent } from '@sveltejs/kit';
import { getRequestIp } from '#lib/common/server/rate-limit.ts';
import { json, readJson, type CommentRow } from './helpers';
import {
	MAX_CONTENT_LENGTH,
	REPORT_AUTO_PENDING_THRESHOLD,
	appendReportReason,
	clampPaging,
	isHoneypotFilled,
	normalizeId
} from './validate';
import { realAccountOf, visitorKeyOf } from './visitor';
import type { ApiDeps } from './deps';

export function registerInteractionApi(d: ApiDeps): void {
	const { bustCount, cfg, ctx, deleteLimiter, editLimiter, likeLimiter, mineLimiter, reportLimiter } = d;

	// 点赞 toggle：未赞则赞、已赞则取消。comment_likes 按身份唯一键幂等——
	// 登录 {commentId, userId}、游客 {commentId, userId IS NULL, visitorId}。
	// B1：登录用户按 userId 去重（同一账号多端登录只算一个赞）；游客按框架
	// 统一访客 id 去重，换 IP、换天都还是同一个人。计数落库夹 0 下限
	// （防并发取消把 likes 减成负数）。
	ctx.api.register({
		method: 'POST',
		path: '/like',
		public: true,
		handler: async (event: RequestEvent) => {
			const rl = await likeLimiter.check({ ip: getRequestIp(event) });
			if (!rl.allowed) return json({ error: 'Too many requests' }, 429);

			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
			const id = normalizeId(parsed.body.id);
			if (!id) return json({ error: 'Invalid id' }, 400);

			const comment = await ctx.db.findById('comments', id);
			if (!comment || comment.status !== 'approved') return json({ error: 'Not found' }, 404);

			const user = realAccountOf(event);
			const visitorId = visitorKeyOf(event);
			const likeFilter: Record<string, unknown> = user
				? { commentId: id, userId: user.id }
				: { commentId: id, userId: null, visitorId };
			const existing = await ctx.db.find('plugin_comments_likes', {
				filter: likeFilter,
				limit: 1
			});
			const cur = Number(comment.likes ?? 0);
			if (existing.data.length > 0) {
				await ctx.db.delete('plugin_comments_likes', String(existing.data[0].id));
				const likes = Math.max(0, cur - 1);
				await ctx.db.update('comments', id, { likes });
				return json({ liked: false, likes });
			}

			await ctx.db.create('plugin_comments_likes', {
				commentId: id,
				userId: user?.id ?? null,
				visitorId
			});
			await ctx.db.update('comments', id, { likes: cur + 1 });
			return json({ liked: true, likes: cur + 1 });
		}
	});


	// 举报：计数累加，达阈值自动退回待审（重新进入人工审核队列）。
	// C2：可选 reason 落库（最近 10 条，JSON 数组）——审核队列里管理员能
	// 看到"为什么被举报"，不再只有一个干巴巴的计数。
	ctx.api.register({
		method: 'POST',
		path: '/report',
		public: true,
		handler: async (event: RequestEvent) => {
			const rl = await reportLimiter.check({ ip: getRequestIp(event) });
			if (!rl.allowed) return json({ error: 'Too many requests' }, 429);

			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
			const id = normalizeId(parsed.body.id);
			if (!id) return json({ error: 'Invalid id' }, 400);

			const comment = await ctx.db.findById('comments', id);
			if (!comment || comment.status === 'spam') return json({ error: 'Not found' }, 404);

			const reports = Number(comment.reports ?? 0) + 1;
			const patch: Record<string, unknown> = { reports };
			const reason = typeof parsed.body.reason === 'string' ? parsed.body.reason : '';
			if (reason.trim()) {
				// 折叠空白 / 限长 / 最近 10 条裁剪统一由 appendReportReason 纯函数负责
				patch.reportReasons = appendReportReason(comment.reportReasons, reason);
			}
			if (reports >= REPORT_AUTO_PENDING_THRESHOLD && comment.status === 'approved') {
				patch.status = 'pending';
				bustCount();
			}
			await ctx.db.update('comments', id, patch);
			return json({ reports, status: patch.status ?? comment.status });
		}
	});


	// 删除自己的评论：登录用户可删本人任意评论；游客限本人待审（撤回）。
	// A2：删除不能留下孤儿子树——删顶层评论 = 级联删整条线程（rootId 指向
	// 它的全部后代）；删回复 = 把被删节点的直接子回复改挂到其父（rootId
	// 不变，平铺展示不受影响），节点本身删除。
	ctx.api.register({
		method: 'POST',
		path: '/delete',
		public: true,
		handler: async (event: RequestEvent) => {
			const rl = await deleteLimiter.check({ ip: getRequestIp(event) });
			if (!rl.allowed) return json({ error: 'Too many requests' }, 429);

			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
			const id = normalizeId(parsed.body.id);
			if (!id) return json({ error: 'Invalid id' }, 400);

			const comment = (await ctx.db.findById('comments', id)) as CommentRow | null;
			if (!comment) return json({ error: 'Not found' }, 404);

			const user = realAccountOf(event);
			const visitorId = visitorKeyOf(event);
			const ownByUser = user && comment.userId === user.id;
			// 访客按统一访客 id 管理自己的评论（框架签名 cookie，服务端认定）：
			// 与登录用户的权限面一致——本人任何状态的评论都能撤回。
			const ownByVisitor = !user && comment.visitorId === visitorId;
			if (!ownByUser && !ownByVisitor) return json({ error: 'Forbidden' }, 403);

			const idStr = String(comment.id);
			if (comment.rootId) {
				// 回复：直接子回复改挂被删节点的父（保护线程完整）
				const kids = await ctx.db.find('comments', {
					filter: { parentId: idStr },
					limit: 500
				});
				const newParent =
					typeof comment.parentId === 'string' && comment.parentId ? comment.parentId : null;
				for (const kid of kids.data) {
					await ctx.db.update('comments', String(kid.id), { parentId: newParent });
				}
			} else {
				// 顶层：整条线程级联删除
				const kids = await ctx.db.find('comments', {
					filter: { rootId: idStr },
					limit: 500
				});
				for (const kid of kids.data) {
					await ctx.db.delete('comments', String(kid.id));
				}
			}
			await ctx.db.delete('comments', idStr);
			bustCount();
			return json({ success: true });
		}
	});


	// 编辑自己的评论（C2-3）：与 /delete 同一权限面——登录用户可编辑本人
	// 任意评论，游客限本人待审（未进审核队列前改错字）。审核开关开启时，
	// 已审核评论编辑后回 pending 重新进人工审核；关闭则状态不变。
	// 仅 content 与蜜罐参与：绑定/身份字段编辑不消费（防止改挂楼/换身份）。
	ctx.api.register({
		method: 'POST',
		path: '/edit',
		public: true,
		handler: async (event: RequestEvent) => {
			const rl = await editLimiter.check({ ip: getRequestIp(event) });
			if (!rl.allowed) return json({ error: 'Too many requests' }, 429);

			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
			if (isHoneypotFilled(parsed.body)) {
				return new Response(null, { status: 204 });
			}
			const id = normalizeId(parsed.body.id);
			if (!id) return json({ error: 'Invalid id' }, 400);
			const content = typeof parsed.body.content === 'string' ? parsed.body.content.trim() : '';
			if (!content) {
				return json({ error: 'Validation failed', fieldErrors: { content: 'required' } }, 400);
			}
			const maxLength = cfg.num('maxLength', 500);
			if (content.length > Math.max(MAX_CONTENT_LENGTH, 0)) {
				return json(
					{ error: 'Validation failed', fieldErrors: { content: 'too_long' } },
					400
				);
			}
			if (maxLength > 0 && content.length > maxLength) {
				return json(
					{ error: 'Validation failed', fieldErrors: { content: `max ${maxLength}` } },
					400
				);
			}

			const comment = await ctx.db.findById('comments', id);
			if (!comment) return json({ error: 'Not found' }, 404);

			const user = realAccountOf(event);
			const visitorId = visitorKeyOf(event);
			const ownByUser = user && comment.userId === user.id;
			// 访客按统一访客 id 管理自己的评论：与登录用户同一权限面。已发布评论
			// 编辑后按审核开关回待审（重进人工审核），被标记 spam 的评论不开放编辑。
			const ownByVisitor = !user && comment.visitorId === visitorId;
			if (!ownByUser && !ownByVisitor) return json({ error: 'Forbidden' }, 403);
			if (comment.status === 'spam') return json({ error: 'Forbidden' }, 403);

			// 审核开关开启时 approved 编辑回待审（编辑后内容重进人工审核）；
			// pending 维持待审
			const nextStatus =
				comment.status === 'approved' && cfg.isModerationEnabled() ? 'pending' : comment.status;
			await ctx.db.update('comments', id, { content, status: nextStatus });
			bustCount();
			return json({
				success: true,
				content,
				status: nextStatus,
				pending: nextStatus === 'pending'
			});
		}
	});

	// 「我的评论」自助管理：按统一访客 id（登录用户按 userId）列出本人的评论，
	// 含待审 / 已发布 / 被标记未公开的行，供前台面板查看、编辑、删除——访客
	// 无需账号也能像账号一样管理自己发过的内容。
	ctx.api.register({
		method: 'GET',
		path: '/mine',
		public: true,
		handler: async (event: RequestEvent) => {
			const rl = await mineLimiter.check({ ip: getRequestIp(event) });
			if (!rl.allowed) return json({ error: 'Too many requests' }, 429);

			const user = realAccountOf(event);
			const visitorId = visitorKeyOf(event);
			const { page, pageSize } = clampPaging(
				event.url.searchParams.get('page'),
				event.url.searchParams.get('pageSize')
			);
			// 登录用户看账号名下的评论；游客看自己访客 id 名下的评论
			const filter: Record<string, unknown> = user
				? { userId: user.id }
				: { userId: null, visitorId };
			const res = await ctx.db.find('comments', {
				filter,
				sort: '-createdAt',
				page,
				limit: pageSize
			});
			const rows = res.data as CommentRow[];
			return json(
				{
					data: rows.map((row) => ({
						id: String(row.id),
						content: String(row.content ?? ''),
						status: typeof row.status === 'string' ? row.status : 'pending',
						path: typeof row.path === 'string' && row.path ? row.path : null,
						contentId: typeof row.contentId === 'string' && row.contentId ? row.contentId : null,
						contentType:
							typeof row.contentType === 'string' && row.contentType ? row.contentType : null,
						parentId: typeof row.parentId === 'string' && row.parentId ? row.parentId : null,
						likes: typeof row.likes === 'number' ? row.likes : 0,
						reports: typeof row.reports === 'number' ? row.reports : 0,
						createdAt: String(row.createdAt ?? '')
					})),
					total: typeof res.meta.total === 'number' ? res.meta.total : rows.length,
					page,
					pageSize
				},
				200,
				{ 'cache-control': 'private, no-store' }
			);
		}
	});}
