import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import FormPage from '#lib/cms/components/page/FormPage.svelte';
import { setup } from './comments-test-utils';

/**
 * 编辑表单的字段可见性契约（宿主 FormPage 的 condition 语义）：
 * - 服务端托管字段（绑定三键 / 设备环境 / 内容归属）在 edit 模式不渲染
 * - 绑定三键在 create 模式可填写（新建评论需要绑定）
 */
async function renderForm(mode: 'create' | 'edit'): Promise<string> {
	const built = await setup();
	const collection = built.collectionRegister.mock.calls[0][0] as {
		slug: string;
		kind: string;
		label: string;
		api: boolean;
		fields: unknown[];
		list: unknown;
	};
	const config = {
		slug: collection.slug,
		kind: collection.kind,
		label: collection.label,
		api: collection.api,
		fields: collection.fields,
		list: collection.list
	};
	const data = mode === 'edit' ? { id: 'c-1', content: 'hi', status: 'approved' } : {};
	const { body } = render(FormPage, { props: { config, data, mode } as never });
	return body;
}

const SERVER_OWNED_LABELS = ['页面路径', '内容类型', '内容项 ID', '操作系统', '浏览器', '地区', '内容归属'];
const BINDING_LABELS = ['页面路径', '内容类型', '内容项 ID'];

describe('评论编辑表单字段可见性', () => {
	it('edit 模式只渲染人工维护字段', async () => {
		const body = await renderForm('edit');
		expect(body).toContain('内容');
		expect(body).toContain('状态');
		for (const label of SERVER_OWNED_LABELS) expect(body).not.toContain(label);
	});

	it('create 模式渲染绑定键，设备环境与内容归属保持隐藏', async () => {
		const body = await renderForm('create');
		for (const label of BINDING_LABELS) expect(body).toContain(label);
		for (const label of ['操作系统', '浏览器', '地区', '内容归属']) {
			expect(body).not.toContain(label);
		}
	});
});
