/**
 * 评论插件互动端点域（A 方案拆分自 plugin.ts）：like / report / delete / edit。
 * 身份判定与 B1 口径一致（登录 userId / 游客 visitorId）；写路径 bustCount 失效计数。
 */

import { type RequestEvent } from '@sveltejs/kit';
import { computeVisitorId } from '$lib/cms/stats';
import { getRequestIp } from '$lib/common/server/rate-limit';
import { json, readJson, type CommentRow } from './helpers';
import { MAX_CONTENT_LENGTH, REPORT_AUTO_PENDING_THRESHOLD, appendReportReason, isHoneypotFilled, normalizeId } from './validate';
import type { ApiDeps } from './deps';

export function registerInteractionApi(d: ApiDeps): void {
	const { bustCount, cfg, ctx, deleteLimiter, editLimiter, likeLimiter, reportLimiter } = d;

	// 点赞 toggle：未赞则赞、已赞则取消。comment_likes 按身份唯一键幂等——
	// 登录 {commentId, userId}、游客 {commentId, userId IS NULL, visitorId}。
	// B1：登录用户按 userId 去重——visitorId 是 hash(盐+IP+UA)，同 NAT 出口 +
	// 同 UA 的两个游客会互相顶掉，登录场景下不该再拿它当身份判据；游客保留
	// visitorId 口径。计数落库夹 0 下限（防并发取消把 likes 减成负数）。
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

			const user = event.locals.user;
			const visitorId = computeVisitorId(
				getRequestIp(event),
				event.request.headers.get('user-agent') ?? undefined
			);
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

			const user = event.locals.user;
			const visitorId = computeVisitorId(
				getRequestIp(event),
				event.request.headers.get('user-agent') ?? undefined
			);
			const ownByUser = user && comment.userId === user.id;
			// B1：visitorId 判据只在游客态生效——登录用户一律按 userId，同 NAT/UA
			// 的登录用户不再能撤回他人待审
			const ownPendingByVisitor = !user && comment.status === 'pending' && comment.visitorId === visitorId;
			if (!ownByUser && !ownPendingByVisitor) return json({ error: 'Forbidden' }, 403);

			const idStr = String(comment.id);
			if (comment.rootId) {
				// 回复：直接子回复改挂被删节点的父（游客只删待审，理论上无
				// approved 子级；登录用户删已审回复时该分支保护线程完整）
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

			const user = event.locals.user;
			const visitorId = computeVisitorId(
				getRequestIp(event),
				event.request.headers.get('user-agent') ?? undefined
			);
			const ownByUser = user && comment.userId === user.id;
			// B1：visitorId 判据只在游客态生效——登录用户一律按 userId，同 NAT/UA
			// 的登录用户不再能撤回他人待审
			const ownPendingByVisitor = !user && comment.status === 'pending' && comment.visitorId === visitorId;
			if (!ownByUser && !ownPendingByVisitor) return json({ error: 'Forbidden' }, 403);

			// 审核开关开启时 approved 编辑回待审（编辑后内容重进人工审核）；
			// pending 维持待审，spam 不可能到达（游客待审才可见）
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
	});}
