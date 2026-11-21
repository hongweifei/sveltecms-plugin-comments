<!--
	评论审核工作台的登录来源筛选：注册到管理端内容列表工具栏插槽
	（collection-list-toolbar-before，ListPage 透传 contentType）。

	为什么由插件补这一块：列表页的通用快捷筛选只渲染 select / radio 字段，
	`visitorProvider` 是服务端写入的文本列，不出下拉；但列表服务端对任意
	`filter_<字段>` 都做等值过滤，因此这里只需把下拉选中的值写进 URL。

	只在 comments 集合显示；其它集合列表不受影响。
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { loadPluginMessages } from '#lib/cms/utils/i18n-client.ts';

	let { contentType = undefined }: { contentType?: string } = $props();

	// 文案与插件其它界面同源（/api/v1/i18n/comments 下发），不占用框架命名空间
	let messages = $state<Record<string, string>>({});
	const tr = $derived((key: string) => messages[key] ?? key);

	const value = $derived(page.url.searchParams.get('filter_visitorProvider') ?? '');

	$effect(() => {
		loadPluginMessages('comments').then((m) => (messages = m));
	});

	function change(event: Event) {
		const next = (event.currentTarget as HTMLSelectElement).value;
		const params = new SvelteURLSearchParams(page.url.search);
		if (next) params.set('filter_visitorProvider', next);
		else params.delete('filter_visitorProvider');
		params.set('page', '1');
		goto(`?${params.toString()}`, { refreshAll: true });
	}
</script>

{#if contentType === 'comments'}
	<label class="cl-filter">
		<span class="cl-filter-label">{tr('listFilter_source')}</span>
		<select class="cl-filter-select" {value} onchange={change}>
			<option value="">{tr('listFilter_allSources')}</option>
			<option value="wechat">{tr('wechatBadge')}</option>
		</select>
	</label>
{/if}

<style>
	.cl-filter {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}
	.cl-filter-label {
		white-space: nowrap;
	}
	.cl-filter-select {
		padding: 0.25rem 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}
</style>
