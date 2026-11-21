/**
 * 评论插件管理端点域（A 方案拆分自 plugin.ts）：admin/reply、content-settings、
 * feature、settings、eligible。非 public 注册自动经 requireAdminAccessApi 门禁。
 */

import { type RequestEvent } from '@sveltejs/kit';
import { getRequestIp } from '#lib/common/server/rate-limit.ts';
import { userAvatarUrl } from '#lib/cms/utils/user-avatar.ts';
import { bindingMatches, json, readJson, toPublic, type CommentRow, type ResolvedUser } from './helpers';
import { normalizeId, validateSubmitInput } from './validate';
import type { ApiDeps } from './deps';

export function registerAdminApi(d: ApiDeps): void {
	const { blacklistService, canPostOfficial, cfg, contentSettings, ctx, info, pagePaths, contentOwnerId, isSuperAdmin } = d;

	/**
	 * 内容归属校验：超管放行；其余登录用户只能管理自己内容下的评论。
	 * 归属取自评论绑定的内容记录（contentId 反查或 pages 桥），查不到即拒绝。
	 */
	async function canManageContent(
		user: unknown,
		binding: { path: string | null; contentId: string | null; contentType: string | null }
	): Promise<boolean> {
		if (await isSuperAdmin(user)) return true;
		const ownerId = await contentOwnerId(binding);
		const actorId = (user as { id?: string } | null | undefined)?.id;
		return Boolean(ownerId && actorId && ownerId === actorId);
	}

	// 站方回复：免审直接发布，官方徽章按官方身份判定（adminAccess 角色或
	// officialRoles 白名单）；昵称默认取登录者名。
	ctx.api.register({
		method: 'POST',
		path: '/admin/reply',
		handler: async (event: RequestEvent) => {
			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);

			// 管理员身份取自登录态，不消费客户端身份字段
			const result = validateSubmitInput(parsed.body, { skipIdentity: true });
			if (!result.ok) {
				return json(
					{ error: 'Validation failed', fieldErrors: result.fieldErrors },
					400
				);
			}
			const { content, path, contentId, contentType, parentId } = result.data;
			// 归属校验：创作者仅能回复自己内容下的评论
			if (!(await canManageContent(event.locals.user, { path, contentId, contentType }))) {
				return json({ error: 'Forbidden' }, 403);
			}
			let rootId: string | null = null;
			if (parentId) {
				const parent = await ctx.db.findById('comments', parentId);
				if (
					!parent ||
					!bindingMatches(parent as CommentRow, { path, contentId, contentType })
				) {
					return json(
						{ error: 'Validation failed', fieldErrors: { parentId: 'invalid' } },
						400
					);
				}
				rootId =
					typeof parent.rootId === 'string' && parent.rootId
						? parent.rootId
						: String(parent.id);
			}

			const user = event.locals.user;
			const { os, browser, region } = await info.collect(
				event.request.headers.get('user-agent'),
				getRequestIp(event)
			);
			const record = await ctx.db.create('comments', {
				content,
				authorName: user?.name || '官方',
				email: user?.email || null,
				website: null,
				userId: user?.id ?? null,
				status: 'approved',
				path,
				contentId,
				// 类型判别：管理端回复由界面携带所回复记录的集合 slug（管理员
				// 可信来源，无客户端伪造面）；缺失 = 任意类型（历史兼容口径）
				contentType: contentId ? (contentType ?? null) : null,
				// 内容归属快照：后台据此把评论审核权授予内容作者（创作者）
				contentOwnerId: await contentOwnerId({ path, contentId, contentType }),
				parentId,
				rootId,
				official: await canPostOfficial(user),
				likes: 0,
				reports: 0,
				os,
				browser,
				region,
				visitorId: 'admin'
			});
			// 头像 / 昵称不快照，响应用当前登录用户实时解析（locals.user 在手上）
			const userBy = user
				? new Map<string, ResolvedUser>([
						[
							String(user.id),
							{ name: user.name ?? null, avatar: userAvatarUrl(user) }
						]
					])
				: undefined;
			return json({
				success: true,
				comment: toPublic(record as CommentRow, false, userBy, {
					hideEnv: cfg.bool('hideEnv', false)
				})
			});
		}
	});


	// 内容级评论设置（创作者控制）：GET 查询，POST 部分更新（仅显式给出的开关
	// 生效）。closed 关闭该内容评论；requireLogin 仅登录可评；featuredOnly 仅展示精选。
	// 可选 contentType（集合 slug）：带类型则读写按 (类型, contentId) 判别行（防跨
	// 集合同 id 串读，管理端来源可信）；省略 = 旧口径（contentId 全局，历史行兼容）。
	ctx.api.register({
		method: 'GET',
		path: '/admin/content-settings',
		handler: async (event: RequestEvent) => {
			const contentId = normalizeId(event.url.searchParams.get('contentId') ?? '');
			if (!contentId) return json({ error: 'contentId required' }, 400);
			const contentType = normalizeId(event.url.searchParams.get('contentType') ?? '');
			if (!(await canManageContent(event.locals.user, { path: null, contentId, contentType: contentType || null }))) {
				return json({ error: 'Forbidden' }, 403);
			}
			return json({
				contentId,
				...(await contentSettings.get(contentId, contentType || null))
			});
		}
	});


	ctx.api.register({
		method: 'POST',
		path: '/admin/content-settings',
		handler: async (event: RequestEvent) => {
			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
			const contentId = normalizeId(parsed.body.contentId);
			if (!contentId) return json({ error: 'contentId required' }, 400);
			// 类型仅做形态归一（管理端 UI 传的是当前编辑记录的集合 slug，可信
			// 来源；且此端点是管理鉴权端点，无外部伪造面）
			const contentType = normalizeId(
				typeof parsed.body.contentType === 'string' ? parsed.body.contentType : ''
			);
			if (!(await canManageContent(event.locals.user, { path: null, contentId, contentType: contentType || null }))) {
				return json({ error: 'Forbidden' }, 403);
			}
			const patch: Record<string, boolean> = {};
			for (const key of ['closed', 'requireLogin', 'featuredOnly'] as const) {
				if (typeof parsed.body[key] === 'boolean') patch[key] = parsed.body[key];
			}
			await contentSettings.set(contentId, patch, contentType || null);
			return json({
				contentId,
				...(await contentSettings.get(contentId, contentType || null))
			});
		}
	});


	// 精选切换（公众号模式）：featured 缺省为取反，便于后台一键切换；
	// 仅对存在评论生效，featuredOnly 内容的公开列表只回精选评论。
	ctx.api.register({
		method: 'POST',
		path: '/admin/feature',
		handler: async (event: RequestEvent) => {
			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
			const id = normalizeId(parsed.body.id);
			if (!id) return json({ error: 'Invalid id' }, 400);
			const comment = await ctx.db.findById('comments', id);
			if (!comment) return json({ error: 'Not found' }, 404);
			// 归属校验：创作者仅能精选自己内容下的评论
			const actor = event.locals.user;
			const ownerId = String((comment as Record<string, unknown>).contentOwnerId ?? '');
			if (!(await isSuperAdmin(actor)) && (!ownerId || ownerId !== String(actor?.id ?? ''))) {
				return json({ error: 'Forbidden' }, 403);
			}
			const featured =
				typeof parsed.body.featured === 'boolean'
					? parsed.body.featured
					: comment.featured !== true;
			await ctx.db.update('comments', id, { featured });
			return json({ id, featured });
		}
	});


	// 关键词黑名单设置：GET 返回词表；POST 覆盖（逗号 / 换行分隔的原始串）。
	// 审核开关不在此处——走 manifest.config（管理端插件页的开关），避免两处真值。
	ctx.api.register({
		method: 'GET',
		path: '/admin/settings',
		handler: async (event: RequestEvent) => {
			// 黑名单属于站点级配置，仅超管可读
			if (!(await isSuperAdmin(event.locals.user))) return json({ error: 'Forbidden' }, 403);
			return json({ keywords: await blacklistService.get() });
		}
	});


	ctx.api.register({
		method: 'POST',
		path: '/admin/settings',
		handler: async (event: RequestEvent) => {
			// 黑名单属于站点级配置，仅超管可写
			if (!(await isSuperAdmin(event.locals.user))) return json({ error: 'Forbidden' }, 403);
			const parsed = await readJson(event);
			if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
			await blacklistService.set(
				typeof parsed.body.keywords === 'string' ? parsed.body.keywords : ''
			);
			return json({ keywords: await blacklistService.get() });
		}
	});


	// 内容编辑表单的「评论设置」插槽可见性（C4-*）：该记录可评论才让创作者
	// 配置三开关。两条命中路径（与 /list /submit 消费同款语义，配了即生效）——
	//  1) 类型命中 enabledTypes（contentId 绑定消费内容级设置）；
	//  2) 编辑 pages 记录且其公共路径命中 enabledPaths（路径白名单开启的页面
	//     评论，如 /enterprise）——前台 path 绑定经 pagePaths 桥反查同一条记录
	//     消费设置，故此处显示即有效。非 pages 集合无路径概念，仅按类型判定。
	ctx.api.register({
		method: 'GET',
		path: '/admin/eligible',
		handler: async (event: RequestEvent) => {
			const contentType = event.url.searchParams.get('contentType');
			const recordId = event.url.searchParams.get('recordId');
			if (!contentType) return json({ eligible: false });
			if (cfg.commentsEnabledFor(null, contentType)) return json({ eligible: true });
			// 类型未命中且站点声明了路径白名单时，才反查该 pages 记录的公共路径
			//（常态零额外查询）
			if (
				recordId &&
				contentType === 'pages' &&
				cfg.hasEnabledPaths() &&
				cfg.commentsEnabledFor(await pagePaths.recordPath(recordId), null)
			) {
				return json({ eligible: true });
			}
			return json({ eligible: false });
		}
	});}
