import { describe, it, expect } from 'vitest';
import { setup, commentRow } from './comments-test-utils';

type CountService = {
	byPath: (path: string) => Promise<number>;
	byContent: (contentType: string, contentId: string) => Promise<number>;
};

function countService(ctx: { service: { get: (id: string) => unknown } }): CountService {
	return ctx.service.get('comments/count') as CountService;
}

describe('service comments/count', () => {
	it('注册时供给 comments/count（byPath / byContent 可用）', async () => {
		const built = await setup();
		const api = countService(built.ctx);
		expect(api).toBeTruthy();
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
