import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import MyComments from './components/MyComments.svelte';

/**
 * 「我的评论」面板的 SSR 冒烟：默认收起，只渲染入口按钮；面板打开时才发请求，
 * 服务端渲染阶段不触网（fetch 只在点击后调用）。
 */
describe('我的评论面板', () => {
	it('默认收起：渲染入口按钮，带 aria-expanded=false，不出现面板内容', () => {
		const { body } = render(MyComments, { props: {} });
		// 文案经 loadPluginMessages 下发，SSR 阶段回退 key
		expect(body).toContain('myComments');
		expect(body).toContain('aria-expanded="false"');
		expect(body).not.toContain('my-panel');
	});
});
