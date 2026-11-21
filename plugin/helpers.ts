/**
 * 评论插件纯工具层：HTTP / 绑定键 / 行类型 / 公开投影。
 * 不依赖任何运行时状态、不读 ctx，独立可单测；
 * 与 plugin.ts 内联旧实现等价——只是把入口集中到此处供端点共享。
 */
import type { RequestEvent } from '@sveltejs/kit';
import { emailAvatarUrl } from '#lib/cms/utils/user-avatar.ts';
import { formatRegion } from './region';
import type { CommentBinding } from './validate';
import { resolveBinding } from './validate';
import type { PublicComment } from './shared';

/** JSON 响应辅助（默认 application/json；headers 用于 429 retry-after 等） */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});
}

/** 解析 JSON body（非对象/解析失败一律判失败，不抛错） */
export async function readJson(
	event: RequestEvent
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
	try {
		const body = await event.request.json();
		if (typeof body !== 'object' || body === null) return { ok: false };
		return { ok: true, body: body as Record<string, unknown> };
	} catch {
		return { ok: false };
	}
}

/**
 * 评论数据库行的最小超集（读库只关心用到的字段）。
 * 对外投影前形态：剥离内部存证、统一 unknown → 受类型。
 */
export type CommentRow = {
	id: string | number;
	content: unknown;
	authorName: unknown;
	email: unknown;
	avatar: unknown;
	website: unknown;
	userId: unknown;
	/** 访客登录来源（当前仅 'wechat'），匿名游客为空 */
	visitorProvider?: unknown;
	status: unknown;
	path: unknown;
	contentId: unknown;
	/** 内容类型判别（集合 slug）；历史行可空 = 任意类型 */
	contentType?: unknown;
	parentId: unknown;
	rootId: unknown;
	official: unknown;
	featured: unknown;
	likes: unknown;
	reports: unknown;
	/** C2：最近若干条举报理由（JSON 字符串数组）；仅管理端读取，不外发投影 */
	reportReasons?: unknown;
	os: unknown;
	browser: unknown;
	region: unknown;
	createdAt: unknown;
	visitorId: unknown;
};

/** 实时反查到的 user 表投影（仅头像与昵称，绝不外发 email 明文） */
export type ResolvedUser = { name: string | null; avatar: string | null };

/** 从查询串或 JSON body 解析绑定键（path / contentId 至少其一，附带类型判别） */
export function bindingOf(source: URLSearchParams | Record<string, unknown>) {
	const get = (k: string) =>
		source instanceof URLSearchParams ? source.get(k) : (source as Record<string, unknown>)[k];
	return resolveBinding(get('path'), get('contentId'), get('contentType'));
}

/**
 * 绑定 → db.find 过滤条件（path 与 contentId 两键 AND）。
 * path 以归一后的可读原文存储与比较（见 validate.normalizePagePath），
 * 中文路径按原文精确命中。
 * contentId 绑定额外带类型判别：声明类型时经 _$or 命中「同类型行 + 空类型
 * 行」；未声明类型时退化为纯 contentId 匹配（headless 只传 id 的口径）。
 */
export function bindingFilter(binding: CommentBinding): Record<string, unknown> {
	const filter: Record<string, unknown> = {};
	if (binding.path) filter.path = binding.path;
	if (binding.contentId) {
		if (binding.contentType) {
			filter._$or = [
				{ contentId: binding.contentId, contentType: binding.contentType },
				{ contentId: binding.contentId, contentType: null }
			];
		} else {
			filter.contentId = binding.contentId;
		}
	}
	return filter;
}

/**
 * 绑定匹配：评论与目标绑定共享任一键即视为同页（两键同时提供时需都匹配）。
 * 与插件双绑定语义一致——path/contentId 任一命中即同页。
 * 类型判别：双方都带 contentType 且不等 → 直接否（跨集合同 id 不互认）；
 * 评论行 contentType 为空（历史行）视为任意类型。
 */
export function bindingMatches(
	row: { path?: unknown; contentId?: unknown; contentType?: unknown },
	binding: CommentBinding
): boolean {
	if (
		binding.contentType &&
		typeof row.contentType === 'string' &&
		row.contentType &&
		row.contentType !== binding.contentType
	) {
		return false;
	}
	if (binding.path && binding.contentId) {
		return row.path === binding.path || row.contentId === binding.contentId;
	}
	if (binding.path) return row.path === binding.path;
	return row.contentId === binding.contentId;
}

/**
 * 对外投影：剥离 userId / visitorId / email 明文等内部存证；
 * email 只出头像地址——框架 emailAvatarUrl：QQ 邮箱 → qlogo，其余 → cravatar）；
 * 登录用户（userId 有值）的头像与昵称按 user 表实时反查（依赖 manifest 声明
 * 的 'user' 系统表只读权限），反查缺失则回落遗留 avatar 快照列与本行存证；
 * 游客无 userId 不查表。
 *
 * mine / pending 由调用方附加：前者由 visitorId / userId 派生于上下文，
 * 后者是 status === 'pending' 的别名。
 *
 * hideEnv（B2a）：站点开启「前台隐藏设备环境」时 os/browser/region 输出 null
 * （库里仍存，管理端可见）——IP 属地对隐私敏感的站点不再公开。
 *
 * region 出口统一归一成「国家·省份·城市·运营商」：历史行存的是离线库原始
 * 竖线记录，读取时格式化即可与新评论一致，无需迁移数据。
 *
 * isAuthor（作者标）**不落列存储**——「评论人是否内容作者」是纯派生量（评论
 * userId 联内容记录 userId），存列既冗余、又会在内容转作者后撒谎。调用方
 * 解析出本绑定内容作者的 userId 传入 opts.contentAuthorId，投影即派生。
 */
export function toPublic(
	row: CommentRow,
	mine: boolean,
	userBy?: ReadonlyMap<string, ResolvedUser>,
	opts?: { hideEnv?: boolean; contentAuthorId?: string | null }
): PublicComment {
	const email = typeof row.email === 'string' && row.email ? row.email : null;
	const snapshot = typeof row.avatar === 'string' && row.avatar ? row.avatar : null;
	const live = row.userId ? userBy?.get(String(row.userId)) : undefined;
	const hideEnv = opts?.hideEnv === true;
	return {
		id: String(row.id ?? ''),
		authorName:
			live?.name ?? (typeof row.authorName === 'string' && row.authorName ? row.authorName : null),
		content: String(row.content ?? ''),
		createdAt: String(row.createdAt ?? ''),
		parentId: typeof row.parentId === 'string' && row.parentId ? row.parentId : null,
		rootId: typeof row.rootId === 'string' && row.rootId ? row.rootId : null,
		official: row.official === true,
		isAuthor: Boolean(opts?.contentAuthorId && row.userId === opts.contentAuthorId),
		featured: row.featured === true,
		likes: typeof row.likes === 'number' ? row.likes : 0,
		avatar: live?.avatar ?? snapshot ?? emailAvatarUrl(email),
		website: typeof row.website === 'string' && row.website ? row.website : null,
		visitorProvider: row.visitorProvider === 'wechat' ? 'wechat' : null,
		os: hideEnv ? null : typeof row.os === 'string' && row.os ? row.os : null,
		browser: hideEnv ? null : typeof row.browser === 'string' && row.browser ? row.browser : null,
		region: hideEnv
			? null
			: formatRegion(typeof row.region === 'string' ? row.region : null) || null,
		mine,
		pending: row.status === 'pending'
	};
}
