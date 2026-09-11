import { describe, it, expect, vi } from 'vitest';
import { BASE, VISITOR, setup, getEndpoint, mockEvent, submitBody, commentRow } from './comments-test-utils';

describe('C1-2 回复邮件通知', () => {
	it('免审直发回复已审核父评论且开关开启 → 即时 sendTemplate 到父作者邮箱', async () => {
		const parent = commentRow({
			id: 'parent-1',
			path: '/a',
			status: 'approved',
			email: 'parent@test.dev'
		});
		// A3：moderation 关闭 → 回复直接 approved → 即时发信
		const built = await setup([parent], { notifyReplies: true, moderation: false });
		// mock ctx 的 mail 是裸 async 函数，覆盖为 spy 以断言调用
		built.ctx.mail.sendTemplate = vi.fn(async () => true);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ parentId: 'parent-1' })
			})
		);
		expect(res.status).toBe(200);
		expect(built.ctx.mail.sendTemplate).toHaveBeenCalled();
		const call = (built.ctx.mail.sendTemplate as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as { to: string };
		expect(call.to).toBe('parent@test.dev');
		// 即时发送也置 replyNotified，防后续再审核重复通知
		const sent = built.rows.find((r) => r.parentId === 'parent-1');
		expect(sent?.replyNotified).toBe(true);
	});

	it('A3：审核开启时 pending 回复不发信，审核通过（collection:updated）后补发且幂等', async () => {
		const parent = commentRow({
			id: 'parent-3',
			path: '/a',
			status: 'approved',
			email: 'parent@test.dev',
			visitorId: 'other-visitor'
		});
		const built = await setup([parent], { notifyReplies: true, moderation: true });
		built.ctx.mail.sendTemplate = vi.fn(async () => true);
		// 从注册期 event.on 调用记录取 collection:updated 处理器
		const onUpdated = built.eventOn.mock.calls
			.map((call) =>
				call[0] === 'collection:updated' ? (call[1] as (d: unknown) => unknown) : null
			)
			.find(Boolean);
		expect(onUpdated).toBeTruthy();
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ parentId: 'parent-3' })
			})
		);
		expect(res.status).toBe(200);
		// 待审阶段不发信
		expect(built.ctx.mail.sendTemplate).not.toHaveBeenCalled();
		const reply = built.rows.find((r) => r.parentId === 'parent-3');
		expect(reply?.status).toBe('pending');
		expect(reply?.replyNotified).toBeFalsy();
		// 模拟后台逐行审核通过（内容引擎 update 广播 collection:updated 完整行）
		await onUpdated!({
			slug: 'comments',
			record: { ...reply, status: 'approved', replyNotified: false }
		});
		await new Promise((r) => setImmediate(r));
		expect(built.ctx.mail.sendTemplate).toHaveBeenCalledTimes(1);
		// 补发后 replyNotified 置真
		expect(built.rows.find((r) => r.id === reply?.id)?.replyNotified).toBe(true);
		// 再次 updated（已通知）不重复发
		await onUpdated!({
			slug: 'comments',
			record: { ...reply, status: 'approved', replyNotified: true }
		});
		await new Promise((r) => setImmediate(r));
		expect(built.ctx.mail.sendTemplate).toHaveBeenCalledTimes(1);
	});

	it('A3：非 comments 集合 / 顶层 approved / 无邮箱父 → updated 不触发补发', async () => {
		const parent = commentRow({
			id: 'parent-4',
			path: '/a',
			status: 'approved',
			email: 'parent@test.dev',
			visitorId: 'other-visitor'
		});
		const built = await setup([parent], { notifyReplies: true });
		built.ctx.mail.sendTemplate = vi.fn(async () => true);
		const onUpdated = built.eventOn.mock.calls
			.map((call) =>
				call[0] === 'collection:updated' ? (call[1] as (d: unknown) => unknown) : null
			)
			.find(Boolean);
		// 非 comments 集合
		await onUpdated!({ slug: 'posts', record: { id: 'x', status: 'approved', parentId: 'parent-4' } });
		// 顶层（无 parentId）
		await onUpdated!({ slug: 'comments', record: { id: 'y', status: 'approved' } });
		await new Promise((r) => setImmediate(r));
		expect(built.ctx.mail.sendTemplate).not.toHaveBeenCalled();
	});

	it('开关关闭 / 自己回复自己 → 不发', async () => {
		const parent = commentRow({
			id: 'parent-2',
			path: '/a',
			status: 'approved',
			email: 'parent@test.dev',
			visitorId: VISITOR
		});
		const off = await setup([parent], { notifyReplies: false });
		off.ctx.mail.sendTemplate = vi.fn(async () => true);
		await getEndpoint(off, 'POST', '/submit').handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ parentId: 'parent-2' })
			})
		);
		expect(off.ctx.mail.sendTemplate).not.toHaveBeenCalled();

		// 自己回复自己（同 visitorId）
		const self = await setup([parent], { notifyReplies: true });
		self.ctx.mail.sendTemplate = vi.fn(async () => true);
		await getEndpoint(self, 'POST', '/submit').handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ parentId: 'parent-2' })
			})
		);
		expect(self.ctx.mail.sendTemplate).not.toHaveBeenCalled();
	});
});

