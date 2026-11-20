import { describe, it, expect } from 'vitest';
import { plugin, setup, type RegisteredEndpoint } from './comments-test-utils';

describe('comments plugin manifest', () => {
	it('declares official plugin identity with host engine gate and user-table permission', () => {
		expect(plugin.manifest.name).toBe('comments');
		expect(plugin.manifest.version).toBe('0.1.0');
		expect(plugin.manifest.engines).toEqual({ cms: '^0.1' });
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
			fields: { name: string }[];
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
			'contentOwnerId',
			'status',
			'official',
			'reportReasons'
		]);
		expect(collection.list.columns).toEqual([
			'status',
			'official',
			'authorName',
			'email',
			'content',
			'path',
			'contentId',
			'os',
			'browser',
			'region',
			'likes',
			'reports',
			'reportReasons',
			'createdAt'
		]);
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
		expect(transformed).toEqual({ content: 'hi', authorName: 'Bob', path: '/x' });

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
			filter(
				{ content: 'hi', visitorId: 'abc123' },
				{ collection: 'comments', action: 'create' }
			)
		).toEqual({ content: 'hi', visitorId: 'abc123' });
		// update 补丁不含 visitorId → 绝不注入（覆写会毁既有行的访客归属）
		expect(
			filter({ status: 'approved' }, { collection: 'comments', action: 'update' })
		).toEqual({ status: 'approved' });
		// 缺 action → 不注入（保守：仅明确 create 语义才兜底）
		expect(filter({ content: 'hi' }, { collection: 'comments' })).toEqual({ content: 'hi' });
	});
});
