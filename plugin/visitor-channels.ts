/**
 * 访客渠道视图（框架 better-auth 会话）。
 *
 * 身份只有一套：匿名会话是访客，第三方登录把渠道挂到同一个 `user.id`，
 * 绑定到真实后台账号才会成为该账号。账号页与评论身份条都消费
 * `/api/auth/identity/state` 的同一份数据：
 *
 * - `bindings`：当前用户已经挂上的第三方渠道（account 表）；
 * - `providers`：站点已启用的渠道目录；
 * - `canUnbind`：渠道多于一个时框架才允许解绑。
 *
 * 本模块只做视图折算：已挂渠道与可绑定渠道分开，不重复写绑定/解绑。
 */

/** 框架下发的可用渠道 */
export interface VisitorProviderEntry {
	id: string;
	label: string;
}

/** 账号下的一个渠道绑定（只含展示字段，openid / unionid 留在服务端） */
export interface VisitorChannelBinding {
	accountId?: string;
	provider: string;
	nickname: string | null;
	avatar: string | null;
	lastLoginAt: string | null;
}

/** `/api/auth/identity/state` 响应 */
export interface IdentityStatePayload {
	authenticated?: boolean;
	anonymous?: boolean;
	providers?: VisitorProviderEntry[];
	bindings?: VisitorChannelBinding[];
	canUnbind?: boolean;
}

/** 前台身份条需要的渠道视图 */
export interface VisitorChannelState {
	/** 当前展示渠道：已绑定列表的第一个 */
	current: string | null;
	/** 已挂在本账号下的渠道；第一个作为当前渠道展示 */
	bound: VisitorChannelBinding[];	/** 提供方清单里尚未挂上的渠道：给出「绑定」入口 */
	available: VisitorProviderEntry[];
	/** 渠道多于一个时框架账号页才允许解绑 */
	canUnbind: boolean;
}

function normalizeBinding(value: unknown): VisitorChannelBinding | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
	if (!provider) return null;
	return {
		accountId: typeof row.accountId === 'string' && row.accountId ? row.accountId : undefined,
		provider,
		nickname: typeof row.nickname === 'string' && row.nickname ? row.nickname : null,
		avatar: typeof row.avatar === 'string' && row.avatar ? row.avatar : null,
		lastLoginAt: typeof row.lastLoginAt === 'string' && row.lastLoginAt ? row.lastLoginAt : null
	};
}

/**
 * 已登录（至少挂了一个渠道）时，把渠道目录里尚未挂上的项作为绑定入口；
 * 匿名会话没有任何渠道，只展示登录入口，不出现「绑定」。
 */
export function visitorChannelStateOf(
	payload: IdentityStatePayload | null,
	providers: VisitorProviderEntry[]
): VisitorChannelState {
	const seen = new Set<string>();
	const bound: VisitorChannelBinding[] = [];
	for (const item of payload?.bindings ?? []) {
		const binding = normalizeBinding(item);
		if (!binding || seen.has(binding.provider)) continue;
		seen.add(binding.provider);
		bound.push(binding);
	}
	const available =
		bound.length > 0 ? providers.filter((provider) => provider.id && !seen.has(provider.id)) : [];
	return {
		current: bound[0]?.provider ?? null,
		bound,
		available,
		canUnbind: payload?.canUnbind === true && bound.length > 1
	};
}
