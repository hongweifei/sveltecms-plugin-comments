import { describe, it, expect } from 'vitest';
import { plugin, setup, commentRow } from './comments-test-utils';

/**
 * 升级回填：库内页面路径统一为可读原文。地址栏里的中文段是
 * percent-encoding（`/article/%E7%BD%91…`），早先落库的路径是这个编码形态。
 */
describe('页面路径回填（migrate）', () => {
	const run = (built: Awaited<ReturnType<typeof setup>>) =>
		plugin.migrate!('0.2.0', built.ctx);

	it('把编码形态的历史路径回填为可读原文', async () => {
		const built = await setup([
			commentRow({ id: 'cn', path: '/article/%E7%BD%91%E7%BB%9C%E5%AE%89%E5%85%A8' }),
			commentRow({ id: 'plain', path: '/about' })
		]);

		await run(built);

		expect(built.rows.find((r) => r.id === 'cn')?.path).toBe('/article/网络安全');
		expect(built.rows.find((r) => r.id === 'plain')?.path).toBe('/about');
		expect(built.dbUpdate).toHaveBeenCalledTimes(1);
	});

	it('幂等：原文路径不再改写', async () => {
		const built = await setup([
			commentRow({ id: 'cn', path: '/article/%E7%BD%91%E7%BB%9C%E5%AE%89%E5%85%A8' })
		]);

		await run(built);
		await run(built);

		expect(built.rows.find((r) => r.id === 'cn')?.path).toBe('/article/网络安全');
		expect(built.dbUpdate).toHaveBeenCalledTimes(1);
	});

	it('读完所有分页：回填不因页宽截断漏行', async () => {
		const seed = Array.from({ length: 500 }, (_, i) =>
			commentRow({ id: `c-${i}`, path: `/%E6%96%87%E7%AB%A0-${i}` })
		);
		seed.push(commentRow({ id: 'last', path: '/%E6%9C%80%E5%90%8E' }));
		const built = await setup(seed);

		await run(built);

		expect(built.rows.find((r) => r.id === 'c-0')?.path).toBe('/文章-0');
		expect(built.rows.find((r) => r.id === 'last')?.path).toBe('/最后');
		expect(built.dbUpdate).toHaveBeenCalledTimes(501);
	});
});
