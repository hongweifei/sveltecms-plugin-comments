import { describe, it, expect } from 'vitest';
import { BASE, VISITOR, setup, getEndpoint, mockEvent, commentRow } from './comments-test-utils';

describe('POST /like', () => {
	it('游客点赞 toggle：赞→取消→再赞，计数 +1/回0/+1 且记录随之增删', async () => {
		const built = await setup([commentRow({ id: 'c1', path: '/a', likes: 0 })]);
		const like = getEndpoint(built, 'POST', '/like');

		const first = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' } })
		);
		expect((await first.json()) as { likes: number }).toEqual({ liked: true, likes: 1 });

		// 第二次 = 取消赞：liked:false、计数回 0、点赞记录删除
		const second = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' } })
		);
		expect((await second.json()) as { likes: number }).toEqual({ liked: false, likes: 0 });
		expect(built.rows.filter((r) => r._collection === 'plugin_comments_likes')).toHaveLength(0);

		// 第三次 = 再赞
		const third = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' } })
		);
		expect((await third.json()) as { likes: number }).toEqual({ liked: true, likes: 1 });
	});

	it('取消赞不会把计数减成负数（并发/脏数据下限 0）', async () => {
		// likes 存证为 0 但存在点赞记录（模拟并发取消）→ 取消后仍为 0
		const built = await setup([
			commentRow({ id: 'c1', path: '/a', likes: 0 }),
			{ id: 'lk-1', _collection: 'plugin_comments_likes', commentId: 'c1', userId: null, visitorId: VISITOR }
		]);
		const like = getEndpoint(built, 'POST', '/like');
		const res = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' } })
		);
		expect((await res.json()) as { likes: number }).toEqual({ liked: false, likes: 0 });
	});

	it('404s for missing or unapproved comments', async () => {
		const built = await setup([commentRow({ id: 'pending', status: 'pending', path: '/a' })]);
		const like = getEndpoint(built, 'POST', '/like');

		const missing = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'nope' } })
		);
		expect(missing.status).toBe(404);

		const unapproved = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'pending' } })
		);
		expect(unapproved.status).toBe(404);
	});

	it('B1：登录用户点赞按 userId 去重（toggle 键为 userId，不因 visitorId 漂移）', async () => {
		const built = await setup([commentRow({ id: 'c1', path: '/a', likes: 0 })]);
		const like = getEndpoint(built, 'POST', '/like');
		const user = { id: 'u-9', name: 'Zed' };
		const first = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' }, user })
		);
		expect((await first.json()) as { likes: number }).toEqual({ liked: true, likes: 1 });
		// 点赞记录按 userId 落库（登录态），非 visitorId
		const likeRow = built.rows.find((r) => r._collection === 'plugin_comments_likes');
		expect(likeRow?.userId).toBe('u-9');
		// 二次点击 = 取消（toggle 语义），删除的是 userId 键那条记录
		const second = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' }, user })
		);
		expect((await second.json()) as { likes: number }).toEqual({ liked: false, likes: 0 });
		expect(built.rows.filter((r) => r._collection === 'plugin_comments_likes')).toHaveLength(0);
	});

	it('B1：另一登录用户独立点赞各自计数（userId 维度幂等互不影响）', async () => {
		const built = await setup([commentRow({ id: 'c1', path: '/a', likes: 0 })]);
		const like = getEndpoint(built, 'POST', '/like');
		await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' }, user: { id: 'u-A', name: 'A' } })
		);
		const b = await like.handler(
			mockEvent({ method: 'POST', url: `${BASE}/like`, body: { id: 'c1' }, user: { id: 'u-B', name: 'B' } })
		);
		expect((await b.json()) as { likes: number }).toEqual({ liked: true, likes: 2 });
	});
});

describe('POST /report', () => {
	it('increments reports and auto-pends at threshold', async () => {
		const built = await setup([
			commentRow({ id: 'low', path: '/a', reports: 0 }),
			commentRow({ id: 'edge', path: '/a', reports: 2 })
		]);
		const report = getEndpoint(built, 'POST', '/report');

		const first = await report.handler(
			mockEvent({ method: 'POST', url: `${BASE}/report`, body: { id: 'low' } })
		);
		const firstBody = (await first.json()) as { reports: number; status: string };
		expect(firstBody).toEqual({ reports: 1, status: 'approved' });

		const second = await report.handler(
			mockEvent({ method: 'POST', url: `${BASE}/report`, body: { id: 'edge' } })
		);
		const secondBody = (await second.json()) as { reports: number; status: string };
		expect(secondBody).toEqual({ reports: 3, status: 'pending' });
		expect(built.dbUpdate).toHaveBeenCalledWith('comments', 'edge', {
			reports: 3,
			status: 'pending'
		});
	});

	it('404s for spam comments', async () => {
		const built = await setup([commentRow({ id: 'spam', status: 'spam', path: '/a' })]);
		const report = getEndpoint(built, 'POST', '/report');
		const res = await report.handler(
			mockEvent({ method: 'POST', url: `${BASE}/report`, body: { id: 'spam' } })
		);
		expect(res.status).toBe(404);
	});
});

