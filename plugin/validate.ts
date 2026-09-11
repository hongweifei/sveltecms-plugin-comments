/**
 * 评论插件输入的纯函数校验层：服务端唯一信任边界——客户端传来的所有字段
 * 在此归一/拒绝。不依赖任何运行时状态，独立单测。
 */

export const MAX_CONTENT_LENGTH = 2000;
export const MAX_AUTHOR_NAME_LENGTH = 40;
export const MAX_PATH_LENGTH = 300;
export const MAX_ID_LENGTH = 64;
export const MAX_KEYWORDS = 200;
export const MAX_KEYWORD_LENGTH = 50;
export const MAX_EMAIL_LENGTH = 100;
export const MAX_WEBSITE_LENGTH = 200;
export const MAX_REPORT_REASON_LENGTH = 200;
/** C2：举报理由只保留最近若干条（防单条评论理由无限堆积） */
export const MAX_REPORT_REASONS = 10;
export const REPORT_AUTO_PENDING_THRESHOLD = 3;
export const PAGE_SIZE_DEFAULT = 20;

/**
 * 集合 slug 形态（与脚手架 constants 的 SAFE_SLUG_RE 同形）。本模块为独立单测
 * 的纯函数层、零 import，故本地定义而非引入。
 */
const CONTENT_TYPE_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const PAGE_SIZE_MAX = 50;

/**
 * 归一页面路径：去 query/hash、折叠尾斜杠（根路径 "/" 保留）、限长。
 * 非法输入返回 null（与 contentId 二选一作为评论绑定键）。
 */
