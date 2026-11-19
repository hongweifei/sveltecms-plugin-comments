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
	<input
		class="field field-sm"
		type="text"
		bind:value={answer}
		maxlength="10"
		required
		autocomplete="off"
		aria-label={label}
		placeholder={label}
	/>
	<button type="button" class="btn btn-sm" disabled={loading} onclick={onrefresh}>
		↻
	</button>
</div>

<style>
	.captcha-row {
		display: flex;
		align-items: center;
		gap: var(--space-2, 0.5rem);
		margin-top: var(--space-2, 0.5rem);
	}

	.captcha-svg {
		flex: none;
		display: flex;
		align-items: center;
		overflow: hidden;
		border: 1px solid var(--color-border-light);
		border-radius: var(--radius-md, 0.5rem);
		background: #f3f4f6;
	}

	.captcha-svg.captcha-loading {
		width: 132px;
		height: 56px;
		justify-content: center;
		color: var(--color-text-secondary);
	}
</style>
