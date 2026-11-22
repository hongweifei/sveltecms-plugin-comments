import { describe, it, expect } from 'vitest';
import {
	IDENTITY_COOKIE,
	readRememberedIdentity,
	rememberIdentity
} from './identity-cookie';
import { setup, getEndpoint, mockEvent, createCookieJar, submitBody, BASE } from './comments-test-utils';

// cookie 属性：路径 / HttpOnly / SameSite=Lax / 180 天（测试环境非生产，secure=false）
const OPTIONS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	maxAge: 60 * 60 * 24 * 180,
	secure: process.env.NODE_ENV === 'production'
};

describe('访客身份 cookie 读写', () => {
	const eventWith = (raw?: string) => {
		const jar = createCookieJar(raw ? { [IDENTITY_COOKIE]: raw } : {});
		return { jar, event: { cookies: jar.api } };
	};

	it('无 cookie / 损坏 JSON / 空身份 → null', () => {
		expect(readRememberedIdentity(eventWith().event)).toBeNull();
		expect(readRememberedIdentity(eventWith('{oops').event)).toBeNull();
		expect(readRememberedIdentity(eventWith('[]').event)).toBeNull();
		expect(readRememberedIdentity(eventWith('{"authorName":""}').event)).toBeNull();
	});

	it('读取时只接受字符串字段，并按上限截断', () => {
		const { event } = eventWith(
			JSON.stringify({ authorName: '小'.repeat(80), email: 42, website: 'https://a.dev' })
		);
		const identity = readRememberedIdentity(event);
		expect(identity?.authorName).toHaveLength(40);
		expect(identity?.email).toBe('');
		expect(identity?.website).toBe('https://a.dev');
	});

	it('写入带 HttpOnly / SameSite=Lax / 180 天属性；三字段全空时清除', () => {
		const { jar, event } = eventWith();
		rememberIdentity(event, { authorName: '小明', email: 'a@b.dev', website: '' });
		const set = jar.setCalls.find((c) => c.name === IDENTITY_COOKIE);
		expect(JSON.parse(set!.value)).toEqual({ authorName: '小明', email: 'a@b.dev', website: '' });
		expect(set!.opts).toEqual(OPTIONS);

		rememberIdentity(event, { authorName: '', email: '', website: '' });
		expect(jar.deleteCalls).toContain(IDENTITY_COOKIE);
	});
});

describe('评论身份记忆闭环（/submit 写入 → /list 回填）', () => {
	it('游客提交成功后写入身份 cookie', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const jar = createCookieJar();

		const res = await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody({ authorName: '小明', website: 'example.com' }),
				cookieJar: jar
			})
		);
		expect(res.status).toBe(200);
		const set = jar.setCalls.find((c) => c.name === IDENTITY_COOKIE);
		expect(JSON.parse(set!.value)).toMatchObject({
			authorName: '小明',
			website: 'https://example.com/'
		});
		expect(set!.opts).toEqual(OPTIONS);
	});

	it('登录用户提交不写身份 cookie（身份来自会话）', async () => {
		const built = await setup();
		const submit = getEndpoint(built, 'POST', '/submit');
		const jar = createCookieJar();

		await submit.handler(
			mockEvent({
				method: 'POST',
				url: `${BASE}/submit`,
				body: submitBody(),
				user: { id: 'u-1', name: 'Alice' },
				cookieJar: jar
			})
		);
		expect(jar.setCalls.some((c) => c.name === IDENTITY_COOKIE)).toBe(false);
	});

	it('/list 回传 remembered（仅游客态），并声明私有缓存', async () => {
		const built = await setup();
		const list = getEndpoint(built, 'GET', '/list');
		const remembered = { authorName: '小明', email: 'a@b.dev', website: '' };

		const guestJar = createCookieJar({
			[IDENTITY_COOKIE]: JSON.stringify(remembered)
		});
		const guest = await list.handler(
			mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa`, cookieJar: guestJar })
		);
		expect(((await guest.json()) as { remembered: unknown }).remembered).toEqual(remembered);
		expect(guest.headers.get('cache-control')).toBe('private, no-store');

		// 登录用户与微信访客的身份由会话/签名 cookie 决定，不回传身份回填值
		for (const identity of [
			{ user: { id: 'u-1', name: 'Alice' } },
			{
				visitor: {
					provider: 'wechat' as const,
					subject: 's',
					openid: 'o',
					nickname: '微信用户'
				}
			}
		]) {
			const jar = createCookieJar({ [IDENTITY_COOKIE]: JSON.stringify(remembered) });
			const res = await list.handler(
				mockEvent({ method: 'GET', url: `${BASE}/list?path=%2Fa`, cookieJar: jar, ...identity })
			);
			const body = (await res.json()) as { remembered?: unknown };
			expect(body.remembered).toBeUndefined();
		}
	});

	it('/list 遇到损坏 cookie 正常工作', async () => {
		const built = await setup();
		const list = getEndpoint(built, 'GET', '/list');
		const res = await list.handler(
			mockEvent({
				method: 'GET',
				url: `${BASE}/list?path=%2Fa`,
				cookieJar: createCookieJar({ [IDENTITY_COOKIE]: '{broken' })
			})
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { remembered?: unknown }).remembered).toBeUndefined();
	});
});