export function normalizePagePath(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	let path = raw.trim();
	if (!path.startsWith('/')) return null;
	const cut = path.search(/[?#]/);
	if (cut !== -1) path = path.slice(0, cut);
	if (path.length > 1) path = path.replace(/\/+$/, '');
	if (!path || path.length > MAX_PATH_LENGTH) return null;
	return path;
}

/** 内容项 / 评论 ID 形态：非空短标识（与 baseColumns id 同源生成器对齐） */
export function normalizeId(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const id = raw.trim();
	if (!id || id.length > MAX_ID_LENGTH) return null;
	return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** 清洗昵称：去控制字符、折叠空白、限长；空值返回空串（展示层回退「访客」） */
export function sanitizeAuthorName(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	const name = raw
		.replace(/\p{Cc}/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return name.slice(0, MAX_AUTHOR_NAME_LENGTH);
}

/** 蜜罐字段：正常人类不可见不可填，非空即机器人（_hp 与真实 website 字段区分开） */
export function isHoneypotFilled(body: unknown): boolean {
	const v = (body as { _hp?: unknown } | null)?._hp;
	return typeof v === 'string' && v.trim() !== '';
}

/** 评论绑定键：path 与 contentId 至少其一（contentId 优先语义由调用方决定）；
 * contentType 为集合类型判别（contentId 跨集合不保证唯一，绑定查询带类型防串扰） */
export interface CommentBinding {
	path: string | null;
	contentId: string | null;
	contentType: string | null;
}

/** 集合 slug 归一：仅形态校验（^[a-zA-Z][a-zA-Z0-9_]*$），归属真伪由调用方经内容引擎反查 */
export function normalizeContentType(raw: unknown): string | null {
	return typeof raw === 'string' && CONTENT_TYPE_RE.test(raw.trim()) ? raw.trim() : null;
}

export function resolveBinding(
	pathRaw: unknown,
	contentIdRaw: unknown,
	contentTypeRaw?: unknown
): CommentBinding | null {
	const path = pathRaw === undefined || pathRaw === null ? null : normalizePagePath(pathRaw);
	const contentId =
		contentIdRaw === undefined || contentIdRaw === null ? null : normalizeId(contentIdRaw);
	if (pathRaw != null && path === null) return null;
	if (contentIdRaw != null && contentId === null) return null;
	if (!path && !contentId) return null;
	return { path, contentId, contentType: normalizeContentType(contentTypeRaw) };
}

export type SubmitInputResult =
	| {
			ok: true;
			data: {
				content: string;
				authorName: string;
				/** 游客邮箱：允许留空（B2b 开关 guestEmailOptional 开时）；空值为 null */
				email: string | null;
				website: string | null;
				path: string | null;
				contentId: string | null;
				/** 集合 slug：由主题模板随页面注入（服务端渲染），供站点级类型开关判定 */
				contentType: string | null;
				parentId: string | null;
			};
	  }
	| { ok: false; fieldErrors: Record<string, string> };

/** 邮箱格式（提交必填；仅存储与 gravatar 哈希，绝不对外输出明文） */
export function isValidEmail(raw: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

/** 主页归一：去空白限长，缺协议补 https://；非法返回 null */
export function normalizeWebsite(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'string') return null;
	const url = raw.trim();
	if (!url) return null;
	if (url.length > MAX_WEBSITE_LENGTH) return null;
	const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
	try {
		const parsed = new URL(withProtocol);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		return parsed.toString();
	} catch {
		return null;
	}
}

export function validateSubmitInput(
	body: unknown,
	opts: { skipIdentity?: boolean; emailOptional?: boolean } = {}
): SubmitInputResult {
	const b = (body ?? {}) as Record<string, unknown>;

	const content = typeof b.content === 'string' ? b.content.trim() : '';
	if (!content) return { ok: false, fieldErrors: { content: 'required' } };
	if (content.length > MAX_CONTENT_LENGTH)
		return { ok: false, fieldErrors: { content: 'too_long' } };

	const binding = resolveBinding(b.path, b.contentId);
	if (!binding) return { ok: false, fieldErrors: { binding: 'path_or_contentId_required' } };

	const parentId = b.parentId === undefined || b.parentId === null ? null : normalizeId(b.parentId);
	if (b.parentId != null && !parentId) return { ok: false, fieldErrors: { parentId: 'invalid' } };

	// 身份三字段：游客默认必填邮箱（仅存储/gravatar，明文不外发）；skipIdentity 时
	// 身份由服务端登录态（locals.user）落库，不消费客户端传来的身份字段。
	// emailOptional（B2b）：站点开启「游客邮箱可留空」时，空值放行（无头像派生源，
	// 前端色块兜底），填了仍严格校验格式。
	let email: string | null = null;
	let website: string | null = null;
	if (!opts.skipIdentity) {
		const rawEmail = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
		if (rawEmail) {
			if (rawEmail.length > MAX_EMAIL_LENGTH || !isValidEmail(rawEmail))
				return { ok: false, fieldErrors: { email: 'invalid' } };
			email = rawEmail;
		} else if (!opts.emailOptional) {
			return { ok: false, fieldErrors: { email: 'required' } };
		}
		website = normalizeWebsite(b.website);
		if (b.website != null && b.website !== '' && website === null)
			return { ok: false, fieldErrors: { website: 'invalid' } };
	}

	// 集合类型由主题模板注入（服务端渲染，非用户手填）——此处只做形态归一，
	// 归属真伪由插件用内容引擎反查校验（见 resolveContentType）
	const contentType = normalizeContentType(b.contentType);

	return {
		ok: true,
		data: {
			content,
			authorName: sanitizeAuthorName(b.authorName),
			email,
			website,
			path: binding.path,
			contentId: binding.contentId,
			contentType,
			parentId
		}
	};
}

/** 分页参数归一：page 从 1、pageSize 钳 1..MAX，非法回退默认值 */
export function clampPaging(
	pageRaw: unknown,
	sizeRaw: unknown
): { page: number; pageSize: number } {
	const page = Number(pageRaw);
	const pageSize = Number(sizeRaw);
	return {
		page: Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1,
		pageSize:
			Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= PAGE_SIZE_MAX
				? pageSize
				: PAGE_SIZE_DEFAULT
	};
}

/** 关键词黑名单解析：逗号/换行分隔、trim、小写、去空去重、限量限长 */
export function parseBlacklist(raw: unknown): string[] {
	if (typeof raw !== 'string') return [];
	const seen = new Set<string>();
	for (const part of raw.split(/[,\n]/)) {
		const word = part.trim().toLowerCase().slice(0, MAX_KEYWORD_LENGTH);
		if (word) seen.add(word);
		if (seen.size >= MAX_KEYWORDS) break;
	}
	return [...seen];
}

/** 命中黑名单返回命中的词（小写比对），未命中返回 null。
 * C2：词形关键词（纯 ASCII \w 字符）按 \b 词边界匹配——子串包含会误伤
 * （ass 命中 class / passing）；CJK / 短语 / 标点关键词保持子串包含——
 * JS 的 \w 不含 CJK，\b 在中文词内部根本不存在边界，加边界等于中文失效。 */
const WORDLIKE_KEYWORD_RE = /^[a-z0-9_]+$/;
export function matchBlacklist(content: string, keywords: string[]): string | null {
	const lower = content.toLowerCase();
	for (const word of keywords) {
		if (!word) continue;
		if (WORDLIKE_KEYWORD_RE.test(word)) {
			// 词形关键词全为 \w 字符，无需转义即安全嵌入 RegExp
			if (new RegExp(`\\b${word}\\b`).test(lower)) return word;
		} else if (lower.includes(word)) {
			return word;
		}
	}
	return null;
}

/**
 * C2：把一条举报理由追加进已存的 JSON 数组（reportReasons 列）。只保留最近
 * MAX_REPORT_REASONS 条，防单条评论理由无限堆积。已有值非法/非数组时视为空。
 * 返回要落库的 JSON 字符串。
 */
export function appendReportReason(existing: unknown, reason: string): string {
	const clean = reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REPORT_REASON_LENGTH);
	if (!clean) return typeof existing === 'string' ? existing : '[]';
	let list: string[] = [];
	if (typeof existing === 'string' && existing) {
		try {
			const parsed: unknown = JSON.parse(existing);
			if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === 'string');
		} catch {
			list = [];
		}
	}
	list.push(clean);
	if (list.length > MAX_REPORT_REASONS) list = list.slice(list.length - MAX_REPORT_REASONS);
	return JSON.stringify(list);
}
