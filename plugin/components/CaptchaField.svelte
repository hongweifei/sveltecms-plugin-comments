<!--
	验证码输入块（顶层评论与回复表单共用）。

	此前两处模板逐字重复（主表单 / 行内回复），改一处忘另一处的风险实在——
	例如加「语音验证码」分支时只改了一边，两个入口行为分叉。抽成组件后
	两处共用同一实现。

	样式由本组件自带：父组件的 scoped 样式带作用域哈希，匹配不到子组件的
	根元素（拆组件后 Svelte 会报 unused selector）。样式变量全部带
	fallback——宿主未提供对应令牌时不至于塌陷。
-->
<script lang="ts">
	interface Props {
		/** 服务端自生成的 SVG（可信内容） */
		svg: string;
		/** 当前输入（双向绑定） */
		answer: string;
		/** 刷新挑战中 */
		loading?: boolean;
		/** 输入框的 aria-label / placeholder */
		label: string;
		/** 点击「↻」重新取挑战 */
		onrefresh: () => void;
	}

	let { svg, answer = $bindable(), loading = false, label, onrefresh }: Props = $props();
</script>

<div class="captcha-row">
	{#if svg}
		<!-- 服务端自生成 SVG，可信内容 -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<div class="captcha-svg">{@html svg}</div>
	{:else}
		<div class="captcha-svg captcha-loading">…</div>
	{/if}
	<!-- 刷新按钮紧跟验证码图（窄屏换行时与图同排，语义就近） -->
	<button type="button" class="btn btn-sm captcha-refresh" disabled={loading} onclick={onrefresh}>
		↻
	</button>
	<input
		class="captcha-input"
		type="text"
		bind:value={answer}
		maxlength="10"
		required
		autocomplete="off"
		aria-label={label}
		placeholder={label}
	/>
</div>

<style>
	.captcha-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 0.5rem);
		margin-top: var(--space-2, 0.5rem);
		min-width: 0;
	}

	.captcha-svg {
		flex: none;
		max-width: 100%;
		display: flex;
		align-items: center;
		overflow: hidden;
		border: 1px solid var(--color-border-light);
		border-radius: var(--radius-md, 0.5rem);
		background: #f3f4f6;
	}
	/* 服务端 SVG 经 {@html} 注入，无作用域哈希——用 :global 限高并随容器缩放 */
	.captcha-svg :global(svg) {
		display: block;
		max-width: 100%;
		height: auto;
	}

	.captcha-svg.captcha-loading {
		width: 132px;
		height: 56px;
		justify-content: center;
		color: var(--color-text-secondary);
	}

	/* 输入框样式自持：父组件的 .field 带作用域哈希，匹配不到本组件的元素。
	   弹性基线 140px + min-width:0：窄容器里随行收窄，图与输入同排时不被撑破。 */
	.captcha-input {
		flex: 1 1 140px;
		min-width: 0;
		padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
		font-family: inherit;
		font-size: var(--text-sm, 0.875rem);
		color: var(--color-text);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm, 0.375rem);
	}
	.captcha-input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--color-primary-light);
	}
	.captcha-input::placeholder {
		color: var(--color-text-muted);
	}

	.captcha-refresh {
		flex: none;
	}
</style>
