import { describe, it, expect } from 'vitest';
import type { PluginContext } from '#lib/cms/types/plugin.ts';
import { setup, commentRow } from './comments-test-utils';

/**
 * 服务消费走框架 0.3 的强类型入口：service-count.ts 的 declaration merging
 * 已把 `comments/count` 的形状登记进 PluginServiceContracts，这里不再断言类型。
 */
function countService(ctx: PluginContext) {
	const api = ctx.service.get('comments/count');
	if (!api) throw new Error('comments/count service not provided');
	return api;
}

describe('service comments/count', () => {
	it('注册时供给 comments/count（byPath / byContent 可用）', async () => {
		const built = await setup();
		const api = countService(built.ctx);
		expect(typeof api.byPath).toBe('function');
		expect(typeof api.byContent).toBe('function');
		expect(built.ctx.service.list()).toContain('comments/count');
	});

	it('byPath 只统计 approved（与公开列表同口径）', async () => {
		const built = await setup([
			commentRow({ id: 'c1', path: '/a', status: 'approved' }),
			commentRow({ id: 'c2', path: '/a', status: 'pending' }),
			commentRow({ id: 'c3', path: '/a', status: 'spam' })
		]);
		expect(await countService(built.ctx).byPath('/a')).toBe(1);
	});

	it('byContent 按内容项与类型计数', async () => {
		const built = await setup([
			commentRow({ id: 'c1', path: null, contentType: 'posts', contentId: 'p1' }),
			commentRow({ id: 'c2', path: null, contentType: 'posts', contentId: 'p1' }),
			commentRow({ id: 'c3', path: null, contentType: 'posts', contentId: 'p2' })
		]);
		expect(await countService(built.ctx).byContent('posts', 'p1')).toBe(2);
		expect(await countService(built.ctx).byContent('posts', 'missing')).toBe(0);
	});

	it('非法绑定返回 0，不抛错', async () => {
		const built = await setup();
		expect(await countService(built.ctx).byPath('')).toBe(0);
	});
});
