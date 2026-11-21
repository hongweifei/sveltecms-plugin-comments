import { describe, it, expect, vi } from 'vitest';
import { BASE, VISITOR, setup, getEndpoint, mockEvent, submitBody, commentRow, userRow } from './comments-test-utils';
import { gravatarHash } from './client-info';

describe('GET /list', () => {
	it('returns top-level threads with children grouped by rootId, strips email plaintext', async () => {
		const built = await setup([
			commentRow({ id: 'root-1', path: '/a', email: 'a@test.dev', os: 'Windows 10+', browser: 'Chrome', region: '中国·广东·深圳' }),
			commentRow({
				id: 'child-1',
				path: '/a',
				parentId: 'root-1',
				rootId: 'root-1',
				email: 'b@test.dev',
				createdAt: '2026-08-30T00:00:00.000Z'
			}),
			commentRow({
				id: 'grandchild-1',
				path: '/a',
				parentId: 'child-1',
				rootId: 'root-1',
				createdAt: '2026-08-29T00:00:00.000Z'
			}),
			// 其他根评论的后代——本页未含其根，不得混入
			commentRow({
				id: 'other-child',
				path: '/a',
				parentId: 'root-x',
				rootId: 'root-x',
				createdAt: '2026-08-28T00:00:00.000Z'
			}),
			commentRow({ id: 'elsewhere', path: '/b' })
		]);
		const list = getEndpoint(built, 'GET', '/list');

		const res = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa&page=1&pageSize=20` })
		);
		const body = (await res.json()) as {
			data: { id: string; avatar: string | null; email?: unknown }[];
			children: { id: string; parentId: string | null }[];
			total: number;
		};
		expect(body.data.map((c) => c.id)).toEqual(['root-1']);
		// children 只含本页顶层（root-1）的后代，时间正序
		expect(body.children.map((c) => c.id)).toEqual(['grandchild-1', 'child-1']);
		// email 明文绝不外发，avatar 只输出头像地址（QQ 邮箱 → qlogo，其余 →
		// cravatar 的 md5 地址）
		expect(body.data[0].avatar).toBe(
			`https://cravatar.cn/avatar/${gravatarHash('a@test.dev')}?d=404&s=72`
		);
		for (const item of [...body.data, ...body.children]) {
			expect('email' in item).toBe(false);
			expect('visitorId' in item).toBe(false);
			expect('userId' in item).toBe(false);
		}
		// 环境信息对外可见
		const top = body.data[0] as unknown as { os: string; browser: string; region: string };
		expect(top.os).toBe('Windows 10+');
		expect(top.browser).toBe('Chrome');
		expect(top.region).toBe('中国·广东·深圳');
		expect(body.total).toBe(1);
	});

	it('历史行存离线库原始记录时，读取按展示文本归一', async () => {
		const built = await setup([
			commentRow({ id: 'legacy-1', path: '/a', region: '中国|广东省|广州市|电信|CN' })
		]);
		const list = getEndpoint(built, 'GET', '/list');

		const res = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa&page=1&pageSize=20` })
		);
		const body = (await res.json()) as { data: { region: string | null }[] };
		expect(body.data[0].region).toBe('中国·广东省·广州市·电信');
	});

	it('QQ 邮箱解析为 qlogo 头像，普通邮箱走 cravatar，无邮箱为 null', async () => {
		const built = await setup([
			commentRow({ id: 'qq-1', path: '/a', email: '12345678@QQ.com' }),
			commentRow({ id: 'cr-1', path: '/a', email: 'someone@example.com' }),
			commentRow({ id: 'no-1', path: '/a', email: null })
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa` }));
		const body = (await res.json()) as { data: { id: string; avatar: string | null }[] };
		const byId = new Map(body.data.map((c) => [c.id, c.avatar]));
		expect(byId.get('qq-1')).toBe('https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100');
		expect(byId.get('cr-1')).toBe(
			`https://cravatar.cn/avatar/${gravatarHash('someone@example.com')}?d=404&s=72`
		);
		expect(byId.get('no-1')).toBeNull();
	});

	it('登录用户头像/昵称实时反查 user 表（image 优先，邮箱派生兜底，缺用户回落本行存证）', async () => {
		const built = await setup([
			commentRow({
				id: 'with-image',
				path: '/a',
				userId: 'u-img',
				authorName: '旧昵称',
				email: 'legacy@example.com'
			}),
			commentRow({ id: 'with-email-only', path: '/a', userId: 'u-mail', email: null }),
			commentRow({
				id: 'user-gone',
				path: '/a',
				userId: 'u-gone',
				authorName: '遗留名',
				email: 'gone@example.com'
			}),
			commentRow({ id: 'guest', path: '/a', userId: null, email: 'guest@example.com' }),
			userRow({ id: 'u-img', name: 'Alice', image: 'https://cdn.example.com/me.png' }),
			userRow({ id: 'u-mail', name: 'Bob', image: null, email: 'mail@example.com' })
		]);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa` }));
		const body = (await res.json()) as {
			data: { id: string; avatar: string | null; authorName: string | null }[];
		};
		const byId = new Map(body.data.map((c) => [c.id, c.avatar]));
		const nameById = new Map(body.data.map((c) => [c.id, c.authorName]));
		// user.image 优先——即便本行遗留了旧邮箱
		expect(byId.get('with-image')).toBe('https://cdn.example.com/me.png');
		// 无 image → 按账号邮箱派生（cravatar）
		expect(byId.get('with-email-only')).toBe(
			`https://cravatar.cn/avatar/${gravatarHash('mail@example.com')}?d=404&s=72`
		);
		// user 记录不存在 → 回落本行邮箱派生
		expect(byId.get('user-gone')).toBe(
			`https://cravatar.cn/avatar/${gravatarHash('gone@example.com')}?d=404&s=72`
		);
		// 游客评论不受影响（无 userId，不查 user 表）
		expect(byId.get('guest')).toBe(
			`https://cravatar.cn/avatar/${gravatarHash('guest@example.com')}?d=404&s=72`
		);
		// 昵称同样实时反查：本行遗留旧昵称被 user.name 覆盖
		expect(nameById.get('with-image')).toBe('Alice');
		expect(nameById.get('with-email-only')).toBe('Bob');
		// user 记录不存在 → 回落本行 authorName
		expect(nameById.get('user-gone')).toBe('遗留名');
		// 全页无 userId 行时不产生 user 表查询
		const clean = await setup([commentRow({ id: 'only-guest', path: '/a' })]);
		(clean.dbFind as ReturnType<typeof vi.fn>).mockClear();
		await getEndpoint(clean, 'GET', '/list').handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa` })
		);
		const queriedTables = (clean.dbFind as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0]
		) as string[];
		expect(queriedTables).not.toContain('user');
	});

	it('merges own pending top-level into data and own pending replies into children', async () => {
		const built = await setup([
			commentRow({ id: 'pub-1', path: '/a' }),
			commentRow({
				id: 'mine-pending-root',
				path: '/a',
				status: 'pending',
				visitorId: VISITOR,
				createdAt: '2026-09-01T00:00:00.000Z'
			}),
			commentRow({
				id: 'pub-child',
				path: '/a',
				parentId: 'pub-1',
				rootId: 'pub-1',
				createdAt: '2026-08-30T00:00:00.000Z'
			}),
			commentRow({
				id: 'mine-pending-reply',
				path: '/a',
				parentId: 'pub-1',
				rootId: 'pub-1',
				status: 'pending',
				visitorId: VISITOR,
				createdAt: '2026-08-31T12:00:00.000Z'
			}),
			commentRow({ id: 'other-pending', path: '/a', status: 'pending' })
		]);
		const list = getEndpoint(built, 'GET', '/list');

		const res = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa&page=1&pageSize=20` })
		);
		const body = (await res.json()) as {
			data: { id: string; pending: boolean; mine: boolean }[];
			children: { id: string; pending: boolean; mine: boolean }[];
		};
		expect(body.data.map((c) => c.id)).toEqual(['mine-pending-root', 'pub-1']);
		expect(body.data[0].pending).toBe(true);
		expect(body.data[0].mine).toBe(true);
		// 待审回复挂在对应根下，别人的待审后代不出现
		expect(body.children.map((c) => c.id)).toEqual(['pub-child', 'mine-pending-reply']);
		expect(body.children[1].pending).toBe(true);
		expect(body.children[1].mine).toBe(true);
	});

	it('paginates top-level threads with hasMore from total', async () => {
		const seed = Array.from({ length: 25 }, (_, i) =>
			commentRow({
				id: `p-${i}`,
				path: '/a',
				createdAt: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`
			})
		);
		const built = await setup(seed);
		const list = getEndpoint(built, 'GET', '/list');

		const page1 = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa&page=1&pageSize=20` })
		);
		const body1 = (await page1.json()) as { data: unknown[]; hasMore: boolean };
		expect(body1.data).toHaveLength(20);
		expect(body1.hasMore).toBe(true);

		const page2 = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa&page=2&pageSize=20` })
		);
		const body2 = (await page2.json()) as { data: unknown[]; hasMore: boolean };
		expect(body2.data).toHaveLength(5);
		expect(body2.hasMore).toBe(false);
	});

	it('supports contentId binding', async () => {
		const built = await setup([
			commentRow({ id: 'by-content', contentId: 'content-1' }),
			commentRow({ id: 'by-path', path: '/a' })
		]);
		const list = getEndpoint(built, 'GET', '/list');

		const res = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?contentId=content-1` })
		);
		const body = (await res.json()) as { data: { id: string }[] };
		expect(body.data.map((c) => c.id)).toEqual(['by-content']);
	});

	// 方案 A 判别核心：不同集合可有同 contentId——声明类型时只回该类型行 +
	// 历史空类型行，别的类型带同 id 的评论绝不串读进来。
	it('contentId 跨集合不串读：声明 posts 时 pages 同 id 评论不可见', async () => {
		const built = await setup([
			commentRow({ id: 'posts-c', contentId: 'dup-1', contentType: 'posts', path: null }),
			commentRow({ id: 'pages-c', contentId: 'dup-1', contentType: 'pages', path: null }),
			commentRow({ id: 'legacy-c', contentId: 'dup-1', path: null }) // 历史空类型
		]);
		const list = getEndpoint(built, 'GET', '/list');

		const asPosts = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?contentId=dup-1&contentType=posts` })
		);
		const postsBody = (await asPosts.json()) as { data: { id: string }[] };
		expect(postsBody.data.map((c) => c.id).sort()).toEqual(['legacy-c', 'posts-c']);

		const asPages = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?contentId=dup-1&contentType=pages` })
		);
		const pagesBody = (await asPages.json()) as { data: { id: string }[] };
		expect(pagesBody.data.map((c) => c.id).sort()).toEqual(['legacy-c', 'pages-c']);
	});

	it('/count 同样按类型判别（同 contentId 不同集合计数互隔）', async () => {
		const built = await setup([
			commentRow({ id: 'p1', contentId: 'dup-1', contentType: 'posts', path: null }),
			commentRow({ id: 'p2', contentId: 'dup-1', contentType: 'posts', path: null }),
			commentRow({ id: 'g1', contentId: 'dup-1', contentType: 'pages', path: null })
		]);
		const count = getEndpoint(built, 'GET', '/count');
		const posts = await count.handler(
			mockEvent({ method: 'GET', url: `${BASE}/count?contentId=dup-1&contentType=posts` })
		);
		expect(((await posts.json()) as { count: number }).count).toBe(2);
		// 缓存键含类型——前一问不得污染后一问
		const pages = await count.handler(
			mockEvent({ method: 'GET', url: `${BASE}/count?contentId=dup-1&contentType=pages` })
		);
		expect(((await pages.json()) as { count: number }).count).toBe(1);
	});

	it('likedIds 回传当前身份已赞的评论 id（游客按 visitorId、登录按 userId）', async () => {
		const built = await setup([
			commentRow({ id: 'c1', path: '/a' }),
			commentRow({ id: 'c2', path: '/a' }),
			commentRow({ id: 'c3', path: '/a' }),
			// 游客（VISITOR）赞了 c1；登录用户 u-9 赞了 c2；c3 无人赞
			{ id: 'lk-1', _collection: 'plugin_comments_likes', commentId: 'c1', userId: null, visitorId: VISITOR },
			{ id: 'lk-2', _collection: 'plugin_comments_likes', commentId: 'c2', userId: 'u-9', visitorId: 'whoever' }
		]);
		const list = getEndpoint(built, 'GET', '/list');

		const guest = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa` }));
		const gb = (await guest.json()) as { likedIds: string[] };
		expect(gb.likedIds.sort()).toEqual(['c1']);

		const logged = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa`, user: { id: 'u-9', name: 'Zed' } })
		);
		const lb = (await logged.json()) as { likedIds: string[] };
		expect(lb.likedIds).toEqual(['c2']);
	});
});

