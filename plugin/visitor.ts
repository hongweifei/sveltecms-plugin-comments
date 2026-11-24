/**
 * 访客身份适配（框架 0.3 统一访客）。
 *
 * 框架用一个签名 cookie（`cms_visitor`）承载访客身份：稳定的匿名 `id`（一年），
 * 社交登录后把昵称/头像与提供方并入同一 cookie 的 `auth` 段（七天）。插件按两个
 * 口径消费它：
 *
 * - **visitorKey**：评论表的 `visitor_id` 列、点赞去重、本人待审可见、删除/编辑
 *   归属、隐私导出与删除统一用 `locals.visitor.id`——同一个人换 IP、换天都还是
 *   同一个键。无浏览器 cookie 的直连调用（headless / API 客户端）回落 IP+UA
 *   哈希，保证 NOT NULL 列与限流键始终有值。
 * - **socialVisitor**：只有带 `provider` 的访客才是「社交登录过」——昵称/头像由
 *   框架认定，身份三字段隐藏、评论免填邮箱。匿名访客虽然也有 `visitor.id`，
 *   仍按游客处理（照常填写昵称与邮箱）。
 */
import type { RequestEvent } from '@sveltejs/kit';
import { getRequestIp } from '#lib/common/server/rate-limit.ts';
import { computeVisitorId } from '#lib/cms/http/stats.ts';

/** 访客标识：统一访客 id 优先；直连场景回落 IP+UA 哈希 */
export function visitorKeyOf(event: RequestEvent): string {
	const id = event.locals.visitor?.id;
	if (typeof id === 'string' && id) return id;
	return computeVisitorId(
		getRequestIp(event),
		event.request.headers.get('user-agent') ?? undefined
	);
}

/** 社交登录过的访客（微信 / QQ）：昵称、头像与提供方来自框架签名 cookie */
export function socialVisitorOf(event: RequestEvent) {
	const visitor = event.locals.visitor;
	return visitor?.provider ? visitor : null;
}
