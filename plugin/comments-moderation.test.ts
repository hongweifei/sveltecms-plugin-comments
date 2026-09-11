import { describe, it, expect } from 'vitest';
import { plugin, BASE, setup, getEndpoint, mockEvent, submitBody } from './comments-test-utils';

describe('comment settings (keyword blacklist)', () => {
	it('returns empty keywords before configuration', async () => {
		const built = await setup();
		const settings = getEndpoint(built, 'GET', '/admin/settings');
		const res = await settings.handler(mockEvent({ method: 'GET', url: `${BASE}/admin/settings` }));
		expect((await res.json()) as { keywords: string[] }).toEqual({ keywords: [] });
	});

	it('saves and reads back the blacklist', async () => {
		const built = await setup();
		const post = getEndpoint(built, 'POST', '/admin/settings');
		const get = getEndpoint(built, 'GET', '/admin/settings');

		const res = await post.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/admin/settings`,
				body: { keywords: '广告, 赌博\n诈骗' },
				user: { id: 'admin-1', name: '站长' }
			})
		);
		expect((await res.json()) as { keywords: string[] }).toEqual({
			keywords: ['广告', '赌博', '诈骗']
		});
		expect(built.dbCreate).toHaveBeenCalledTimes(1);

		const readBack = await get.handler(mockEvent({ method: 'GET', url: `${BASE}/admin/settings` }));
		expect((await readBack.json()) as { keywords: string[] }).toEqual({
			keywords: ['广告', '赌博', '诈骗']
		});

		// 二次保存走 update 而不是再建一行
		await post.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/admin/settings`,
				body: { keywords: '违禁词' },
				user: { id: 'admin-1', name: '站长' }
			})
		);
		expect(built.dbCreate).toHaveBeenCalledTimes(1);
		expect(built.dbUpdate).toHaveBeenCalledTimes(1);
	});
});

describe('评论审核开关（manifest.config moderation）', () => {
	it('manifest 声明 boolean 配置字段，默认开启', () => {
		const field = plugin.manifest.config?.find((f) => f.key === 'moderation');
		expect(field).toBeDefined();
		expect(field?.type).toBe('boolean');
		expect(field?.default).toBe(true);
	});

	it('默认（未配置）→ 新评论进 pending 等审核', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ content: '默认审核', authorName: '小明' })
			})
		);
		const body = (await res.json()) as { comment: { status: string; pending: boolean } };
		expect(body.comment.status).toBe('pending');
		expect(body.comment.pending).toBe(true);
		expect((built.dbCreate.mock.calls.at(-1)?.[1] as Record<string, unknown>).status).toBe(
			'pending'
		);
	});

	it('关闭审核（moderation=false）→ 新评论直接 approved，发布即公开', async () => {
		const built = await setup([], { moderation: 'false' });
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ content: '免审发布', authorName: '小明' })
			})
		);
		const body = (await res.json()) as { comment: { status: string; pending: boolean } };
		expect(body.comment.status).toBe('approved');
		expect(body.comment.pending).toBe(false);
		expect((built.dbCreate.mock.calls.at(-1)?.[1] as Record<string, unknown>).status).toBe(
			'approved'
		);
	});

	it('开启审核（moderation=true，字符串形态）→ 仍进 pending', async () => {
		const built = await setup([], { moderation: 'true' });
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ content: '显式开启', authorName: '小明' })
			})
		);
		const body = (await res.json()) as { comment: { status: string } };
		expect(body.comment.status).toBe('pending');
	});

	it('布尔形态（非字符串）同样识别', async () => {
		const built = await setup([], { moderation: false });
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ content: '布尔关闭', authorName: '小明' })
			})
		);
		const body = (await res.json()) as { comment: { status: string } };
		expect(body.comment.status).toBe('approved');
	});

	it('黑名单命中恒定进 spam，不受审核开关影响', async () => {
		const built = await setup(
			[{ _collection: 'plugin_comments_settings', id: 's-1', key: 'blacklist', value: '赌博' }],
			{ moderation: 'false' }
		);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ content: '欢迎来赌博', authorName: '小明' })
			})
		);
		const body = (await res.json()) as { comment: { status: string } };
		expect(body.comment.status).toBe('spam');
		expect((built.dbCreate.mock.calls.at(-1)?.[1] as Record<string, unknown>).status).toBe('spam');
	});
});

describe('站点级评论开关（纯白名单，站长职责）', () => {
	it('两表皆空 = 全站不开启（fail-safe，装上即静默）', async () => {
		const built = await setup([], { enabledPaths: [], enabledTypes: [] });
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);
		expect(res.status).toBe(403);
	});

	it('白名单路径：列出的放行，未列出的拒绝', async () => {
		const built = await setup([], { enabledPaths: ['/b'] });
		const submit = getEndpoint(built, 'POST', '/submit');
		const denied = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);
		expect(denied.status).toBe(403);
		const allowed = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ path: '/b' }) })
		);
		expect(allowed.status).toBe(200);
	});

	it('类型白名单：contentType 经归属校验后命中 enabledTypes 放行，伪造归属拒绝', async () => {
		const built = await setup(
			[],
			{ enabledTypes: ['posts'] },
			{ findById: async (c, id) => (c === 'posts' && id === 'post-1' ? { id } : null) }
		);
		const submit = getEndpoint(built, 'POST', '/submit');
		const ok = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'post-1', path: null, contentType: 'posts' })
			})
		);
		expect(ok.status).toBe(200);
		// 伪造归属：contentId 在该集合查不到 → 类型按未知处理 → 白名单未命中 → 拒绝
		const forged = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'fake-1', path: null, contentType: 'posts' })
			})
		);
		expect(forged.status).toBe(403);
	});

	it('/list 的 enabled 标志按 contentType 查询参数判定（前端据此隐藏表单）', async () => {
		const built = await setup([], { enabledTypes: ['posts'] });
		const list = getEndpoint(built, 'GET', '/list');
		const on = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?contentId=post-1&contentType=posts` })
		);
		expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
		const off = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?contentId=post-1&contentType=pages` })
		);
		expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);
	});
});
