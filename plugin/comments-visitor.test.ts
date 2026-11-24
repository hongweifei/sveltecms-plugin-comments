import { describe, it, expect } from 'vitest';
import { setup, getEndpoint, mockEvent, submitBody, commentRow, VISITOR, BASE, EMAIL } from './comments-test-utils';

/**
 * 框架 0.3 统一访客适配：
 * - 匿名访客（locals.visitor 只有 id）仍按游客处理，身份三字段照常消费；
 * - 社交访客（带 provider）昵称/头像由框架签名 cookie 认定，邮箱不落；
 * - visitor_id 列统一用框架访客 id（无 cookie 的直连请求用一次性随机标识）；
 * - 隐私主体登记按同一 id 导出/删除本人数据。
 */
describe('统一访客身份', () => {
	it('匿名访客提交：昵称/邮箱照常落库，visitor_id 用框架访客 id', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ authorName: '匿名访客', content: '你好' })
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.authorName).toBe('匿名访客');
		expect(created.email).toBe(EMAIL);
		expect(created.visitorId).toBe(VISITOR);
		expect(created.visitorProvider).toBeNull();
	});

	it('社交访客提交：昵称/提供方来自框架身份，邮箱不落、客户端身份字段被忽略', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ authorName: '冒名', email: 'fake@example.com' }),
				visitor: {
					provider: 'wechat',
					subject: 'union-1',
					openid: 'openid-1',
					nickname: '微信用户'
				}
			})
		);
		expect(res.status).toBe(200);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.authorName).toBe('微信用户');
		expect(created.email).toBeNull();
		expect(created.visitorProvider).toBe('wechat');
		expect(created.visitorId).toBe(VISITOR);
	});

	it('无访客 cookie（headless 直连）：用一次性随机标识，依旧可评论', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody(),
				visitor: null
			})
		);
		expect(res.status).toBe(200);
		const first = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(String(first.visitorId)).toMatch(/^[0-9a-f-]{36}$/);
		expect(first.visitorId).not.toBe(VISITOR);

		// 无 cookie 的两次请求互不归人（不做跨请求身份推断）
		await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody(),
				visitor: null
			})
		);
		const second = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(second.visitorId).not.toBe(first.visitorId);
	});

	it('/list：匿名访客回传身份记忆与本人待审，社交访客不回传', async () => {
		const built = await setup([
			commentRow({ id: 'pending-mine', status: 'pending', path: '/a', visitorId: VISITOR })
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const anon = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa` })
		);
		const anonBody = (await anon.json()) as {
			data: { id: string }[];
			remembered?: unknown;
		};
		expect(anonBody.data.map((c) => c.id)).toContain('pending-mine');

		const social = await list.handler(
			mockEvent({
				method: 'GET',
				url: `${BASE}/list?path=%2Fa`,
				visitor: { provider: 'qq', subject: 's', openid: 'o', nickname: 'QQ 用户' }
			})
		);
		const socialBody = (await social.json()) as { remembered?: unknown };
		expect(socialBody.remembered).toBeUndefined();
	});

	it('隐私主体：按统一访客 id 导出本人评论与点赞', async () => {
		const built = await setup([
			commentRow({ id: 'c1', content: '我的评论', path: '/a', visitorId: VISITOR }),
			commentRow({ id: 'c2', content: '别人的评论', path: '/a', visitorId: 'other' }),
			{
				_collection: 'plugin_comments_likes',
				id: 'lk1',
				commentId: 'c2',
				userId: null,
				visitorId: VISITOR
			}
		]);
		const subject = built.privacySubjects.get('comments');
		expect(subject).toBeTruthy();
		const exported = (await subject!.export(VISITOR)) as {
			comments: { content: string }[];
			likes: { commentId: string }[];
		};
		expect(exported.comments.map((c) => c.content)).toEqual(['我的评论']);
		expect(exported.likes.map((l) => l.commentId)).toEqual(['c2']);
	});

	it('隐私主体：删除本人评论（顶层线程级联、回复保留他人子回复）与点赞', async () => {
		const built = await setup([
			// 本人发起的线程：根 + 他人回复 → 一并删除
			commentRow({ id: 'root', visitorId: VISITOR }),
			commentRow({ id: 'reply-by-other', parentId: 'root', rootId: 'root', visitorId: 'other' }),
			// 他人线程里本人的回复：删本人回复，他人子回复改挂其父
			commentRow({ id: 'other-root', visitorId: 'other' }),
			commentRow({ id: 'my-reply', parentId: 'other-root', rootId: 'other-root', visitorId: VISITOR }),
			commentRow({
				id: 'child-of-my-reply',
				parentId: 'my-reply',
				rootId: 'other-root',
				visitorId: 'other'
			}),
			// 点赞：本人的赞 + 他人给本人评论的赞
			{ _collection: 'plugin_comments_likes', id: 'lk-my', commentId: 'other-root', userId: null, visitorId: VISITOR },
			{ _collection: 'plugin_comments_likes', id: 'lk-on-root', commentId: 'root', userId: null, visitorId: 'other' }
		]);

		const removed = await built.privacySubjects.get('comments')!.erase(VISITOR);
		expect(removed).toBeGreaterThan(0);

		const ids = built.rows.filter((r) => r._collection === 'comments').map((r) => r.id);
		expect(ids).not.toContain('root');
		expect(ids).not.toContain('reply-by-other');
		expect(ids).not.toContain('my-reply');
		// 他人线程保留，他人子回复改挂到 other-root
		expect(ids).toContain('other-root');
		expect(ids).toContain('child-of-my-reply');
		expect(built.rows.find((r) => r.id === 'child-of-my-reply')?.parentId).toBe('other-root');
		// 点赞：本人的赞清掉，本人评论上的赞随评论删除
		const likes = built.rows.filter((r) => r._collection === 'plugin_comments_likes').map((r) => r.id);
		expect(likes).toEqual([]);
	});
});
