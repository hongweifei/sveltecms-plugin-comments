import { describe, it, expect } from 'vitest';
import {
	visitorBindUrl,
	visitorChannelStateOf,
	type VisitorProviderEntry
} from './visitor-channels';

const PROVIDERS: VisitorProviderEntry[] = [
	{ id: 'wechat', label: '微信', start: '/api/auth/visitor/start/wechat' },
	{ id: 'qq', label: 'QQ', start: '/api/auth/visitor/start/qq' }
];

/**
 * 访客账号渠道视图（框架 0.3 visitor_accounts + visitor_bindings）：
 * - 未登录：不给绑定入口（没有账号可挂）；
 * - 已登录：已绑定渠道成列表，未绑定提供方给 ?bind=1 入口；
 * - 账号目录降级：不展示明细、不引导绑定，仍保留当前渠道。
 */
describe('访客账号渠道视图', () => {
	it('未登录：没有账号就没有绑定入口', () => {
		const state = visitorChannelStateOf(null, PROVIDERS);
		expect(state.current).toBeNull();
		expect(state.bound).toEqual([]);
		expect(state.available).toEqual([]);
		expect(state.canUnbind).toBe(false);
		expect(state.degraded).toBe(false);
	});

	it('单渠道账号：当前渠道在绑，另一提供方给绑定入口', () => {
		const state = visitorChannelStateOf(
			{
				authenticated: true,
				account: {
					bindings: [{ provider: 'wechat', nickname: '小明', avatar: null, lastLoginAt: null }],
					canUnbind: false
				},
				currentProvider: 'wechat',
				degraded: false
			},
			PROVIDERS
		);
		expect(state.current).toBe('wechat');
		expect(state.bound.map((b) => b.provider)).toEqual(['wechat']);
		expect(state.available.map((p) => p.id)).toEqual(['qq']);
		expect(state.canUnbind).toBe(false);
	});

	it('双渠道账号：没有可绑定项，允许解绑', () => {
		const state = visitorChannelStateOf(
			{
				authenticated: true,
				account: {
					bindings: [
						{ provider: 'qq', nickname: 'QQ 用户', avatar: null, lastLoginAt: null },
						{ provider: 'wechat', nickname: '微信用户', avatar: null, lastLoginAt: null }
					],
					canUnbind: true
				},
				currentProvider: 'qq'
			},
			PROVIDERS
		);
		expect(state.bound.map((b) => b.provider)).toEqual(['qq', 'wechat']);
		expect(state.available).toEqual([]);
		expect(state.canUnbind).toBe(true);
	});

	it('账号目录降级：保留当前渠道，不给渠道明细与绑定入口', () => {
		const state = visitorChannelStateOf(
			{ authenticated: true, account: null, currentProvider: 'wechat', degraded: true },
			PROVIDERS
		);
		expect(state.current).toBe('wechat');
		expect(state.bound).toEqual([]);
		expect(state.available).toEqual([]);
		expect(state.degraded).toBe(true);
	});

	it('端点说未登录：即使给了提供方清单也不引导绑定', () => {
		const state = visitorChannelStateOf(
			{ authenticated: false, account: null, currentProvider: null },
			PROVIDERS
		);
		expect(state.bound).toEqual([]);
		expect(state.available).toEqual([]);
	});

	it('端点未下发 currentProvider 时回落会话渠道', () => {
		const state = visitorChannelStateOf(
			{ authenticated: true, account: { bindings: [], canUnbind: false } },
			PROVIDERS,
			'qq'
		);
		expect(state.current).toBe('qq');
		expect(state.available.map((p) => p.id)).toEqual(['wechat', 'qq']);
	});

	it('脏数据容错：缺 provider 的绑定丢弃，同渠道重复只留一条', () => {
		const state = visitorChannelStateOf(
			{
				authenticated: true,
				account: {
					bindings: [
						{ provider: '', nickname: '空渠道' },
						{ provider: 'wechat', nickname: '旧昵称' },
						{ provider: 'wechat', nickname: '新昵称' },
						{ nickname: '没有 provider' }
					] as never,
					canUnbind: true
				},
				currentProvider: 'wechat'
			},
			PROVIDERS
		);
		expect(state.bound).toHaveLength(1);
		expect(state.bound[0].nickname).toBe('旧昵称');
		expect(state.canUnbind).toBe(false);
	});
});

describe('绑定地址', () => {
	it('在 start 地址上补 bind=1 与回跳', () => {
		const url = visitorBindUrl('/api/auth/visitor/start/wechat', '/posts/1?from=list');
		expect(url).toBe('/api/auth/visitor/start/wechat?returnTo=%2Fposts%2F1%3Ffrom%3Dlist&bind=1');
	});

	it('start 地址自带查询串时接 &', () => {
		expect(visitorBindUrl('/api/auth/visitor/start/qq?variant=2', '/a')).toBe(
			'/api/auth/visitor/start/qq?variant=2&returnTo=%2Fa&bind=1'
		);
	});

	it('start 缺失的条目不产出链接', () => {
		expect(visitorBindUrl('', '/a')).toBe('');
	});
});