describe('POST /delete', () => {
	it('allows visitors to withdraw their own pending comment', async () => {
		const built = await setup([
			commentRow({ id: 'mine-pending', status: 'pending', path: '/a', visitorId: VISITOR })
		]);
		const del = getEndpoint(built, 'POST', '/delete');
		const res = await del.handler(
			mockEvent({ method: 'POST', url: `${BASE}/delete`, body: { id: 'mine-pending' } })
		);
		expect(res.status).toBe(200);
		expect(built.dbDelete).toHaveBeenCalledWith('comments', 'mine-pending');
	});

	it('forbids visitors deleting others comments or own approved comments', async () => {
		const built = await setup([
			commentRow({ id: 'other-pending', status: 'pending', path: '/a' }),
			commentRow({ id: 'my-approved', status: 'approved', path: '/a', visitorId: VISITOR })
		]);
		const del = getEndpoint(built, 'POST', '/delete');

		const other = await del.handler(
			mockEvent({ method: 'POST', url: `${BASE}/delete`, body: { id: 'other-pending' } })
		);
		expect(other.status).toBe(403);

		const ownApproved = await del.handler(
			mockEvent({ method: 'POST', url: `${BASE}/delete`, body: { id: 'my-approved' } })
		);
		expect(ownApproved.status).toBe(403);
	});

	it('allows logged-in authors to delete their own approved comment', async () => {
		const built = await setup([
			commentRow({ id: 'mine', status: 'approved', path: '/a', userId: 'u-1' })
		]);
		const del = getEndpoint(built, 'POST', '/delete');
		const res = await del.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/delete`,
				body: { id: 'mine' },
				user: { id: 'u-1', name: '作者' }
			})
		);
		expect(res.status).toBe(200);
		expect(built.dbDelete).toHaveBeenCalledWith('comments', 'mine');
	});

	it('A2：删除顶层评论级联删除整条线程（rootId 指向它的全部后代）', async () => {
		const built = await setup([
			commentRow({ id: 'root-1', status: 'approved', path: '/a', userId: 'u-1', rootId: null }),
			commentRow({ id: 'r-1', status: 'approved', path: '/a', parentId: 'root-1', rootId: 'root-1' }),
			commentRow({ id: 'r-2', status: 'approved', path: '/a', parentId: 'r-1', rootId: 'root-1' })
		]);
		const del = getEndpoint(built, 'POST', '/delete');
		const res = await del.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/delete`,
				body: { id: 'root-1' },
				user: { id: 'u-1', name: '作者' }
			})
		);
		expect(res.status).toBe(200);
		// 两个后代（rootId=root-1）+ 顶层本身，全部删除，无孤儿
		expect(built.dbDelete).toHaveBeenCalledWith('comments', 'r-1');
		expect(built.dbDelete).toHaveBeenCalledWith('comments', 'r-2');
		expect(built.dbDelete).toHaveBeenCalledWith('comments', 'root-1');
		expect(built.rows.some((r) => r.parentId === 'root-1' || r.parentId === 'r-1')).toBe(false);
	});

	it('A2：删除中间回复把子回复改挂到其父（rootId 不变，不产生孤儿）', async () => {
		const built = await setup([
			commentRow({ id: 'root-1', status: 'approved', path: '/a', userId: 'other' }),
			commentRow({ id: 'mid', status: 'approved', path: '/a', userId: 'u-1', parentId: 'root-1', rootId: 'root-1' }),
			commentRow({ id: 'leaf', status: 'approved', path: '/a', parentId: 'mid', rootId: 'root-1' })
		]);
		const del = getEndpoint(built, 'POST', '/delete');
		const res = await del.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/delete`,
				body: { id: 'mid' },
				user: { id: 'u-1', name: '作者' }
			})
		);
		expect(res.status).toBe(200);
		expect(built.dbDelete).toHaveBeenCalledWith('comments', 'mid');
		// leaf 的 parentId 从 mid 改挂到 mid 的父（root-1），rootId 保持 root-1
		const leaf = built.rows.find((r) => r.id === 'leaf');
		expect(leaf?.parentId).toBe('root-1');
		expect(leaf?.rootId).toBe('root-1');
	});
});

describe('POST /admin/reply', () => {
	it('creates an approved official reply attributed to the admin', async () => {
		const built = await setup();
		const reply = getEndpoint(built, 'POST', '/admin/reply');

		const res = await reply.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/admin/reply`,
				body: { content: '官方回复', path: '/a', email: 'ignored@x.dev' },
				user: { id: 'admin-1', name: '站长' }
			})
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			comment: { official: boolean; pending: boolean; authorName: string | null; avatar: null };
		};
		expect(body.comment.official).toBe(true);
		expect(body.comment.pending).toBe(false);
		expect(body.comment.authorName).toBe('站长');
		// 官方回复无邮箱 → 字母头像（avatar null）
		expect(body.comment.avatar).toBeNull();

		const created = built.dbCreate.mock.calls[0][1] as Record<string, unknown>;
		expect(created.status).toBe('approved');
		expect(created.userId).toBe('admin-1');
		expect(created.email).toBeNull();
		expect(created.rootId).toBeNull();
	});

	it('locks rootId when replying into a thread and requires a binding', async () => {
		const built = await setup([commentRow({ id: 'root-1', path: '/a' })]);
		const reply = getEndpoint(built, 'POST', '/admin/reply');

		const threaded = await reply.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/admin/reply`,
				body: { content: '官方回复', path: '/a', parentId: 'root-1' },
				user: { id: 'admin-1', name: '站长' }
			})
		);
		expect(threaded.status).toBe(200);
		const created = built.dbCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
		expect(created.rootId).toBe('root-1');

		const noBinding = await reply.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/admin/reply`,
				body: { content: 'x' },
				user: { id: 'admin-1', name: '站长' }
			})
		);
		expect(noBinding.status).toBe(400);
	});
});

