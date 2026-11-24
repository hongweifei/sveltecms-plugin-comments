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
import type { PluginContext } from '#lib/cms/types/plugin.ts';
import { createRateLimiter } from '#lib/common/server/rate-limit.ts';
import { allUserRoles } from '#lib/cms/utils/user-role.ts';
import type { ConfigService } from './config';
import type { ContentSettingsService } from './content-settings';
import type { BlacklistService } from './blacklist';
import type { ClientInfoService } from './client-info';
import type { createPagePathService } from './page-paths';
import { pathToHref } from './validate';

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
	/** 「我的评论」自助列表：读自己的评论，额度与写操作分开 */
	mineLimiter: ReturnType<typeof createRateLimiter>;
	/** C3-2 评论计数缓存（/count 高频读，60s TTL；写路径经 bustCount 失效） */
	countCache: Map<string, { value: number; expires: number }>;
	COUNT_TTL_MS: number;
	/** D1：单页后代读放大护栏（/list 一次带出与 /children 续拉共用同一页宽） */
	CHILD_CAP: number;
	bustCount: () => void;
	lastCommentAt: (visitorId: string, userId?: string) => Promise<number | null>;
	sendReplyMail: (toEmail: string, replyContent: string, path: string | null) => void;
	/**
	 * 官方标门禁：可发官方回复（adminAccess 角色或 officialRoles 白名单角色）
	 */
	canPostOfficial: (user: unknown) => Promise<boolean>;
	/** 超管判定（跨内容审核门禁）：任一角色 → roles.adminAccess */
	isSuperAdmin: (user: unknown) => Promise<boolean>;
	/**
	 * 解析评论所属内容的作者标识：contentId 绑定经内容引擎反查，path 绑定
	 * 经 pages 桥取页面记录 userId。查不到返回 null（创作者无管理权）。
	 */
	contentOwnerId: (binding: {
		path: string | null;
		contentId: string | null;
		contentType: string | null;
	}) => Promise<string | null>;
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
	// 「我的评论」列表：只读自己的行，给宽松额度（60 次/分钟/IP）
	const mineLimiter = createRateLimiter('comments-mine', {
		windowMs: 60_000,
		maxRequests: 60,
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
					actionUrl: `${ctx.siteUrl}${pathToHref(path)}`,
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
	 * 官方标门禁（canPostOfficial）：登录用户可发官方回复的条件——任一角色的
	 * 角色行 adminAccess 为真（超级管理员），或角色名列入 officialRoles 白名单。
	 *
	 * 角色取框架 allUserRoles()：0.3 起用户可持多个角色（主角色 + `roles` 附加
	 * 清单），RBAC 按并集判定，插件保持一致口径——附加角色带来的官方身份同样生效。
	 *
	 * appAccess 只代表「能登录后台」：内容创作者同样需要它，因此不构成官方
	 * 身份依据。需要让编辑/运营角色发官方回复的站点，把角色名加进白名单。
	 *
	 * 角色名经框架守卫提取（better-auth 基础 User 类型不含 role/roles），取自
	 * session（服务端写入，客户端无法伪造），权威判据再查 roles 表——按角色名
	 * 60s 缓存，角色调整一分钟内生效。非登录/无角色 → false（不发查询）。
	 */
	const roleCache = new Map<string, { at: number; adminAccess: boolean }>();
	async function canPostOfficial(user: unknown): Promise<boolean> {
		const roles = allUserRoles(user);
		if (roles.length === 0) return false;
		for (const role of roles) {
			if (await roleAdminAccess(role)) return true;
		}
		const whitelist = services.cfg.officialRoles();
		return roles.some((role) => whitelist.includes(role));
	}

	/** 超管判定：任一角色行的 adminAccess 为真（跨内容审核的门禁） */
	async function isSuperAdmin(user: unknown): Promise<boolean> {
		for (const role of allUserRoles(user)) {
			if (await roleAdminAccess(role)) return true;
		}
		return false;
	}

	/** 角色行的 adminAccess 标志：按角色名查 roles 表并缓存 60 秒，查询失败 false */
	async function roleAdminAccess(role: string): Promise<boolean> {
		const hit = roleCache.get(role);
		if (hit && Date.now() - hit.at < 60_000) return hit.adminAccess;
		let adminAccess = false;
		try {
			const res = await ctx.db.find('roles', { filter: { name: role }, limit: 1 });
			adminAccess = res.data.some((r) => (r as Record<string, unknown>).adminAccess === true);
		} catch (e) {
			ctx.logger.warn(`comments: role check failed for ${role}: ${String(e)}`);
		}
		roleCache.set(role, { at: Date.now(), adminAccess });
		return adminAccess;
	}

	/**
	 * 评论所属内容的作者：contentId 绑定按类型反查内容记录，path 绑定经
	 * pages 桥取页面记录。查不到返回 null，创作者据此无管理权。
	 */
	async function contentOwnerId(binding: {
		path: string | null;
		contentId: string | null;
		contentType: string | null;
	}): Promise<string | null> {
		if (binding.contentId && binding.contentType) {
			try {
				const record = (await ctx.content?.findById(binding.contentType, binding.contentId)) as
					| Record<string, unknown>
					| null
					| undefined;
				const raw = record?.userId;
				if (typeof raw === 'string' && raw) return raw;
			} catch {
				/* 读取失败按无归属处理 */
			}
			return null;
		}
		if (binding.path) {
			const recordId = await services.pagePaths.pathToRecordId(binding.path);
			if (!recordId) return null;
			const row = (await ctx.db.findById('pages', recordId)) as Record<string, unknown> | null;
			const raw = row?.userId;
			if (typeof raw === 'string' && raw) return raw;
			return null;
		}
		return null;
	}

	return {
		ctx,
		...services,
		submitLimiter,
		likeLimiter,
		reportLimiter,
		deleteLimiter,
		editLimiter,
		mineLimiter,
		countCache,
		COUNT_TTL_MS,
		CHILD_CAP: 500,
		bustCount,
		lastCommentAt,
		sendReplyMail,
		canPostOfficial,
		isSuperAdmin,
		contentOwnerId
	};
}
