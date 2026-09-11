<!--
	后台评论列表行操作：注册到框架列表插槽 collection-list-row-actions
	（ListPage 逐行传 contentType / row，row 为整行评论数据）。仅 comments
	集合渲染——「回复」按钮弹层，直连 /admin/reply：免审直发 + official 徽章
	+ 父作者邮件通知，与前台管理员回复同一端点同语义。

	挂楼三键（path/contentId/contentType）从行数据透传——服务端 bindingMatches
	权威校验父评论归属，透传值仅用于构造挂楼载荷，无伪造面（管理端登录态端点）。

	i18n 同其他组件：i18n.ts 注册、loadPluginMessages 取词（admin_ 前缀）。
-->
<script lang="ts">
	import Dialog from '$lib/common/components/ui/Dialog.svelte';
	import { showToast } from '$lib/common/utils/toast';
	import { getCsrfToken } from '$lib/common/utils/csrf';
	import { loadPluginMessages } from '$lib/cms/utils/i18n-client';
	import { Send, Reply } from '@lucide/svelte';

	let {
		contentType = undefined,
		row = undefined
	}: {
		contentType?: string;
		/** 整行记录（ListPage 逐行透传）；仅 comments 集合时有意义 */
		row?: Record<string, unknown>;
	} = $props();

	const BASE = '/api/v1/plugin/comments';

	let open = $state(false);
	let text = $state('');
	let sending = $state(false);

	let messages = $state<Record<string, string>>({});
	const tr = $derived((key: string) => messages[key] ?? key);
	const t = $derived({
		reply: tr('admin_reply'),
		replyTitle: tr('admin_replyTitle'),
		replySubtitle: tr('admin_replySubtitle'),
		replyTo: tr('admin_replyTo'),
		original: tr('admin_replyOriginal'),
		replyPlaceholder: tr('admin_replyPlaceholder'),
		send: tr('admin_replySend'),
		sending: tr('admin_replySending'),
		cancel: tr('admin_replyCancel'),
		escHint: tr('admin_replyEscapeHint'),
		sent: tr('admin_replySent'),
		failed: tr('admin_replyFailed')
	});

	// 仅评论集合的行出操作（其他集合的列表行不渲染任何按钮）
	const isCommentRow = $derived(contentType === 'comments' && typeof row?.id === 'string');
	const authorPreview = $derived(
		typeof row?.authorName === 'string' && row.authorName ? row.authorName : tr('guest')
	);
	// 原评论摘要（弹层内引用块展示，给回复者上下文）
	const originalText = $derived(typeof row?.content === 'string' ? row.content.trim() : '');
	const excerpt = $derived(originalText.length > 160 ? `${originalText.slice(0, 160)}…` : originalText);

	$effect(() => {
		loadPluginMessages('comments').then((m) => (messages = m));
	});

	async function send() {
		const content = text.trim();
		if (!content || !row || sending) return;
		sending = true;
		try {
			const res = await fetch(`${BASE}/admin/reply`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
				body: JSON.stringify({
					content,
					parentId: String(row.id),
					// 挂楼绑定三键随行透传（服务端 bindingMatches 复核归属）
					path: (row.path as string | null) ?? null,
					contentId: (row.contentId as string | null) ?? null,
					contentType: (row.contentType as string | null) ?? undefined
				})
			});
			if (res.ok) {
				open = false;
				text = '';
				showToast(t.sent, 'success');
			} else {
				showToast(t.failed, 'error');
			}
		} catch {
			showToast(t.failed, 'error');
		} finally {
			sending = false;
		}
	}
</script>

{#if isCommentRow}
	<!-- 行操作单元格在 <td class="text-right ..."> 内：tabular 容器会继承 text-align/nowrap，
	     故弹层相关内容一律走 fixed 定位 + 容器内显式 text-left / whitespace-normal。 -->
	<button
		type="button"
		class="inline-flex items-center gap-1 px-2 py-1 text-sm rounded-[var(--radius-md)] text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 cursor-pointer"
		onclick={() => (open = true)}
	>
		<Reply class="h-3.5 w-3.5" />
		{t.reply}
	</button>

	<Dialog bind:open title={t.replyTitle} subtitle={t.replySubtitle}>
		<div class="text-left whitespace-normal">
			{#if excerpt}
				<figure
					class="mb-4 rounded-[var(--radius-md)] border-l-2 border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2"
				>
					<figcaption
						class="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]"
					>
						{t.original} · {authorPreview}
					</figcaption>
					<p class="text-sm leading-relaxed text-[var(--color-text-secondary)] line-clamp-3">
						{excerpt}
					</p>
				</figure>
			{/if}

			<textarea
				bind:value={text}
				rows="4"
				maxlength="500"
				placeholder={t.replyPlaceholder}
				class="w-full p-3 text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] resize-y focus:outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
			></textarea>

			<div class="gap-2 mt-4 flex items-center justify-end">
				<span class="mr-auto text-xs text-[var(--color-text-secondary)]">{t.escHint}</span>
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] cursor-pointer"
					onclick={() => (open = false)}>{t.cancel}</button
				>
				<button
					type="button"
					class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-white rounded-[var(--radius-md)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 cursor-pointer"
					disabled={sending || !text.trim()}
					onclick={send}
				>
					<Send class="h-3.5 w-3.5" />
					{sending ? t.sending : t.send}
				</button>
			</div>
		</div>
	</Dialog>
{/if}
