/**
 * 评论插件测试 harness（D3：由 comments-plugin.test.ts 单文件拆分而来）。
 *
 * buildContext/setup（内存 db + i18n + 配置桩）与行工厂（commentRow/userRow/submitBody/
 * mockEvent/getEndpoint）跨领域文件共享；文件名不含 .test.ts，vitest 不收集。
 */
import { vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { PluginContext } from '$lib/cms/types/plugin';
import { createMockPluginContext } from '$lib/cms/engines/plugin/test-helpers';
import { computeVisitorId } from '$lib/cms/stats';
import plugin from './plugin';
export { plugin };

export interface RegisteredEndpoint {
	method: string;
	path: string;
	public?: boolean;
	handler: (event: RequestEvent) => Promise<Response>;
}

export const BASE = 'http://localhost:5173/api/v1/plugin/comments';
export const UA = 'vitest';
export const VISITOR = computeVisitorId('127.0.0.1', UA);
export const EMAIL = 'visitor@test.dev';

/** 可变内存存储：find/findById/create/update/delete 全部作用于同一 rows 数组 */
/** 内容引擎 mock：用于集合类型校验（resolveContentType 反查归属）用例 */
export type ContentMock = {
	findById: (collection: string, id: string) => Promise<unknown>;
};

function buildContext(
	seed: Record<string, unknown>[] = [],
	config: Record<string, unknown> = {},
	content?: ContentMock
) {
	const rows = seed.map((r) => ({ ...r }));
	let seq = 1;
	const base = createMockPluginContext();
	// i18n 词表（register 写入 / t 读取），跨 register 与 handler 共享
	const _i18nStore = new Map<string, Record<string, string>>();

	// 递归函数必须显式返回类型（TS7023/7022 自引用推断拒绝）
	const matchFilter = (row: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
		Object.entries(filter).every(([k, v]) => {
			// _$or：任一分支条件全部命中即真（与 provider buildConditions 下推语义一致）
			if (k === '_$or' && Array.isArray(v)) {
				return v.some((part) =>
					matchFilter(row, (part ?? {}) as Record<string, unknown>)
				);
			}
			if (v !== null && typeof v === 'object' && '$op' in (v as object)) {
				const { $op, $val } = v as { $op: string; $val: unknown };
				if ($op === 'in') return ($val as unknown[]).includes(row[k]);
				throw new Error(`mock db: unsupported $op "${$op}"`);
			}
			// provider 对 null 条件按 IS NULL 求值：列缺失（undefined）同样命中
			if (v === null) return row[k] === null || row[k] === undefined;
			return row[k] === v;
		});

	const dbFind = vi.fn(
		async (
			collection: string,
			params: { filter?: Record<string, unknown>; limit?: number; page?: number; sort?: string } = {}
		) => {
			const filter = params.filter ?? {};
			let data = rows.filter((r) => r._collection === collection && matchFilter(r, filter));
			if (params.sort === '-createdAt') {
				data = [...data].sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
			} else if (params.sort === 'createdAt') {
				data = [...data].sort((a, b) => (String(a.createdAt) > String(b.createdAt) ? 1 : -1));
			}
			const limit = params.limit ?? data.length;
			const p = params.page ?? 1;
			const start = (p - 1) * limit;
			return {
				data: data.slice(start, start + limit),
				meta: {
					page: p,
					limit,
					total: data.length,
					totalPages: limit > 0 ? Math.ceil(data.length / limit) : 1
				}
			};
		}
	);
	const dbFindById = vi.fn(
		async (collection: string, id: string) =>
			rows.find((r) => r._collection === collection && r.id === id) ?? null
	);
	const dbCreate = vi.fn(async (collection: string, data: Record<string, unknown>) => {
		const rec = {
			id: `id-${seq++}`,
			createdAt: '2026-08-31T00:00:00.000Z',
			...data,
			_collection: collection
		};
		rows.push(rec);
		return rec;
	});
	const dbUpdate = vi.fn(async (collection: string, id: string, data: Record<string, unknown>) => {
		const rec = rows.find((r) => r._collection === collection && r.id === id);
		if (!rec) throw new Error(`update target missing: ${id}`);
		Object.assign(rec, data);
		return rec;
	});
	const dbDelete = vi.fn(async (collection: string, id: string) => {
		const i = rows.findIndex((r) => r._collection === collection && r.id === id);
		if (i >= 0) rows.splice(i, 1);
	});

	const ctx = {
		...base,
		schema: { register: vi.fn() },
		collection: { register: vi.fn() },
		api: { register: vi.fn() },
		slot: { register: vi.fn() },
		filters: { register: vi.fn() },
		event: { on: vi.fn(), emit: vi.fn() },
		content,
		logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
		// 插件配置（审核开关等）：管理端以字符串落库，测试按传入值原样返回
		config: {
			get: <T = unknown>(key: string, defaultValue?: T): T =>
				(key in config ? (config[key] as T) : (defaultValue as T)),
			getAll: (): Record<string, unknown> => ({ ...config }),
			set: vi.fn()
		},
		// i18n：仿框架——register 收插件消息，t 自动补 comments_ 前缀按 zh 取词
		// （缺 zh 回退 key）。让 C4「服务端文案走 i18n」的断言仍按中文语义校验，
		// 同时验证这些 key 确实存在于 i18n.ts（漏注册会退回裸 key → 断言失败）。
		i18n: {
			register(name: string, msgs: Record<string, Record<string, string>>) {
				for (const [k, locs] of Object.entries(msgs)) _i18nStore.set(`${name}_${k}`, locs);
			},
			t(key: string) {
				const full = key.startsWith('comments_') ? key : `comments_${key}`;
				const locs = _i18nStore.get(full);
				return locs?.zh ?? locs?.en ?? key;
			}
		},
		db: {
			...base.db,
			find: dbFind,
			findById: dbFindById,
			create: dbCreate,
			update: dbUpdate,
			delete: dbDelete
		}
	};

	return {
		ctx: ctx as unknown as PluginContext,
		rows,
		apiRegister: ctx.api.register as ReturnType<typeof vi.fn>,
		schemaRegister: ctx.schema.register as ReturnType<typeof vi.fn>,
		collectionRegister: ctx.collection.register as ReturnType<typeof vi.fn>,
		slotRegister: ctx.slot.register as ReturnType<typeof vi.fn>,
		filterRegister: ctx.filters.register as ReturnType<typeof vi.fn>,
		eventEmit: ctx.event.emit as ReturnType<typeof vi.fn>,
		eventOn: ctx.event.on as ReturnType<typeof vi.fn>,
		dbFind,
		dbFindById,
		dbCreate,
		dbUpdate,
		dbDelete
	};
}

export async function setup(
	seed: Record<string, unknown>[] = [],
	config: Record<string, unknown> = {},
	content?: ContentMock
) {
	// 站点级白名单默认放行测试绑定（路径 /a + 类型 posts）；显式传参可覆盖
	// （测试「留空 = 全关」时传 { enabledPaths: [], enabledTypes: [] }）
	const merged = { enabledPaths: ['/a'], enabledTypes: ['posts'], ...config };
	// 角色表种子：管理端端点的归属校验按角色标志位判定，测试默认超管角色
	const seeded = [...seed, { _collection: 'roles', name: 'admin', appAccess: true, adminAccess: true }];
	const built = buildContext(seeded, merged, content);
	await plugin.register(built.ctx);
	return built;
}

export function getEndpoint(built: Awaited<ReturnType<typeof setup>>, method: string, path: string) {
	const endpoints = built.apiRegister.mock.calls.map((call) => call[0] as RegisteredEndpoint);
	const ep = endpoints.find((e) => e.method === method && e.path === path);
	if (!ep) throw new Error(`endpoint not registered: ${method} ${path}`);
	return ep;
}

export function mockEvent(opts: {
	method: string;
	url: string;
	body?: unknown;
	user?: { id: string; name: string; image?: string; email?: string; role?: string } | null;
	ua?: string;
}): RequestEvent {
	const request = new Request(opts.url, {
		method: opts.method,
		headers: { 'user-agent': opts.ua ?? UA },
		body: opts.method === 'GET' ? undefined : JSON.stringify(opts.body ?? {})
	});
	// 管理端端点按角色校验归属：测试默认以超管身份调用（opts.user 显式给出角色时以其为准）
	const isAdminPath = opts.url.includes('/admin/');
	const actor = opts.user ?? (isAdminPath ? { id: 'admin-1', name: '站长' } : null);
	const user = actor && isAdminPath ? { role: 'admin', ...actor } : actor;
	return {
		request,
		url: new URL(opts.url),
		getClientAddress: () => '127.0.0.1',
		locals: { user: user ?? undefined }
	} as unknown as RequestEvent;
}

/** v3 提交载荷：email 必填，此处统一注入合法默认值 */
export function submitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { content: 'hello', path: '/a', email: EMAIL, ...overrides };
}

export function commentRow(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		_collection: 'comments',
		id: `c-${Math.random().toString(36).slice(2, 8)}`,
		content: 'hello',
		authorName: null,
		email: null,
		website: null,
		userId: null,
		status: 'approved',
		path: '/a',
		contentId: null,
		// 默认空类型 = 历史行语义（读过滤经 _$or 匹配任意声明类型）
		contentType: null,
		parentId: null,
		rootId: null,
		official: false,
		likes: 0,
		reports: 0,
		os: null,
		browser: null,
		region: null,
		createdAt: '2026-08-31T00:00:00.000Z',
		visitorId: 'someone-else',
		...overrides
	};
}

export function userRow(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		_collection: 'user',
		id: 'u-1',
		name: 'User',
		email: 'u@example.com',
		image: null,
		...overrides
	};
}

