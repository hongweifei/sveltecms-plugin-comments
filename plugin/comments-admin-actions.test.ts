/**
 * 方案 B：后台列表行操作组件（slot-comment-admin-actions）的 SSR 渲染冒烟。
 * 核心门 = 集合判别：仅 contentType=comments 的行出「回复」入口，其他集合
 * （帖子/页面等）列表行渲染为空——框架插槽逐行渲染所有注册组件，藏不掉。
 */
import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import Actions from './components/slot-comment-admin-actions.svelte';

const commentRow = {
	id: 'c-1',
	content: 'hello',
	authorName: '小明',
	status: 'approved',
	path: '/a',
	contentId: null,
	contentType: null
};

describe('后台行操作组件渲染门', () => {
	it('comments 集合行 → 渲染回复按钮（含隐藏弹层结构）', () => {
		const { body } = render(Actions, {
			props: { contentType: 'comments', row: commentRow }
		});
		// SSR 阶段 i18n 未加载时按钮文本回退 key（admin_reply），可见即可
		expect(body).toContain('admin_reply');
		expect(body).toContain('<button');
	});

	it('非 comments 集合行 → 不渲染任何操作', () => {
		const { body } = render(Actions, {
			props: { contentType: 'posts', row: { id: 'p-1', title: 'x' } }
		});
		expect(body).not.toContain('button');
	});

	it('缺 row（异步槽首帧）→ 静默不渲染，不抛错', () => {
		const { body } = render(Actions, { props: { contentType: 'comments' } });
		expect(body).not.toContain('admin_reply');
	});
});
