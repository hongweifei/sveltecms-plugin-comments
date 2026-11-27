/**
 * 访客身份（框架统一访客）。
 *
 * 框架用 better-auth 会话承载访客身份：未登录访客由 anonymous 插件持有一条
 * 匿名会话，第三方登录后仍是同一个 `user.id`，绑定到真实后台账号才会成为
 * 该账号。插件读 `locals.visitor`：
 *
 * - **visitorKey**：评论表的 `visitor_id` 列、点赞去重、本人待审可见、删除/编辑
 *   归属、隐私导出与删除统一用 `locals.visitor.id`——同一个人换设备、换渠道
 *   都是同一个键。无会话的直连请求（headless / API 客户端）用一次性随机标识
 *   记录：满足 NOT NULL 列，不做跨请求归人。
 * - **socialVisitor**：`account` 表里挂了第三方渠道的访客才是「社交登录过」——
 *   昵称/头像由 better-auth 用户资料认定，身份三字段隐藏、评论免填邮箱。
 *   只有匿名会话、没有渠道的访客仍按游客处理（照常填写昵称与邮箱）。
 */
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import type { PluginContext } from '#lib/cms/types/plugin.ts';
import { TABLE } from '#lib/cms/constants.ts';

interface VisitorLike {
	id: string;
	nickname?: string;
	avatar?: string | null;
	/** 旧框架形状：社交渠道直接写在访客投影上 */
	provider?: string;
}

/** 访客标识：统一访客 id；无会话的直连请求用一次性随机标识 */
export function visitorKeyOf(event: RequestEvent): string {
	const id = event.locals.visitor?.id;
	return typeof id === 'string' && id ? id : randomUUID();
}

/** 社交登录过的访客：昵称、头像与渠道来自 better-auth 会话与 account 表 */
export async function socialVisitorOf(
	event: RequestEvent,
	ctx?: Pick<PluginContext, 'db'>
): Promise<(VisitorLike & { provider: string }) | null> {
	const visitor = event.locals.visitor as VisitorLike | null | undefined;
	if (!visitor) return null;
	// 兼容旧投影：渠道已在 locals.visitor 上，不再查表
	if (typeof visitor.provider === 'string' && visitor.provider) {
		return visitor as VisitorLike & { provider: string };
	}
	// 匿名会话默认名是「访客 xxxx」，没有任何昵称/头像时不需要查渠道
	if (!visitor.nickname && !visitor.avatar) return null;
	const db = ctx?.db;
	if (!db) return null;
	const rows = await db.find(TABLE.ACCOUNT, {
		filter: { userId: visitor.id },
		limit: 20
	});
	const row = rows.data.find((item) => {
		const provider = typeof item.providerId === 'string' ? item.providerId : '';
		return provider !== '' && provider !== 'credential';
	});
	if (!row) return null;
	return { ...visitor, provider: String(row.providerId) };
}
