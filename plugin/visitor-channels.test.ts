import { describe, it, expect } from 'vitest';
import { visitorChannelStateOf, type VisitorProviderEntry } from './visitor-channels';

const PROVIDERS: VisitorProviderEntry[] = [
	{ id: 'wechat', label: '微信' },
	{ id: 'qq', label: 'QQ' }
];

/**
 * 访客渠道视图（框架 better-auth 会话）：
 * - 匿名会话没有渠道：只展示登录入口，不给绑定入口；
 * - 社交访客挂上一个渠道后：已挂渠道成列表，未挂提供方给绑定入口；
 * - 渠道目录里的重复/缺 provider 行丢弃。
 */
describe('访客渠道视图', () => {
	it('匿名会话：没有渠道就没有绑定入口', () => {
		const state = visitorChannelStateOf(null, PROVIDERS);
		expect(state.current).toBeNull();
		expect(state.bound).toEqual([]);
		expect(state.available).toEqual([]);
		expect(state.canUnbind).toBe(false);
	});

	it('单渠道：当前渠道在绑，另一提供方给绑定入口', () => {
		const state = visitorChannelStateOf(
			{
				authenticated: false,
				anonymous: true,
				bindings: [{ provider: 'wechat', nickname: '小明', avatar: null, lastLoginAt: null }],
				canUnbind: false
			},
			PROVIDERS
		);
		expect(state.current).toBe('wechat');
		expect(state.bound.map((b) => b.provider)).toEqual(['wechat']);
		expect(state.available.map((p) => p.id)).toEqual(['qq']);
		expect(state.canUnbind).toBe(false);
	});

	it('双渠道：没有可绑定项，允许解绑', () => {
		const state = visitorChannelStateOf(
			{
				authenticated: false,
				anonymous: true,
				bindings: [
					{ provider: 'qq', nickname: 'QQ 用户', avatar: null, lastLoginAt: null },
					{ provider: 'wechat', nickname: '微信用户', avatar: null, lastLoginAt: null }
				],
				canUnbind: true
			},
			PROVIDERS
		);
		expect(state.current).toBe('qq');
		expect(state.bound.map((b) => b.provider)).toEqual(['qq', 'wechat']);
		expect(state.available).toEqual([]);
		expect(state.canUnbind).toBe(true);
	});

	it('匿名会话即使给了提供方清单也不引导绑定', () => {
		const state = visitorChannelStateOf(
			{ authenticated: false, anonymous: true, bindings: [], canUnbind: false },
			PROVIDERS
		);
		expect(state.bound).toEqual([]);
		expect(state.available).toEqual([]);
	});

	it('脏数据容错：缺 provider 的绑定丢弃，同渠道重复只留一条', () => {
		const state = visitorChannelStateOf(
			{
				bindings: [
					{ provider: '', nickname: '空渠道' },
					{ provider: 'wechat', nickname: '旧昵称' },
					{ provider: 'wechat', nickname: '新昵称' },
					{ nickname: '没有 provider' }
				] as never,
				canUnbind: true
			},
			PROVIDERS
		);
		expect(state.bound).toHaveLength(1);
		expect(state.bound[0].nickname).toBe('旧昵称');
		expect(state.canUnbind).toBe(false);
	});
});
