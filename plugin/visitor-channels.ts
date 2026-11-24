/**
 * 访客账号的社交渠道（框架 0.3 访客账号：`visitor_accounts` + `visitor_bindings`）。
 *
 * 评论归属按统一访客 id：一个 id 是一个账号，微信 / QQ 各是一行渠道绑定。
 * 同一账号挂上两个渠道后，从任一入口登录都回到同一份评论；已登录状态下用
 * 没挂上的渠道登录，框架按「切换账号」另起 id，历史评论留在原账号——所以
 * 绑定入口要摆在身份条上，别让人在不知情时把评论拆成两份。
 *
 * 本模块把 `/api/auth/visitor/account` 的渠道清单与 session 的提供方清单折算成
 * 前台可直接渲染的状态，并生成 `?bind=1` 绑定地址。纯函数、无请求、无全局态：
 * 解绑与合并两个账号只发生在框架账号页，插件不重复这套写操作。
 */

/** 框架下发的可用提供方（session 与 account 端点同形） */
export interface VisitorProviderEntry {
	id: string;
	label: string;
	start: string;
}

/** 账号下的一个渠道绑定（只含展示字段，openid / unionid 留在服务端） */
export interface VisitorChannelBinding {
	provider: string;
	nickname: string | null;
	avatar: string | null;
	lastLoginAt: string | null;
}

/** `/api/auth/visitor/account` 响应（字段按可选读取，端点降级时也能消费） */
export interface VisitorAccountPayload {
	authenticated?: boolean;
	account?: { bindings?: VisitorChannelBinding[]; canUnbind?: boolean } | null;
	currentProvider?: string | null;
	degraded?: boolean;
}

/** 前台身份条需要的渠道视图 */
export interface VisitorChannelState {
	/** 当前登录渠道（cookie 里的 auth 段）；账号数据不可用时回落会话值 */
	current: string | null;
	/** 已挂在本账号下的渠道 */
	bound: VisitorChannelBinding[];
	/** 提供方清单里尚未挂上的渠道：给出「绑定」入口 */
	available: VisitorProviderEntry[];
	/** 渠道多于一个时框架账号页才允许解绑 */
	canUnbind: boolean;
	/** 账号目录读不出来：不展示渠道明细，也不引导绑定 */
	degraded: boolean;
}

function normalizeBinding(value: unknown): VisitorChannelBinding | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
	if (!provider) return null;
	return {
		provider,
		nickname: typeof row.nickname === 'string' && row.nickname ? row.nickname : null,
		avatar: typeof row.avatar === 'string' && row.avatar ? row.avatar : null,
		lastLoginAt: typeof row.lastLoginAt === 'string' && row.lastLoginAt ? row.lastLoginAt : null
	};
}

/**
 * 账号渠道视图：`payload` 为 null（未取到 / 未登录）时按「只有当前渠道」处理，
 * 不把提供方清单当成待绑定项——没有账号数据就无从判断哪些渠道已经挂上。
 */
export function visitorChannelStateOf(
	payload: VisitorAccountPayload | null,
	providers: VisitorProviderEntry[],
	fallbackProvider?: string | null
): VisitorChannelState {
	const degraded = payload?.degraded === true;
	const raw = degraded ? [] : (payload?.account?.bindings ?? []);
	const seen = new Set<string>();
	const bound: VisitorChannelBinding[] = [];
	for (const item of raw) {
		const binding = normalizeBinding(item);
		if (!binding || seen.has(binding.provider)) continue;
		seen.add(binding.provider);
		bound.push(binding);
	}
	const current = payload?.currentProvider || fallbackProvider || bound[0]?.provider || null;
	// 只有端点明确说「已登录」（或直接给了账号数据）且目录未降级，才给绑定入口：
	// 否则「未绑定」无从判断，点下去可能把当前渠道重新绑一遍
	const signedIn = payload ? payload.authenticated !== false || Boolean(payload.account) : false;
	const available =
		signedIn && !degraded
			? providers.filter((provider) => provider.id && !seen.has(provider.id))
			: [];
	return {
		current,
		bound,
		available,
		canUnbind: payload?.account?.canUnbind === true && bound.length > 1,
		degraded
	};
}

/**
 * 绑定地址：框架 start 入口 + `?bind=1`（意图随 state 签名，回调不会丢）。
 * `start` 来自提供方注册表，空串说明该条目不完整——返回空串，调用方跳过渲染。
 */
export function visitorBindUrl(start: string, returnTo: string): string {
	if (!start) return '';
	const params = new URLSearchParams({ returnTo, bind: '1' });
	return `${start}${start.includes('?') ? '&' : '?'}${params.toString()}`;
}
