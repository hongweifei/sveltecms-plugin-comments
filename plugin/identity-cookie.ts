/**
 * 访客身份记忆 cookie：把上次成功评论填写的昵称 / 邮箱 / 主页记在访客浏览器里，
 * 下次打开评论区由 `/list` 的 `remembered` 字段回传，表单直接预填——回访不用
 * 重填一遍（twikoo 式「快速评论」）。
 *
 * 服务端写入、HttpOnly：脚本读不到这枚 cookie，PII 不暴露给前端 JS；只有评论
 * 组件经同源 `/list` 拿到属于自己的回填值。登录用户与微信访客的身份来自会话 /
 * 签名 cookie，不落这里。有效期 180 天，随评论提交刷新。
 */
import { MAX_AUTHOR_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_WEBSITE_LENGTH } from './shared';

export const IDENTITY_COOKIE = 'comments_identity';

const IDENTITY_MAX_AGE = 60 * 60 * 24 * 180;

/** 只依赖 cookie 读写三方法（SvelteKit 的 cookies 结构兼容，单测可直接替身） */
export interface CookieStore {
	get(name: string): string | undefined;
	set(name: string, value: string, opts?: Record<string, unknown>): void;
	delete(name: string, opts?: Record<string, unknown>): void;
}

/** 回填用的访客身份三字段（与表单一致，空串表示未填写） */
export interface RememberedIdentity {
	authorName: string;
	email: string;
	website: string;
}

/** 读取并校验 cookie 里的身份：损坏 JSON、非字符串字段、超长值一律降级为空 */
export function readRememberedIdentity(event: { cookies: CookieStore }): RememberedIdentity | null {
	const raw = event.cookies.get(IDENTITY_COOKIE);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const src = parsed as Record<string, unknown>;
		const text = (v: unknown, max: number) =>
			typeof v === 'string' ? v.slice(0, max) : '';
		const identity: RememberedIdentity = {
			authorName: text(src.authorName, MAX_AUTHOR_NAME_LENGTH),
			email: text(src.email, MAX_EMAIL_LENGTH),
			website: text(src.website, MAX_WEBSITE_LENGTH)
		};
		return identity.authorName || identity.email || identity.website ? identity : null;
	} catch {
		return null;
	}
}

/** 写入身份 cookie（三字段全空时清除，不留空壳） */
export function rememberIdentity(
	event: { cookies: CookieStore },
	identity: RememberedIdentity
): void {
	if (!identity.authorName && !identity.email && !identity.website) {
		event.cookies.delete(IDENTITY_COOKIE, { path: '/' });
		return;
	}
	event.cookies.set(IDENTITY_COOKIE, JSON.stringify(identity), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: IDENTITY_MAX_AGE,
		secure: process.env.NODE_ENV === 'production'
	});
}
