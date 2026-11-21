import { describe, it, expect } from 'vitest';
import { BASE, UA, EMAIL, setup, getEndpoint, mockEvent, submitBody, commentRow } from './comments-test-utils';
import { gravatarHash } from './client-info';
import { UAParser } from 'ua-parser-js';
import { runWithRequestContext } from '#lib/common/server/request-context.ts';

describe('POST /submit', () => {
	// 方案 A 写侧：contentId 绑定落库带「服务端反查校验过的」类型判别——
	// 客户端谎报（类型下查无此记录）归 null（任意类型口径），绝不信客户端原值。
	it('contentId 绑定落 contentType（归属校验通过）', async () => {
		const built = await setup(
			[],
			{},
			{ findById: async (c, id) => (c === 'posts' && id === 'post-9' ? { id } : null) }
		);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'post-9', path: null, contentType: 'posts' })
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.contentId).toBe('post-9');
		expect(created.contentType).toBe('posts');
	});

	it('contentId 谎报类型（反查不中）→ 落 null 而非客户端原值', async () => {
		const built = await setup(
			[],
			{},
			{ findById: async () => null }
		);
		const submit = getEndpoint(built, 'POST', '/submit');
		// 双键提交（前端同款载荷）：门禁经 path=/a 命中白名单放行，但落库类型
		// 取 resolve 校验结果——反查不中即 null，绝不落客户端声明的 'posts'
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'ghost-1', path: '/a', contentType: 'posts' })
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.contentId).toBe('ghost-1');
		expect(created.contentType).toBeNull();
	});

	it('path 绑定（无 contentId）→ contentType 落 null', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentType: 'posts' })
			})
		);
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.contentId).toBeNull();
		expect(created.contentType).toBeNull();
	});

	it('honeypot hit returns 204 silently and never persists', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ _hp: 'http://spam' })
			})
		);
		expect(res.status).toBe(204);
		expect(built.dbCreate).not.toHaveBeenCalled();
	});

	it('persists pending comment bound by path and returns it for own visibility', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ content: '你好', authorName: '小明' })
			})
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; comment: { status: string; rootId: null } };
		expect(body.success).toBe(true);
		expect(body.comment.status).toBe('pending');
		expect(body.comment.rootId).toBeNull();

		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.status).toBe('pending');
		expect(created.path).toBe('/a');
		expect(created.contentId).toBeNull();
		expect(created.rootId).toBeNull();
		expect(created.email).toBe(EMAIL);
		expect(created.official).toBe(false);
		expect(typeof created.visitorId).toBe('string');
		// 环境信息：vitest UA 无法识别 → 留空（不臆造）
		expect(created.os).toBeNull();
		expect(created.browser).toBeNull();
		expect(built.eventEmit).toHaveBeenCalledWith(
			'comments:submitted',
			expect.objectContaining({ path: '/a', spam: false })
		);
	});

	it('中文地址栏编码的页面路径按可读原文落库', async () => {
		const built = await setup([], { enabledPaths: ['/article/网络安全'] });
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ path: '/article/%E7%BD%91%E7%BB%9C%E5%AE%89%E5%85%A8' })
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.path).toBe('/article/网络安全');
	});

	it('returns the /list-shaped public projection so local insert matches reload', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ content: '你好', authorName: '小明' })
			})
		);
		const body = (await res.json()) as { comment: Record<string, unknown> };
		const c = body.comment;

		// 与 /list 单条同构：头像由服务端派生。此前 submit 只回传
		// id/createdAt/status/rootId，前端本地组装时 avatar 恒为 null →
		// 「刚发出显示字母色块，刷新后才显示头像」。
		expect(c.avatar).toBe(
			`https://cravatar.cn/avatar/${gravatarHash(EMAIL)}?d=404&s=72`
		);
		expect(c.status).toBe('pending');
		expect(c.pending).toBe(true);
		expect(c.mine).toBe(true);
		expect(c.authorName).toBe('小明');
		// 排序键与 /list 同源，前端据此按同一次序插入（避免刷新后位置跳变）
		expect(c.createdAt).toBe('2026-08-31T00:00:00.000Z');
		// 内部字段不外发
		expect('email' in c).toBe(false);
		expect('visitorId' in c).toBe(false);
		expect('userId' in c).toBe(false);
	});

	it('登录用户提交：头像用 locals.user 实时解析，且不再快照 avatar 列', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				user: { id: 'u-9', name: '站长', image: 'https://cdn.example.com/admin.png' },
				body: { content: '登录发言', path: '/a' }
			})
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { comment: { avatar: string | null; mine: boolean } };
		expect(body.comment.avatar).toBe('https://cdn.example.com/admin.png');
		expect(body.comment.mine).toBe(true);

		// avatar 快照列不再写入（列表时按 user 表实时反查）
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect('avatar' in created).toBe(false);
		expect(created.userId).toBe('u-9');
	});

	it('records os/browser from a real UA string (framework UAParser)', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
				body: submitBody({})
			})
		);
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.os).toBe('Windows 10');
		expect(created.browser).toBe('Edge 126');
		// region 走框架 lookupRegion（ip2region + paraglide 文案），依赖运行时
		// 原生 addon/语言环境，单测不断言文本——由 dev server 端到端验证
		expect('region' in created).toBe(true);
	});

	it('Client Hints 平台版本区分 Windows 11/10（UA 串冻结在 NT 10.0）', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const submitOnce = () =>
			submit.handler(
				mockEvent({
					method: 'POST',
					url: `${BASE}/submit`,
					body: submitBody({ content: 'win 判定', path: '/a' })
				})
			);

		// Win11：platform-version 主版本 ≥13（框架 parseOS 原样输出，含版本段）
		await runWithRequestContext(
			{ ip: '127.0.0.1', ua: 'vitest', chPlatform: 'Windows', chPlatformVersion: '13.0.0' },
			submitOnce
		);
		const win11 = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(win11.os).toBe('Windows 11 13.0');

		// Win10：主版本 ≤1
		await runWithRequestContext(
			{ ip: '127.0.0.1', ua: 'vitest', chPlatform: 'Windows', chPlatformVersion: '1.0.0' },
			submitOnce
		);
		const win10 = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(win10.os).toBe('Windows 10 1.0');
	});

	it('requires and validates email, normalizes website', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		const noEmail = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: { content: 'hi', path: '/a' } })
		);
		expect(noEmail.status).toBe(400);
		const noEmailBody = (await noEmail.json()) as { fieldErrors: Record<string, string> };
		expect(noEmailBody.fieldErrors.email).toBe('required');

		const badEmail = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ email: 'not-an-email' }) })
		);
		expect(badEmail.status).toBe(400);
		const badEmailBody = (await badEmail.json()) as { fieldErrors: Record<string, string> };
		expect(badEmailBody.fieldErrors.email).toBe('invalid');

		const badSite = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ website: 'ftp://x' }) })
		);
		expect(badSite.status).toBe(400);
		const badSiteBody = (await badSite.json()) as { fieldErrors: Record<string, string> };
		expect(badSiteBody.fieldErrors.website).toBe('invalid');

		const ok = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ website: 'example.com/blog' }) })
		);
		expect(ok.status).toBe(200);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.website).toBe('https://example.com/blog');
	});

	it('accepts contentId-only binding (headless)', async () => {
		const built = await setup(
			[],
			{},
			{ findById: async (c, id) => (c === 'posts' && id === 'content-1' ? { id } : null) }
		);
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'content-1', path: undefined, contentType: 'posts' })
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.contentId).toBe('content-1');
		expect(created.path).toBeNull();
	});

	it('rejects when neither path nor contentId provided', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: { content: 'hi', email: EMAIL } })
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { fieldErrors: Record<string, string> };
		expect(body.fieldErrors.binding).toBeDefined();
	});

	it('locks rootId to the thread root for arbitrarily deep replies', async () => {
		const built = await setup([
			commentRow({ id: 'root-1', path: '/a' }),
			commentRow({ id: 'child-1', path: '/a', parentId: 'root-1', rootId: 'root-1' })
		]);
		const submit = getEndpoint(built, 'POST', '/submit');

		// 回复根评论 → rootId = 根 id
		const toRoot = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ parentId: 'root-1' }) })
		);
		expect(toRoot.status).toBe(200);
		const first = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(first.parentId).toBe('root-1');
		expect(first.rootId).toBe('root-1');

		// 回复「回复的回复」→ rootId 仍锁定根评论（无限嵌套只挂同一根）
		const toChild = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ parentId: 'child-1' }) })
		);
		expect(toChild.status).toBe(200);
		const second = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(second.parentId).toBe('child-1');
		expect(second.rootId).toBe('root-1');
	});

	it('silently marks blacklist hits as spam while responding success', async () => {
		const built = await setup([
			{ _collection: 'plugin_comments_settings', id: 's-1', key: 'blacklist', value: '赌博, 广告' }
		]);
		const submit = getEndpoint(built, 'POST', '/submit');

		const clean = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ content: '正常内容' }) })
		);
		const hit = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ content: '最好的赌博网站' }) })
		);
		expect((await clean.json()) as { comment: { status: string } }).toBeTruthy();

		const body = (await hit.json()) as { success: boolean; comment: { status: string } };
		expect(body.success).toBe(true);
		expect(body.comment.status).toBe('spam');
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.status).toBe('spam');
		expect(built.eventEmit).toHaveBeenCalledWith(
			'comments:submitted',
			expect.objectContaining({ spam: true })
		);
	});

	it('logged-in user submits with account identity, no email required', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: { content: '登录用户评论', path: '/a' },
				user: { id: 'u-9', name: '宏伟', email: 'weifei@cms.dev' }
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.authorName).toBe('宏伟');
		expect(created.email).toBe('weifei@cms.dev');
		expect(created.userId).toBe('u-9');
		expect(created.website).toBeNull();
	});

	it('rate limits the 6th submit within the window', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');

		for (let i = 0; i < 5; i++) {
			const res = await submit.handler(
				mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ content: `hi ${i}` }) })
			);
			expect(res.status).toBe(200);
		}
		const sixth = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ content: 'hi 6' }) })
		);
		expect(sixth.status).toBe(429);
	});
});