describe('C1-1 管理员通知（ctx.notification.notifyAdmins）', () => {
	it('待审提交 → notifyAdmins（标题 + 深链待审快筛）', async () => {
		const built = await setup();
		built.ctx.notification.notifyAdmins = vi.fn(async () => undefined);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);
		expect(res.status).toBe(200);
		expect(built.ctx.notification.notifyAdmins).toHaveBeenCalledTimes(1);
		const opts = (built.ctx.notification.notifyAdmins as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as { title: string; link: string };
		expect(opts.title).toBe('新评论待审核');
		expect(opts.link).toBe('/admin/content/comments?filter_status=pending');
	});

	it('免审直发 / 关键词垃圾 → 不提醒', async () => {
		const free = await setup([], { moderation: false });
		free.ctx.notification.notifyAdmins = vi.fn(async () => undefined);
		await getEndpoint(free, 'POST', '/submit').handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);
		expect(free.ctx.notification.notifyAdmins).not.toHaveBeenCalled();

		const spam = await setup([
			{ _collection: 'plugin_comments_settings', id: 'bs-1', key: 'blacklist', value: '违禁词' }
		]);
		spam.ctx.notification.notifyAdmins = vi.fn(async () => undefined);
		await getEndpoint(spam, 'POST', '/submit').handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody({ content: '含违禁词的评论' }) })
		);
		expect(spam.ctx.notification.notifyAdmins).not.toHaveBeenCalled();
	});
});

describe('内容作者通知（ctx.notification.notifyUser）', () => {
	const authorContent = (userId: string) => ({
		findById: async (c: string, id: string) =>
			c === 'posts' && id === 'post-1' ? { id, userId } : null
	});

	it('评论落在内容项上 → notifyUser 通知内容作者', async () => {
		const built = await setup(
			[],
			{},
			authorContent('author-1')
		);
		built.ctx.notification.notifyUser = vi.fn(async () => true);
		const submit = getEndpoint(built, 'POST', '/submit');
		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'post-1', path: null, contentType: 'posts' })
			})
		);
		expect(res.status).toBe(200);
		expect(built.ctx.notification.notifyUser).toHaveBeenCalledTimes(1);
		const [userId, opts] = (built.ctx.notification.notifyUser as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, { title: string }];
		expect(userId).toBe('author-1');
		expect(opts.title).toBe('你的内容有新评论');
		// 作者标：游客 userId=null ≠ 内容作者 → 投影派生 isAuthor=false
		const body = (await res.clone().json()) as { comment: { isAuthor: boolean } };
		expect(body.comment.isAuthor).toBe(false);
		// 去冗余：isAuthor 不落库（列已删），载荷不得含该字段
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect('isAuthor' in created).toBe(false);
	});

	it('作者本人评论自己的内容 → 不通知，且投影派生 isAuthor=true', async () => {
		const built = await setup([], {}, authorContent('u-1'));
		built.ctx.notification.notifyUser = vi.fn(async () => true);
		const res = await getEndpoint(built, 'POST', '/submit').handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'post-1', path: null, contentType: 'posts', email: undefined }),
				user: { id: 'u-1', name: '作者' }
			})
		);
		expect(built.ctx.notification.notifyUser).not.toHaveBeenCalled();
		// 作者标：登录 userId === 内容作者 → 投影即时派生（非落库），游客/非作者为 false
		const body = (await res.json()) as { comment: { isAuthor: boolean } };
		expect(body.comment.isAuthor).toBe(true);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect('isAuthor' in created).toBe(false);
	});

	it('开关关闭 / 纯路径绑定 / 关键词垃圾 → 不通知', async () => {
		const off = await setup([], { notifyAuthor: false }, authorContent('author-1'));
		off.ctx.notification.notifyUser = vi.fn(async () => true);
		await getEndpoint(off, 'POST', '/submit').handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'post-1', path: null, contentType: 'posts' })
			})
		);
		expect(off.ctx.notification.notifyUser).not.toHaveBeenCalled();

		const byPath = await setup([], {}, authorContent('author-1'));
		byPath.ctx.notification.notifyUser = vi.fn(async () => true);
		await getEndpoint(byPath, 'POST', '/submit').handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);
		expect(byPath.ctx.notification.notifyUser).not.toHaveBeenCalled();

		const spam = await setup(
			[{ _collection: 'plugin_comments_settings', id: 'bs-2', key: 'blacklist', value: '违禁词' }],
			{},
			authorContent('author-1')
		);
		spam.ctx.notification.notifyUser = vi.fn(async () => true);
		await getEndpoint(spam, 'POST', '/submit').handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ contentId: 'post-1', path: null, contentType: 'posts', content: '含违禁词的评论' })
			})
		);
		expect(spam.ctx.notification.notifyUser).not.toHaveBeenCalled();
	});
});
