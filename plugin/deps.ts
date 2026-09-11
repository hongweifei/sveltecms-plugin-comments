/**
 * 评论插件端点域共享依赖（A 方案：端点拆分的地基）。
 *
 * register() 闭包态全部收敛到这里：五个限流器、计数缓存、D1 页宽护栏与
 * 跨端点工具（最近评论时间 / 回复邮件出口）。三个端点域模块
 * （api-public / api-interactions / api-admin）以 ApiDeps **显式**接收，
 * 不再依赖不可见的共享闭包——新增端点先看这张依赖表，职责边界一目了然。
 *
 * 限流器在工厂内创建（与原闭包语义一致）：每次 register() 得到全新 store，
 * 测试相互隔离、热重载不残留计数。
 */
import type { PluginContext } from '$lib/cms/types/plugin';
import { createRateLimiter } from '$lib/common/server/rate-limit';
import { userRole } from '$lib/cms/utils/user-role';
import type { ConfigService } from './config';
import type { ContentSettingsService } from './content-settings';
import type { BlacklistService } from './blacklist';
import type { ClientInfoService } from './client-info';
import type { createPagePathService } from './page-paths';

export interface ApiDeps {
	ctx: PluginContext;
	cfg: ConfigService;
	contentSettings: ContentSettingsService;
	blacklistService: BlacklistService;
	info: ClientInfoService;
	pagePaths: ReturnType<typeof createPagePathService>;
	submitLimiter: ReturnType<typeof createRateLimiter>;
	likeLimiter: ReturnType<typeof createRateLimiter>;
	reportLimiter: ReturnType<typeof createRateLimiter>;
	deleteLimiter: ReturnType<typeof createRateLimiter>;
	editLimiter: ReturnType<typeof createRateLimiter>;
	/** C3-2 评论计数缓存（/count 高频读，60s TTL；写路径经 bustCount 失效） */
	countCache: Map<string, { value: number; expires: number }>;
	COUNT_TTL_MS: number;
	/** D1：单页后代读放大护栏（/list 一次带出与 /children 续拉共用同一页宽） */
	CHILD_CAP: number;
	bustCount: () => void;
	lastCommentAt: (visitorId: string, userId?: string) => Promise<number | null>;
	sendReplyMail: (toEmail: string, replyContent: string, path: string | null) => void;
	/** 站方成员判定（官方标门禁）：userRole(user) → roles.appAccess；非登录/无角色 → false */
	isStaff: (user: unknown) => Promise<boolean>;
}

