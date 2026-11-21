import { describe, it, expect } from 'vitest';
import { BASE, setup, getEndpoint, mockEvent, submitBody, commentRow, type ContentMock } from './comments-test-utils';

describe('内容级设置与精选评论（创作者控制，公众号模式）', () => {
	// 内容级测试默认绑定 contentId=post-1 且声明类型 posts（经白名单，聚焦内容级行为）
	const postContent: ContentMock = {
		findById: async (c, id) => (c === 'posts' && id === 'post-1' ? { id } : null)
	};
	const postBody = (overrides: Record<string, unknown> = {}) =>
		submitBody({ contentId: 'post-1', path: null, contentType: 'posts', ...overrides });

	const csRow = (overrides: Record<string, unknown>) => ({
		_collection: 'plugin_comments_content_settings',
		id: 'cs-1',
		contentId: 'post-1',
		closed: false,
		requireLogin: false,
		featuredOnly: false,
		...overrides
	});

	it('closed：该内容评论关闭 → 403', async () => {
		const built = await setup([csRow({ closed: true })], {}, postContent);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: postBody() })
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe('Comments are closed here');
	});

	it('requireLogin：未登录拒绝，登录放行', async () => {
		const built = await setup([csRow({ requireLogin: true })], {}, postContent);
		const submit = getEndpoint(built, 'POST', '/submit');
		const guest = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: postBody() })
		);
		expect(guest.status).toBe(403);
		const signed = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: postBody({ email: undefined }),
				user: { id: 'u-1', name: '宏伟' }
			})
		);
		expect(signed.status).toBe(200);
	});

	it('/admin/content-settings GET/POST：部分更新，未提及的开关不动', async () => {
		const built = await setup();
		const get = getEndpoint(built, 'GET', '/admin/content-settings');
		const post = getEndpoint(built, 'POST', '/admin/content-settings');
		const initial = await get.handler(
			mockEvent({ method: 'GET', url: `${BASE}/admin/content-settings?contentId=post-1` })
		);
		expect(await initial.json()).toEqual({
			contentId: 'post-1',
			closed: false,
			requireLogin: false,
			featuredOnly: false
		});
		const saved = await post.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/admin/content-settings`,
				body: { contentId: 'post-1', featuredOnly: true }
			})
		);
		expect(await saved.json()).toEqual({
			contentId: 'post-1',
			closed: false,
			requireLogin: false,
			featuredOnly: true
		});
	});

	it('/admin/feature：缺省取反，显式传值按传值', async () => {
		const built = await setup([commentRow({ id: 'c-1', featured: false })]);
		const feature = getEndpoint(built, 'POST', '/admin/feature');
		const on = await feature.handler(
			mockEvent({ method: 'POST', url: `${BASE}/admin/feature`, body: { id: 'c-1' } })
		);
		expect(await on.json()).toEqual({ id: 'c-1', featured: true });
		const off = await feature.handler(
			mockEvent({ method: 'POST', url: `${BASE}/admin/feature`, body: { id: 'c-1', featured: false } })
		);
		expect(await off.json()).toEqual({ id: 'c-1', featured: false });
	});

	it('/admin/eligible：类型命中 enabledTypes → 该集合可配置内容级设置', async () => {
		// setup 默认 merged 含 enabledPaths，显式覆盖为仅类型白名单
		const built = await setup([], { enabledPaths: [], enabledTypes: ['posts'] });
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const on = await eligible.handler(
			mockEvent({ method: 'GET', url: `${BASE}/admin/eligible?contentType=posts` })
		);
		expect(await on.json()).toEqual({ eligible: true });
		const off = await eligible.handler(
			mockEvent({ method: 'GET', url: `${BASE}/admin/eligible?contentType=pages` })
		);
		expect(await off.json()).toEqual({ eligible: false });
	});

	it('/admin/eligible：两表皆空（全站未开）→ 任何类型都不可配置', async () => {
		const built = await setup([], { enabledPaths: [], enabledTypes: [] });
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const res = await eligible.handler(
			mockEvent({ method: 'GET', url: `${BASE}/admin/eligible?contentType=posts` })
		);
		expect(await res.json()).toEqual({ eligible: false });
	});

	it('/admin/eligible：仅路径白名单但类型未命中 enabledTypes → 不可配置（路径评论不消费内容级设置）', async () => {
		// 首页 / 走 path 白名单时，编辑任意内容都不该冒出无效的三开关
		const built = await setup([], { enabledPaths: ['/'], enabledTypes: [] });
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const res = await eligible.handler(
			mockEvent({ method: 'GET', url: `${BASE}/admin/eligible?contentType=pages` })
		);
		expect(await res.json()).toEqual({ eligible: false });
	});

	it('/admin/eligible：类型命中即 true（即便无路径白名单）', async () => {
		const built = await setup([], { enabledPaths: [], enabledTypes: ['pages'] });
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const res = await eligible.handler(
			mockEvent({ method: 'GET', url: `${BASE}/admin/eligible?contentType=pages` })
		);
		expect(await res.json()).toEqual({ eligible: true });
	});

	it('/admin/eligible：缺 contentType（无集合上下文）→ 不可配置', async () => {
		const built = await setup();
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const res = await eligible.handler(
			mockEvent({ method: 'GET', url: `${BASE}/admin/eligible` })
		);
		expect(await res.json()).toEqual({ eligible: false });
	});

	// ─── 路径白名单 ↔ pages 记录桥（用户诉求：配了 /enterprise 就该能设且生效）───
	// pages 行：enterprise（顶级）；内容级设置 contentId 用该记录 id
	const pageRow = (over: Record<string, unknown> = {}) => ({
		_collection: 'pages',
		id: 'page-ent',
		slug: 'enterprise',
		parentId: null,
		...over
	});
	const entCs = (over: Record<string, unknown> = {}) => ({
		_collection: 'plugin_comments_content_settings',
		id: 'cs-ent',
		contentId: 'page-ent', // 桥把 path '/enterprise' 解析到这条记录
		closed: false,
		requireLogin: false,
		featuredOnly: false,
		...over
	});

	it('eligible：pages 记录公共路径命中 enabledPaths → 可配置（即便类型未命中）', async () => {
		const built = await setup([pageRow()], {
			enabledPaths: ['/enterprise'],
			enabledTypes: []
		});
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const res = await eligible.handler(
			mockEvent({
				method: 'GET',
				url: `${BASE}/admin/eligible?contentType=pages&recordId=page-ent`
			})
		);
		expect(await res.json()).toEqual({ eligible: true });
	});

	it('eligible：pages 记录路径未命中 enabledPaths → 不可配置', async () => {
		const built = await setup([pageRow()], {
			enabledPaths: ['/other'],
			enabledTypes: []
		});
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const res = await eligible.handler(
			mockEvent({
				method: 'GET',
				url: `${BASE}/admin/eligible?contentType=pages&recordId=page-ent`
			})
		);
		expect(await res.json()).toEqual({ eligible: false });
	});

	it('eligible：中文路径白名单与 pages 中文 slug 命中同一条记录', async () => {
		const built = await setup([pageRow({ id: 'page-cn', slug: '关于我们' })], {
			enabledPaths: ['/关于我们'],
			enabledTypes: []
		});
		const eligible = getEndpoint(built, 'GET', '/admin/eligible');
		const res = await eligible.handler(
			mockEvent({
				method: 'GET',
				url: `${BASE}/admin/eligible?contentType=pages&recordId=page-cn`
			})
		);
		expect(await res.json()).toEqual({ eligible: true });
	});

	it('/submit：path 提交命中路径白名单 + 该页记录设了 closed → 403（配了即生效）', async () => {
		const built = await setup([pageRow(), entCs({ closed: true })], {
			enabledPaths: ['/enterprise'],
			enabledTypes: []
		});
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ path: '/enterprise', contentType: 'pages' })
			})
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe('Comments are closed here');
	});

	it('/list：path 绑定经桥解析该页 featuredOnly → 只回精选（与内容级设置一致）', async () => {
		const built = await setup(
			[
				pageRow(),
				entCs({ featuredOnly: true }),
				commentRow({ id: 'feat', path: '/enterprise', contentId: null, featured: true }),
				commentRow({ id: 'plain', path: '/enterprise', contentId: null, featured: false })
			],
			{ enabledPaths: ['/enterprise'], enabledTypes: [] }
		);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fenterprise` })
		);
		const body = (await res.json()) as { data: { id: string }[]; contentSettings: unknown };
		expect(body.data.map((c) => c.id)).toEqual(['feat']);
		// path 绑定也回传内容级设置（桥命中）
		expect(body.contentSettings).toMatchObject({ featuredOnly: true });
	});

	it('featuredOnly 内容的公开列表只回精选评论', async () => {
		const built = await setup([
			commentRow({ id: 'feat-1', contentId: 'post-9', path: null, featured: true }),
			commentRow({ id: 'plain-1', contentId: 'post-9', path: null, featured: false }),
			csRow({ id: 'cs-9', contentId: 'post-9', featuredOnly: true })
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?contentId=post-9` })
		);
		const body = (await res.json()) as { data: { id: string }[] };
		expect(body.data.map((c) => c.id)).toEqual(['feat-1']);
	});

	it('A1：featuredOnly 内容的 /count 与公开列表同口径（只计精选）', async () => {
		const built = await setup([
			commentRow({ id: 'feat-1', contentId: 'post-8', path: null, featured: true }),
			commentRow({ id: 'feat-2', contentId: 'post-8', path: null, featured: true }),
			commentRow({ id: 'plain-1', contentId: 'post-8', path: null, featured: false }),
			commentRow({ id: 'spam-1', contentId: 'post-8', path: null, featured: true, status: 'spam' }),
			csRow({ id: 'cs-8', contentId: 'post-8', featuredOnly: true })
		]);
		const count = getEndpoint(built, 'GET', '/count');
		const res = await count.handler(
			mockEvent({ method: 'GET', url: `${BASE}/count?contentId=post-8` })
		);
		// 精选 2 条；非精选与 spam 不计——与列表可见数一致
		expect(((await res.json()) as { count: number }).count).toBe(2);
	});

	it('A1：未开 featuredOnly 时 /count 维持全量已审口径（回归）', async () => {
		const built = await setup([
			commentRow({ id: 'feat-1', contentId: 'post-7', path: null, featured: true }),
			commentRow({ id: 'plain-1', contentId: 'post-7', path: null, featured: false }),
			commentRow({ id: 'spam-1', contentId: 'post-7', path: null, status: 'spam' }),
			csRow({ id: 'cs-7', contentId: 'post-7' })
		]);
		const count = getEndpoint(built, 'GET', '/count');
		const res = await count.handler(
			mockEvent({ method: 'GET', url: `${BASE}/count?contentId=post-7` })
		);
		expect(((await res.json()) as { count: number }).count).toBe(2);
	});
});

describe('C1-4 内容级设置进 /list', () => {
	it('contentId 绑定回传 contentSettings，path 绑定为 null', async () => {
		const built = await setup([
			{
				_collection: 'plugin_comments_content_settings',
				id: 'cs-1',
				contentId: 'post-1',
				closed: true,
				requireLogin: true,
				featuredOnly: false
			}
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const byContent = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?contentId=post-1` })
		);
		const body = (await byContent.json()) as {
			contentSettings: { closed: boolean; requireLogin: boolean } | null;
		};
		expect(body.contentSettings).toEqual({ closed: true, requireLogin: true, featuredOnly: false });

		const byPath = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=/a` }));
		expect(((await byPath.json()) as { contentSettings: unknown }).contentSettings).toBeNull();
	});
});

describe('C1-3 CAPTCHA 接入', () => {
	it('框架启用 forms 作用域时 /submit 校验失败 → 403 Captcha', async () => {
		const built = await setup();
		built.ctx.captcha.checkScope = async () => false;
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toContain('Captcha');
		// 未落库
		expect(built.dbCreate).not.toHaveBeenCalled();
	});

	it('未启用时 checkScope 放行（mock 默认）', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);
		expect(res.status).toBe(200);
	});

	it('/list 回传 captchaRequired（settings.enabled && requireForms）', async () => {
		const built = await setup();
		const list = getEndpoint(built, 'GET', '/list');
		const off = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=/a` })
		);
		expect(((await off.json()) as { captchaRequired: boolean }).captchaRequired).toBe(false);

		built.ctx.captcha.settings = async () => ({
			enabled: true,
			requireForms: true,
			requireAuth: true
		});
		const on = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=/a` }));
		expect(((await on.json()) as { captchaRequired: boolean }).captchaRequired).toBe(true);
	});
});
