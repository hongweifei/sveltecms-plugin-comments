<!--
	我的评论：访客与登录用户的自助管理面板。

	评论归属认的是框架统一访客 id（cms_visitor 签名 cookie 里的稳定 UUID）或登录
	账号的 userId，所以没有账号的访客也能像账号一样查看、编辑、删除自己发过的
	评论——包括还在审核中的、以及已经公开的。访客 id 是一个账号，微信 / QQ 各
	是一行渠道绑定：面板注明「绑定另一个渠道后换端登录仍是同一份评论」，
	「合并两个已有账号只并身份、历史评论留在原账号」——这两件事都在框架侧完成，
	插件只说明归属口径，不搬数据。面板自带样式与文案（i18n 经
	loadPluginMessages 取词），父组件只在标题行放一个入口。

	数据来自插件自己的 `GET /mine`（只返回本人评论，带状态、所在页面与计数）。
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { getCsrfToken } from '#lib/common/utils/csrf.ts';
	import { loadPluginMessages } from '#lib/cms/utils/i18n-client.ts';
	import { formatRelativeTime } from '../client/format';
	import type { MyCommentItem, MyCommentsBody } from '../shared';

	interface Props {
		/** 站点单条字数上限（编辑框 maxlength） */
		maxLength?: number;
		/** 面板内的增删改完成后通知父组件刷新列表与计数 */
		onchanged?: () => void;
	}

	let { maxLength = 2000, onchanged }: Props = $props();

	const BASE = '/api/v1/plugin/comments';
	const PAGE_SIZE = 20;

	let messages = $state<Record<string, string>>({});
	const tr = $derived((key: string) => messages[key] ?? key);
	const t = $derived({
		myComments: tr('myComments'),
		myCommentsHint: tr('myCommentsHint'),
		myCommentsAccountHint: tr('myCommentsAccountHint'),
		myCommentsEmpty: tr('myCommentsEmpty'),
		myCommentsLoadFailed: tr('myCommentsLoadFailed'),
		pendingBadge: tr('pendingBadge'),
		publishedBadge: tr('publishedBadge'),
		hiddenBadge: tr('hiddenBadge'),
		edit: tr('edit'),
		save: tr('save'),
		cancel: tr('cancel'),
		del: tr('del'),
		deleteConfirm: tr('deleteConfirm'),
		editedFailed: tr('editedFailed'),
		failed: tr('failed'),
		loadMore: tr('loadMore'),
		timeJustNow: tr('timeJustNow'),
		timeMinutesAgo: tr('timeMinutesAgo'),
		timeHoursAgo: tr('timeHoursAgo'),
		timeDaysAgo: tr('timeDaysAgo')
	});

	let open = $state(false);
	let rootEl: HTMLDivElement;
	let toggleEl: HTMLButtonElement;
	let loaded = $state(false);
	let loading = $state(false);
	let failed = $state(false);
	let items = $state<MyCommentItem[]>([]);
	let total = $state(0);
	let page = $state(1);
	let editingId = $state<string | null>(null);
	let editText = $state('');
	let busyId = $state<string | null>(null);
	let flash = $state('');

	onMount(() => {
		void ensureMessages();
	});

	/** 词条接口偶发失败时重试，避免面板退化为 key 名 */
	async function ensureMessages() {
		if (Object.keys(messages).length > 0) return;
		for (let attempt = 0; attempt < 3; attempt++) {
			const loadedMessages = await loadPluginMessages('comments');
			if (Object.keys(loadedMessages).length > 0) {
				messages = loadedMessages;
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}

	function timeOf(iso: string): string {
		return formatRelativeTime(iso, {
			justNow: t.timeJustNow,
			minutesAgo: t.timeMinutesAgo,
			hoursAgo: t.timeHoursAgo,
			daysAgo: t.timeDaysAgo
		});
	}

	function statusLabel(status: string): string {
		if (status === 'pending') return t.pendingBadge;
		if (status === 'spam') return t.hiddenBadge;
		return t.publishedBadge;
	}

	async function fetchPage(target: number): Promise<MyCommentsBody> {
		const res = await fetch(`${BASE}/mine?page=${target}&pageSize=${PAGE_SIZE}`, {
			headers: { accept: 'application/json' }
		});
		if (!res.ok) throw new Error(String(res.status));
		return (await res.json()) as MyCommentsBody;
	}

	async function load(target = 1) {
		loading = true;
		failed = false;
		try {
			const body = await fetchPage(target);
			const data = body.data ?? [];
			items = target === 1 ? data : [...items, ...data];
			total = body.total ?? data.length;
			page = body.page ?? target;
			loaded = true;
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	async function toggle() {
		if (!open) await ensureMessages();
		open = !open;
		if (open && !loaded) await load(1);
	}

	function close() {
		open = false;
	}

	function onPointerDown(event: PointerEvent) {
		if (!open) return;
		const target = event.target;
		if (target instanceof Node && rootEl?.contains(target)) return;
		close();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !open) return;
		close();
		toggleEl?.focus();
	}

	function csrfHeaders(): Record<string, string> {
		return { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() };
	}

	function startEdit(item: MyCommentItem) {
		editingId = item.id;
		editText = item.content;
		flash = '';
	}

	function cancelEdit() {
		editingId = null;
		editText = '';
	}

	async function saveEdit(item: MyCommentItem) {
		const content = editText.trim();
		if (!content || busyId) return;
		busyId = item.id;
		try {
			const res = await fetch(`${BASE}/edit`, {
				method: 'POST',
				headers: csrfHeaders(),
				body: JSON.stringify({ id: item.id, content })
			});
			if (!res.ok) {
				flash = t.editedFailed;
				return;
			}
			const body = (await res.json()) as { content?: string; status?: string };
			items = items.map((it) =>
				it.id === item.id
					? { ...it, content: body.content ?? content, status: body.status ?? it.status }
					: it
			);
			cancelEdit();
			onchanged?.();
		} catch {
			flash = t.editedFailed;
		} finally {
			busyId = null;
		}
	}

	async function remove(item: MyCommentItem) {
		if (busyId || !confirm(t.deleteConfirm)) return;
		busyId = item.id;
		try {
			const res = await fetch(`${BASE}/delete`, {
				method: 'POST',
				headers: csrfHeaders(),
				body: JSON.stringify({ id: item.id })
			});
			if (!res.ok) {
				flash = t.failed;
				return;
			}
			items = items.filter((it) => it.id !== item.id);
			total = Math.max(0, total - 1);
			onchanged?.();
		} catch {
			flash = t.failed;
		} finally {
			busyId = null;
		}
	}
</script>

<svelte:window onpointerdown={onPointerDown} onkeydown={onKeydown} />

<div class="my-comments" bind:this={rootEl}>
	<button
		type="button"
		class="my-toggle"
		class:is-open={open}
		bind:this={toggleEl}
		aria-expanded={open}
		aria-controls="my-comments-panel"
		onclick={toggle}
	>
		{t.myComments}
		{#if total > 0}<span class="my-count">{total}</span>{/if}
	</button>

	{#if open}
		<div class="my-panel" id="my-comments-panel">
			<p class="my-hint">{t.myCommentsHint}</p>
			<p class="my-hint">{t.myCommentsAccountHint}</p>
			{#if loading && items.length === 0}
				<p class="my-note">…</p>
			{:else if failed}
				<p class="my-note is-danger">{t.myCommentsLoadFailed}</p>
			{:else if items.length === 0}
				<p class="my-note">{t.myCommentsEmpty}</p>
			{:else}
				<ul class="my-list">
					{#each items as item (item.id)}
						<li class="my-item">
							<div class="my-head">
								<span
									class="my-status"
									class:is-pending={item.status === 'pending'}
									class:is-hidden={item.status === 'spam'}
								>
									{statusLabel(item.status)}
								</span>
								{#if item.path}
									<a class="my-path" href={item.path}>{item.path}</a>
								{/if}
								<time class="my-time">{timeOf(item.createdAt)}</time>
							</div>
							{#if editingId === item.id}
								<textarea
									class="my-input"
									bind:value={editText}
									rows="3"
									maxlength={maxLength}
									aria-label={t.edit}></textarea>
								<div class="my-actions">
									<button
										type="button"
										class="my-btn is-primary"
										disabled={busyId === item.id}
										onclick={() => saveEdit(item)}
									>
										{busyId === item.id ? '…' : t.save}
									</button>
									<button type="button" class="my-btn" onclick={cancelEdit}>{t.cancel}</button>
								</div>
							{:else}
								<p class="my-content">{item.content}</p>
								<div class="my-actions">
									{#if item.status !== 'spam'}
										<button type="button" class="my-btn" onclick={() => startEdit(item)}>
											{t.edit}
										</button>
									{/if}
									<button
										type="button"
										class="my-btn is-danger"
										disabled={busyId === item.id}
										onclick={() => remove(item)}
									>
										{t.del}
									</button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
				{#if total > items.length}
					<button
						type="button"
						class="my-btn my-more"
						disabled={loading}
						onclick={() => load(page + 1)}
					>
						{loading ? '…' : t.loadMore}
					</button>
				{/if}
			{/if}
			{#if flash}<p class="my-note is-danger">{flash}</p>{/if}
		</div>
	{/if}
</div>

<style>
	.my-comments {
		position: relative;
		display: inline-flex;
	}

	.my-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1, 0.25rem);
		padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
		font-family: inherit;
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary);
		background: transparent;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		cursor: pointer;
		transition:
			color var(--transition-fast, 0.18s ease),
			border-color var(--transition-fast, 0.18s ease);
	}
	.my-toggle:hover,
	.my-toggle.is-open {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.my-count {
		display: inline-flex;
		min-width: 1.25rem;
		height: 1.25rem;
		align-items: center;
		justify-content: center;
		padding: 0 var(--space-1, 0.25rem);
		font-size: var(--text-xs, 0.75rem);
		font-variant-numeric: tabular-nums;
		line-height: 1;
		color: #fff;
		background: var(--color-primary);
		border-radius: 999px;
	}

	/* 面板：贴在入口下方，窄屏铺满容器；高度受限时内部滚动 */
	.my-panel {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 20;
		width: min(360px, calc(100vw - 2rem));
		max-height: 60vh;
		overflow-x: hidden;
		overflow-y: auto;
		padding: var(--space-3, 0.75rem);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 0.5rem);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--color-text-muted) 35%, transparent) transparent;
	}

	.my-panel::-webkit-scrollbar {
		width: 6px;
		height: 6px;
	}

	.my-panel::-webkit-scrollbar-track {
		background: transparent;
	}

	.my-panel::-webkit-scrollbar-thumb {
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-text-muted) 35%, transparent);
	}

	.my-panel::-webkit-scrollbar-thumb:hover {
		background: color-mix(in srgb, var(--color-text-muted) 55%, transparent);
	}

	.my-hint {
		margin-bottom: var(--space-2, 0.5rem);
		font-size: var(--text-xs, 0.75rem);
		line-height: 1.6;
		color: var(--color-text-muted);
	}

	.my-note {
		margin: var(--space-2, 0.5rem) 0;
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary);
	}
	.my-note.is-danger {
		color: var(--c-danger, #dc2626);
	}

	.my-list {
		display: grid;
		gap: var(--space-2, 0.5rem);
		min-width: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.my-item {
		min-width: 0;
		padding: var(--space-2, 0.5rem);
		border: 1px solid var(--color-border-light);
		border-radius: var(--radius-sm, 0.375rem);
	}

	.my-head {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2, 0.5rem);
		align-items: center;
		min-width: 0;
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-muted);
	}

	.my-status {
		padding: 0 var(--space-1, 0.25rem);
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary, var(--color-bg));
		border-radius: 999px;
	}
	.my-status.is-pending {
		color: var(--color-primary);
	}
	.my-status.is-hidden {
		color: var(--c-danger, #dc2626);
	}

	.my-path {
		flex: 1 1 8rem;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-secondary);
		text-decoration: none;
	}
	.my-path:hover {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.my-time {
		flex: 0 0 auto;
		margin-left: auto;
		white-space: nowrap;
	}

	.my-content {
		margin-top: var(--space-1, 0.25rem);
		font-size: var(--text-sm, 0.875rem);
		line-height: 1.6;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.my-input {
		width: 100%;
		margin-top: var(--space-1, 0.25rem);
		padding: var(--space-2, 0.5rem);
		font-family: inherit;
		font-size: var(--text-sm, 0.875rem);
		color: var(--color-text);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm, 0.375rem);
		resize: vertical;
	}
	.my-input:focus {
		outline: none;
		border-color: var(--color-primary);
	}

	.my-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2, 0.5rem);
		margin-top: var(--space-2, 0.5rem);
	}

	.my-btn {
		padding: 0;
		font-family: inherit;
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-muted);
		background: none;
		border: none;
		cursor: pointer;
	}
	.my-btn:hover {
		color: var(--color-primary);
	}
	.my-btn.is-primary {
		padding: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
		color: #fff;
		background: var(--color-primary);
		border-radius: var(--radius-sm, 0.375rem);
	}
	.my-btn.is-danger:hover {
		color: var(--c-danger, #dc2626);
	}
	.my-more {
		width: 100%;
		margin-top: var(--space-2, 0.5rem);
		padding: var(--space-1, 0.25rem);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-sm, 0.375rem);
		text-align: center;
	}

	/* 窄屏：面板改成静态块，跟着标题下方铺开，避免浮层超出视口 */
	@media (max-width: 760px) {
		.my-comments {
			display: flex;
			width: 100%;
			flex: 1 0 100%;
			flex-direction: column;
			align-items: flex-end;
		}
		.my-panel {
			position: static;
			width: 100%;
			max-height: 70vh;
			margin-top: var(--space-2, 0.5rem);
			align-self: stretch;
		}
	}
</style>
