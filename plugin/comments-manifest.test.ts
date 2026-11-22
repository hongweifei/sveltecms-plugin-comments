import { describe, it, expect } from 'vitest';
import { plugin, setup, type RegisteredEndpoint } from './comments-test-utils';

describe('comments plugin manifest', () => {
	it('declares official plugin identity with host engine gate and user-table permission', () => {
		expect(plugin.manifest.name).toBe('comments');
		expect(plugin.manifest.version).toBe('0.3.5');
		expect(plugin.manifest.engines).toEqual({ cms: '^0.2' });
		// 官方身份：adminAccess 角色 + officialRoles 白名单（角色名手输）
		expect(plugin.manifest.config?.find((c) => c.key === 'officialRoles')).toMatchObject({
			type: 'multiselect',
			allowCustom: true,
			default: []
		});
		// SEC-5 声明式系统表权限（只读）：user 表用于登录用户头像/昵称实时反查
		expect(plugin.manifest.permissions?.readSystemTables).toEqual(['user', 'pages', 'roles']);
		expect(plugin.manifest.permissions?.systemTables).toBeUndefined();
	});
});

describe('comments plugin register wiring', () => {
	it('registers schema, collection, endpoints, slot and filter in shape', async () => {
		const built = await setup();

		expect(built.schemaRegister).toHaveBeenCalledWith('comments', expect.anything());

		expect(built.collectionRegister).toHaveBeenCalledTimes(1);
		const collection = built.collectionRegister.mock.calls[0][0] as {
			slug: string;
			fields: {
				name: string;
				condition?: { field: string; value: unknown };
			}[];
			list: {
				columns: string[];
				searchable: string[];
				sortable: string[];
				batchActions: { action: string; label: string; value: string }[];
			};
		};
		expect(collection.slug).toBe('comments');
		expect(collection.fields.map((f) => f.name)).toEqual([
			'content',
			'authorName',
			'email',
			'website',
			'os',
			'browser',
			'region',
			'path',
			'contentType',
			'contentId',
			'visitorProvider',
			'contentOwnerId',
			'status',
			'official',
			'reportReasons'
		]);
		expect(collection.list.columns).toEqual([
			'status',
			'official',
			'authorName',
			'visitorProvider',
			'email',
			'content',
			'path',
			'contentType',
			'contentId',
			'os',
			'browser',
			'region',
			'likes',
			'reports',
			'reportReasons',
			'createdAt'
		]);

		// 服务端托管字段：设备环境与内容归属恒不进表单；绑定三键在新建时填写，
		// 编辑时隐藏（condition 以「新建尚无 id」为条件）
		const fieldCondition = (name: string) =>
			collection.fields.find((f) => f.name === name)?.condition;
		for (const name of ['os', 'browser', 'region', 'contentOwnerId', 'visitorProvider']) {
			expect(fieldCondition(name)).toEqual({ field: 'id', value: '__never__' });
		}
		for (const name of ['path', 'contentType', 'contentId']) {
			const condition = fieldCondition(name);
			expect(condition?.field).toBe('id');
			expect(condition?.value).toBeUndefined();
		}
		expect(collection.list.searchable).toEqual(['authorName', 'content', 'path']);
		expect(collection.list.batchActions.map((a) => a.value)).toEqual([
			'approved',
			'spam',
			'pending'
		]);

		const endpoints = built.apiRegister.mock.calls.map((call) => call[0] as RegisteredEndpoint);
		expect(endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual(
			[
				'GET /list',
				'GET /count',
				'GET /children',
				'GET /admin/settings',
				'GET /admin/content-settings',
				'GET /admin/eligible',
				'POST /submit',
				'POST /like',
				'POST /report',
				'POST /delete',
				'POST /edit',
				'POST /admin/reply',
				'POST /admin/settings',
				'POST /admin/content-settings',
				'POST /admin/feature'
			].sort()
		);
		const publicEndpoints = endpoints.filter((e) => e.public === true);
		expect(publicEndpoints.map((e) => e.path).sort()).toEqual([
			'/children',
			'/count',
			'/delete',
			'/edit',
			'/like',
			'/list',
			'/report',
			'/submit'
		]);
		expect(
			endpoints
				.filter((e) => !e.public)
				.map((e) => e.path)
				.sort()
		).toEqual([
			'/admin/content-settings',
			'/admin/content-settings',
			'/admin/eligible',
			'/admin/feature',
			'/admin/reply',
			'/admin/settings',
			'/admin/settings'
		]);

		expect(built.slotRegister).toHaveBeenCalledWith(
			'frontend:content-after',
			'components/slot-comments.svelte'
		);
		// C2-1：举报/点赞列可排序（审核工作台动线）；C1-1 待审入口由通知 link 直达
		expect(collection.list.sortable).toEqual(['status', 'likes', 'reports', 'createdAt']);
		// 创作者内容级控制（C1-4 配套）：管理端内容表单插槽
		expect(built.slotRegister).toHaveBeenCalledWith(
			'collection-form-fields-after',
			'components/slot-comment-settings.svelte'
		);
		// 方案 B：后台列表行操作插槽（行内回复入口，集合子名 :comments 限定——
		// 其他集合列表不出「操作」列）
		expect(built.slotRegister).toHaveBeenCalledWith(
			'collection-list-row-actions:comments',
			'components/slot-comment-admin-actions.svelte'
		);
		// 审核工作台工具栏：登录来源筛选（文本列不在通用快捷筛选内）
		expect(built.slotRegister).toHaveBeenCalledWith(
			'collection-list-toolbar-before',
			'components/slot-comment-list-filter.svelte'
		);

		expect(built.filterRegister.mock.calls[0][0]).toBe('content:beforeWrite');
		expect(built.filterRegister.mock.calls[0][2]).toEqual({ priority: 150 });
	});

	it('content:beforeWrite filter trims only comments collection and normalizes path', async () => {
		const built = await setup();
		const filter = built.filterRegister.mock.calls[0][1] as (
			value: unknown,
			fctx: { collection: string }
		) => unknown;

		const transformed = filter(
			{ content: '  hi  ', authorName: ' Bob ', path: '/x/?q=1' },
			{ collection: 'comments' }
		);
		expect(transformed).toEqual({
			content: 'hi',
			authorName: 'Bob',
			path: '/x'
		});

		const untouched = filter({ content: '  hi  ' }, { collection: 'pages' });
		expect(untouched).toEqual({ content: '  hi  ' });

		// 批量审核只发 { status }——不得给 authorName 注入 null 清掉库中昵称
		expect(filter({ status: 'approved' }, { collection: 'comments' })).toEqual({
			status: 'approved'
		});
	});

	it('content:beforeWrite create 兜底 visitorId（后台/API 直建缺此列不再撞 NOT NULL）', async () => {
		const built = await setup();
		const filter = built.filterRegister.mock.calls[0][1] as (
			value: unknown,
			fctx: { collection: string; action?: string }
		) => unknown;

		// create 载荷缺 visitorId（管理表单只渲染声明字段，内部列天然缺失）→ 'admin' 哨兵
		expect(
			filter({ content: 'hi', path: '/x' }, { collection: 'comments', action: 'create' })
		).toEqual({ content: 'hi', path: '/x', visitorId: 'admin' });
		// create 已带 visitorId → 保留，不覆写
		expect(
			filter({ content: 'hi', visitorId: 'abc123' }, { collection: 'comments', action: 'create' })
		).toEqual({ content: 'hi', visitorId: 'abc123' });
		// update 补丁不含 visitorId → 绝不注入（覆写会毁既有行的访客归属）
		expect(filter({ status: 'approved' }, { collection: 'comments', action: 'update' })).toEqual({
			status: 'approved'
		});
		// 缺 action → 不注入（保守：仅明确 create 语义才兜底）
		expect(filter({ content: 'hi' }, { collection: 'comments' })).toEqual({
			content: 'hi'
		});
	});

	it('content:beforeWrite update 丢弃服务端托管字段（表单未渲染不抹库内值）', async () => {
		const built = await setup();
		const filter = built.filterRegister.mock.calls[0][1] as (
			value: unknown,
			fctx: { collection: string; action?: string }
		) => unknown;

		// 编辑表单只渲染可人工维护的字段；框架的表单解析会把未渲染字段按 null
		// 回填——update 前整键移除，绑定、设备环境与内容归属保持原值
		const payload = {
			content: '修订后正文',
			status: 'approved',
			path: null,
			contentType: null,
			contentId: null,
			contentOwnerId: null,
			visitorProvider: null,
			os: null,
			browser: null,
			region: null
		};
		expect(filter(payload, { collection: 'comments', action: 'update' })).toEqual({
			content: '修订后正文',
			status: 'approved'
		});

		// 新建评论时绑定三键仍可填写（落库前归一）
		expect(
			filter(
				{
					content: 'hi',
					path: '/x/?q=1',
					contentId: 'c-1',
					contentType: 'posts'
				},
				{ collection: 'comments', action: 'create' }
			)
		).toEqual({
			content: 'hi',
			path: '/x',
			contentId: 'c-1',
			contentType: 'posts',
			visitorId: 'admin'
		});
	});
});