export function createApiDeps(
	ctx: PluginContext,
	services: {
		cfg: ConfigService;
		contentSettings: ContentSettingsService;
		blacklistService: BlacklistService;
		info: ClientInfoService;
		pagePaths: ReturnType<typeof createPagePathService>;
	}
): ApiDeps {
	// 提交限流：5 次/分钟/IP；互动端点各自限流；dispatch 路由另有 60/min/IP 公共兜底。
	const submitLimiter = createRateLimiter('comments-submit', {
		windowMs: 60_000,
		maxRequests: 5,
		keyFn: (c) => `ip:${c.ip ?? 'anon'}`
	});
	const likeLimiter = createRateLimiter('comments-like', {
		windowMs: 60_000,
		maxRequests: 30,
		keyFn: (c) => `ip:${c.ip ?? 'anon'}`
	});
	const reportLimiter = createRateLimiter('comments-report', {
		windowMs: 60_000,
		maxRequests: 5,
		keyFn: (c) => `ip:${c.ip ?? 'anon'}`
	});
	const deleteLimiter = createRateLimiter('comments-delete', {
		windowMs: 60_000,
		maxRequests: 10,
		keyFn: (c) => `ip:${c.ip ?? 'anon'}`
	});
	const editLimiter = createRateLimiter('comments-edit', {
		windowMs: 60_000,
		maxRequests: 10,
		keyFn: (c) => `ip:${c.ip ?? 'anon'}`
	});

	// C3-2 评论计数缓存：/count 是页面高频读（「N 条评论」），60s 内存 TTL，
	// 进程内任何评论变更（提交/删除/编辑/举报回待审）即整体失效——后台审核
	// 工作台的改动由 plugin.ts 的 content:beforeWrite filter 同步失效（A4）。
	const countCache = new Map<string, { value: number; expires: number }>();
	const COUNT_TTL_MS = 60_000;
	function bustCount() {
		countCache.clear();
	}

	/**
	 * 该访客 / 用户最近一条评论的时间戳（ms），无则 null。
	 * SQLite CURRENT_TIMESTAMP 是 UTC 的 'YYYY-MM-DD HH:MM:SS'（无时区标记），
	 * 按本地解析会偏一个时区——补 T/Z 按 UTC 解析（与前台 timeOf 同源）。
	 */
	async function lastCommentAt(visitorId: string, userId?: string): Promise<number | null> {
		const filter: Record<string, unknown> = userId ? { userId } : { visitorId };
		const page = await ctx.db.find('comments', { filter, sort: '-createdAt', limit: 1 });
		const raw = page.data[0]?.createdAt;
		if (typeof raw !== 'string' || !raw) return null;
		const ms = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
		return Number.isNaN(ms) ? null : ms;
	}

	/**
	 * A3：回复邮件统一出口（fire-and-forget）。提交即公开（免审）时直接调用；
	 * 审核开启时延后到 status→approved（collection:updated 订阅）补发，
	 * 收件人邮箱只在服务端流转，公开 API 永不出明文（既有口径）。
	 * C4：文案经 ctx.i18n.t() 按当前请求 locale 取词（双语站点不再硬编码中文）；
	 * 取不到语言时 t() 回退默认语言（zh），不会漏出裸 key。
	 */
	function sendReplyMail(toEmail: string, replyContent: string, path: string | null) {
		const title = ctx.i18n.t('mail_reply_title');
		void ctx.mail
			.sendTemplate('notification', {
				to: toEmail,
				ctx: {
					title,
					message: String(replyContent).slice(0, 120),
					actionUrl: `${ctx.siteUrl}${path ?? '/'}`,
					actionLabel: ctx.i18n.t('mail_reply_action')
				},
				fallback: {
					subject: title,
					text: String(replyContent).slice(0, 200)
				}
			})
			.catch(() => {});
	}

	/**
	 * 站方成员判定（官方标门禁）：登录用户的 role 对应 roles.appAccess=true。
	 * role 经框架 userRole() 守卫提取（better-auth 基础 User 类型不含 role），
	 * 取自 session（服务端写入，客户端无法伪造；additionalFields input:false
	 * 也挡了自助提权），权威判据再查 roles 表——按角色名 60s 缓存，角色调整
	 * 一分钟内生效，官方标频率完全够用。非登录/无角色 → false（不发查询）。
	 */
	const staffCache = new Map<string, { at: number; ok: boolean }>();
	async function isStaff(user: unknown): Promise<boolean> {
		const role = userRole(user);
		if (!role) return false;
		const hit = staffCache.get(role);
		if (hit && Date.now() - hit.at < 60_000) return hit.ok;
		let ok = false;
		try {
			const res = await ctx.db.find('roles', { filter: { name: role }, limit: 1 });
			ok = res.data.some((r) => (r as { appAccess?: unknown }).appAccess === true);
		} catch (e) {
			ctx.logger.warn(`comments: staff check failed for role ${role}: ${String(e)}`);
		}
		staffCache.set(role, { at: Date.now(), ok });
		return ok;
	}

	return {
		ctx,
		...services,
		submitLimiter,
		likeLimiter,
		reportLimiter,
		deleteLimiter,
		editLimiter,
		countCache,
		COUNT_TTL_MS,
		CHILD_CAP: 500,
		bustCount,
		lastCommentAt,
		sendReplyMail,
		isStaff
	};
}