describe('POST /submit 官方标（站方门禁 + 免审）', () => {
	// roles 行：admin 角色 appAccess=true（站方）、user 角色 false（普通登录者）
	const roleRow = (name: string, appAccess: boolean) => ({
		_collection: 'roles',
		name,
		appAccess,
		adminAccess: appAccess,
		permissions: '[]'
	});
	const adminUser = { id: 'u-admin', name: '站长', role: 'admin' };
	const normalUser = { id: 'u-alice', name: 'Alice', role: 'user' };

	it('站方成员勾选 → official:true 且免审直发 approved（即便审核开启）', async () => {
		const built = await setup(
			[roleRow('admin', true), roleRow('user', false)],
			{ moderation: true }
		);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ official: true }),
				user: adminUser
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.official).toBe(true);
		// 免审：status 直接 approved（审核开启也不进 pending）
		expect(created.status).toBe('approved');
	});

	it('非站方即便伪造 official:true → 强制 false、正常走审核', async () => {
		const built = await setup(
			[roleRow('admin', true), roleRow('user', false)],
			{ moderation: true }
		);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ official: true }),
				user: normalUser
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.official).toBe(false);
		expect(created.status).toBe('pending'); // 非站方仍受审核开关约束
	});

	it('游客勾选 official（无登录态）→ false（isStaff 无角色直接拒）', async () => {
		const built = await setup([roleRow('admin', true)]);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ official: true })
			})
		);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.official).toBe(false);
	});

	it('/list 对站方成员回传 canOfficial=true（前端据此显示勾选）', async () => {
		const built = await setup([
			roleRow('admin', true),
			commentRow({ id: 'c1', path: '/a' })
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const asAdmin = await list.handler(
			mockEvent({
				method: 'GET',
				url: `${BASE}/list?path=%2Fa`,
				user: adminUser
			})
		);
		expect(((await asAdmin.json()) as { canOfficial: boolean }).canOfficial).toBe(true);
		const asGuest = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa` })
		);
		expect(((await asGuest.json()) as { canOfficial: boolean }).canOfficial).toBe(false);
	});
});