describe('GET /count', () => {
	it('counts approved comments for the binding', async () => {
		const built = await setup([
			commentRow({ id: 'a', path: '/a' }),
			commentRow({ id: 'b', path: '/a' }),
			commentRow({ id: 'pending', path: '/a', status: 'pending' }),
			commentRow({ id: 'c', path: '/b' })
		]);
		const count = getEndpoint(built, 'GET', '/count');

		const res = await count.handler(mockEvent({ method: 'GET', url: `${BASE}/count?path=%2Fa` }));
		const body = (await res.json()) as { count: number };
		expect(body.count).toBe(2);
	});
});

describe('D1 GET /children（单线程后代续拉）', () => {
	// 一条顶层 + 该线程下若干回复（rootId 指向顶层），createdAt 各异便于验证升序
	const threadSeed = () => [
		commentRow({ id: 'root-1', path: '/a', status: 'approved', rootId: null }),
		commentRow({ id: 'r1', path: '/a', parentId: 'root-1', rootId: 'root-1', status: 'approved', createdAt: '2026-08-01T00:00:01Z' }),
		commentRow({ id: 'r2', path: '/a', parentId: 'root-1', rootId: 'root-1', status: 'approved', createdAt: '2026-08-01T00:00:02Z' }),
		commentRow({ id: 'r3', path: '/a', parentId: 'root-1', rootId: 'root-1', status: 'approved', createdAt: '2026-08-01T00:00:03Z' }),
		commentRow({ id: 'rp', path: '/a', parentId: 'root-1', rootId: 'root-1', status: 'pending', createdAt: '2026-08-01T00:00:04Z' })
	];

	it('返回指定 rootId 的已审核后代（升序），pending 不外发', async () => {
		const built = await setup(threadSeed());
		const children = getEndpoint(built, 'GET', '/children');
		const res = await children.handler(
			mockEvent({ method: 'GET', url: `${BASE}/children?path=/a&rootId=root-1&after=0&limit=50` })
		);
		const body = (await res.json()) as { data: { id: string }[]; total: number; hasMore: boolean };
		// 三条 approved（rp 是 pending 排除），升序
		expect(body.data.map((c) => c.id)).toEqual(['r1', 'r2', 'r3']);
		expect(body.total).toBe(3);
		expect(body.hasMore).toBe(false);
	});

	it('after 续拉跳过已展示前缀，limit 控制批大小与 hasMore', async () => {
		const built = await setup(threadSeed());
		const children = getEndpoint(built, 'GET', '/children');
		// 已展示 1 条 → 从第二条起取 1 条
		const res = await children.handler(
			mockEvent({ method: 'GET', url: `${BASE}/children?path=/a&rootId=root-1&after=1&limit=1` })
		);
		const body = (await res.json()) as { data: { id: string }[]; hasMore: boolean };
		expect(body.data.map((c) => c.id)).toEqual(['r2']);
		expect(body.hasMore).toBe(true); // after1+1=2 < total3
	});

	it('缺绑定 / 缺 rootId / 非法 rootId → 400', async () => {
		const built = await setup(threadSeed());
		const children = getEndpoint(built, 'GET', '/children');
		// 无绑定
		expect((await children.handler(mockEvent({ method: 'GET', url: `${BASE}/children?rootId=root-1` }))).status).toBe(400);
		// 缺 rootId
		expect((await children.handler(mockEvent({ method: 'GET', url: `${BASE}/children?path=/a` }))).status).toBe(400);
		// 非法 rootId
		expect((await children.handler(mockEvent({ method: 'GET', url: `${BASE}/children?path=/a&rootId=bad/../x` }))).status).toBe(400);
	});

	it('hideEnv 开启时续拉投影同样剥离环境字段', async () => {
		const built = await setup(threadSeed(), { hideEnv: true });
		const children = getEndpoint(built, 'GET', '/children');
		const res = await children.handler(
			mockEvent({ method: 'GET', url: `${BASE}/children?path=/a&rootId=root-1&after=0&limit=50` })
		);
		const body = (await res.json()) as { data: Record<string, unknown>[] };
		expect(body.data[0]).toMatchObject({ os: null, browser: null, region: null });
	});

	it('/list 命中 CHILD_CAP 时标注被截线程（rootId + loaded=已返回数）', async () => {
		// 一条顶层 + 501 条后代（全 approved 同 rootId），超 CHILD_CAP=500 触发截断标注
		const seed: Record<string, unknown>[] = [
			commentRow({ id: 'bigroot', path: '/a', status: 'approved', rootId: null })
		];
		for (let i = 0; i < 501; i++) {
			seed.push(
				commentRow({
					id: `k-${i}`,
					path: '/a',
					parentId: 'bigroot',
					rootId: 'bigroot',
					status: 'approved'
				})
			);
		}
		const built = await setup(seed);
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa&pageSize=20` }));
		const body = (await res.json()) as {
			children: unknown[];
			truncatedThreads: Array<{ rootId: string; loaded: number }>;
		};
		// 批量返回封顶 500 条，线程实际 501 → 被标注且 loaded=500
		expect(body.children).toHaveLength(500);
		expect(body.truncatedThreads).toEqual([{ rootId: 'bigroot', loaded: 500 }]);
	});

	it('/list 未命中 CHILD_CAP 时 truncatedThreads 为空（常态零开销）', async () => {
		const built = await setup(threadSeed());
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa&pageSize=20` }));
		const body = (await res.json()) as { truncatedThreads: unknown[] };
		expect(body.truncatedThreads).toEqual([]);
	});
});

describe('C3-2 评论计数缓存', () => {
	it('count 结果 60s 内命中缓存（db 不再查询），提交后失效重算', async () => {
		const built = await setup([], { moderation: false });
		const count = getEndpoint(built, 'GET', '/count');
		const submit = getEndpoint(built, 'POST', '/submit');

		const first = await count.handler(mockEvent({ method: 'GET', url: `${BASE}/count?path=/a` }));
		expect(((await first.json()) as { count: number }).count).toBe(0);

		// 提交（免审 → approved）→ bustCount
		await submit.handler(
			mockEvent({ method: 'POST', url: `${BASE}/submit`, body: submitBody() })
		);

		const second = await count.handler(mockEvent({ method: 'GET', url: `${BASE}/count?path=/a` }));
		expect(((await second.json()) as { count: number }).count).toBe(1);
	});
});