describe('C2-3 编辑自己的评论', () => {
	const seed = (extra: Record<string, unknown> = {}) => [
		commentRow({ id: 'own-1', path: '/a', status: 'approved', visitorId: VISITOR, ...extra })
	];

	it('游客编辑本人待审 → 200 且内容更新', async () => {
		const built = await setup([commentRow({ id: 'own-2', path: '/a', status: 'pending', visitorId: VISITOR })]);
		const edit = getEndpoint(built, 'POST', '/edit');
		const res = await edit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/edit`, body: { id: 'own-2', content: '改过的话' } })
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { content: string; pending: boolean };
		expect(body.content).toBe('改过的话');
		expect(body.pending).toBe(true);
	});

	it('审核开启：approved 编辑（登录者本人）后回 pending', async () => {
		const built = await setup([commentRow({ id: 'own-1', path: '/a', status: 'approved', userId: 'u-1' })]);
		const edit = getEndpoint(built, 'POST', '/edit');
		const res = await edit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/edit`,
				body: { id: 'own-1', content: '改' },
				user: { id: 'u-1', name: '宏伟' }
			})
		);
		const body = (await res.json()) as { status: string; pending: boolean };
		expect(body.status).toBe('pending');
		expect(body.pending).toBe(true);
	});

	it('审核关闭：approved 编辑（登录者本人）后状态不变', async () => {
		const built = await setup(
			[commentRow({ id: 'own-1', path: '/a', status: 'approved', userId: 'u-1' })],
			{ moderation: false }
		);
		const edit = getEndpoint(built, 'POST', '/edit');
		const res = await edit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/edit`,
				body: { id: 'own-1', content: '改' },
				user: { id: 'u-1', name: '宏伟' }
			})
		);
		expect(((await res.json()) as { status: string }).status).toBe('approved');
	});

	it('非本人 → 403；他人 approved 游客不可编辑', async () => {
		const built = await setup([commentRow({ id: 'other-1', path: '/a', status: 'approved' })]);
		const edit = getEndpoint(built, 'POST', '/edit');
		const res = await edit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/edit`, body: { id: 'other-1', content: '改' } })
		);
		expect(res.status).toBe(403);
	});

	it('空内容 → 400', async () => {
		const built = await setup(seed());
		const edit = getEndpoint(built, 'POST', '/edit');
		const res = await edit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/edit`, body: { id: 'own-1', content: '   ' } })
		);
		expect(res.status).toBe(400);
	});
});

describe('C2-4 排序切换', () => {
	it('sort=hot 顶层按 likes 降序（同赞数按新在前）', async () => {
		const built = await setup([
			commentRow({ id: 'l1', path: '/a', status: 'approved', likes: 1, createdAt: '2026-09-01T00:00:00' }),
			commentRow({ id: 'l9', path: '/a', status: 'approved', likes: 9, createdAt: '2026-09-02T00:00:00' }),
			commentRow({ id: 'l5', path: '/a', status: 'approved', likes: 5, createdAt: '2026-08-01T00:00:00' })
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=/a&sort=hot` })
		);
		const body = (await res.json()) as { data: { id: string }[]; sort: string };
		expect(body.data.map((c) => c.id)).toEqual(['l9', 'l5', 'l1']);
		expect(body.sort).toBe('hot');
		// 非法值回 latest
		const res2 = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=/a&sort=evil` })
		);
		const body2 = (await res2.json()) as { data: { id: string }[]; sort: string };
		expect(body2.sort).toBe('latest');
		expect(body2.data.map((c) => c.id)).toEqual(['l9', 'l1', 'l5']);
	});
});
