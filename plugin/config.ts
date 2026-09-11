/**
 * 评论插件站点级配置服务。
 *
 * manifest.config 的三类型 stringly-stored 适配（管理端 / 字符串化）+ 站点级
 * 开关判定（审核、白名单 / 黑名单）。本地集合类型校验由 content-settings
 * 服务负责（ctx.content 反查归属）——此处只判字面命中。
 *
 * 不读插件表，只读 ctx.config.get；注册时构造，闭包持有 ctx 即可。
 */
import type { PluginContext } from '$lib/cms/types/plugin';

/** 任意 ctx 的最小配置接口（解耦具体 PluginContext 类型，方便单测） */
export interface ConfigSource {
	config: { get<T = unknown>(key: string): T };
}

/** ConfigSource['config'] 的 get 方法形态（helper 收函数而非对象，避免
 * ctx.config.get 解绑 this 后调用面与类型面漂移） */
type ConfigGet = ConfigSource['config']['get'];

export interface ConfigService {
	/** 布尔配置（'true' / true / 缺省→fallback） */
	bool(key: string, fallback: boolean): boolean;
	/** 数字配置（非有限数/负数/缺省→fallback） */
	num(key: string, fallback: number): number;
	/**
	 * 审核开关：开启 → 新评论进 pending 等后台审核；关闭 → 直接 approved 免审发布。
	 * 缺省 = 开启（fail-safe，保持既有行为）。
	 */
	isModerationEnabled(): boolean;
	/**
	 * 站点级开关（纯白名单，职责边界：开/关的「关闭」动作归创作者内容级
	 * closed 设置）：站长只配置开启评论的页面路径与集合类型，任一命中即开启；
	 * 两列表留空 = 全站不开启（fail-safe，插件装上后默认静默）。
	 */
	commentsEnabledFor(path: string | null, contentType: string | null): boolean;
	/** 站点是否声明了任何路径白名单（eligible 端点路径反查的零查询护栏） */
	hasEnabledPaths(): boolean;
}

/**
 * 开关型配置（管理端以 'true' / 'false' 落库），缺省 / 空串 → fallback。
 * 同时兼容管理端 boolean 直传形态与字符串形态。
 */
function readBool(get: ConfigGet, key: string, fallback: boolean): boolean {
	const raw = get(key);
	if (raw === undefined || raw === null || raw === '') return fallback;
	return raw === true || raw === 'true';
}

/** 数字配置（以字符串落库），非有限数 / 负数 / 缺省 → fallback */
function readNum(get: ConfigGet, key: string, fallback: number): number {
	const raw = Number(get(key));
	return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * 列表型配置解析。multiselect 选择器以 JSON 数组字符串落库（'["posts"]'），
 * 也兼容直传数组；其余形态一律视为未配置（空列表）。
 */
function readList(get: ConfigGet, key: string): string[] {
	const raw = get<unknown>(key);
	if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
	if (typeof raw === 'string' && raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
		} catch {
			/* 非 JSON 数组 → 未配置 */
		}
	}
	return [];
}

export function createConfigService(ctx: ConfigSource): ConfigService {
	const get = ctx.config.get;
	return {
		bool: (key, fallback) => readBool(get, key, fallback),
		num: (key, fallback) => readNum(get, key, fallback),
		isModerationEnabled: () => readBool(get, 'moderation', true),
		commentsEnabledFor(path, contentType) {
			if (path && readList(get, 'enabledPaths').includes(path)) return true;
			if (contentType && readList(get, 'enabledTypes').includes(contentType)) return true;
			return false;
		},
		hasEnabledPaths: () => readList(get, 'enabledPaths').length > 0
	};
}
