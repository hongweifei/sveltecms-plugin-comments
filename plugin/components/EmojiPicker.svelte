<!--
	Emoji 选择浮层（顶层评论与回复表单共用）。

	此前两处浮层模板逐字重复。浮层的定位逻辑（is-flip：右缘对齐时向左展开）
	与按钮样式都归本组件自带——父组件的 scoped 样式带作用域哈希，匹配不到
	子组件的根元素（拆组件后 Svelte 报 unused selector）。

	样式变量全部带 fallback：宿主未提供对应令牌时不至于塌陷（详见 shared.ts
	顶部关于 Tailwind 命名变量的说明）。
-->
<script lang="ts">
	import { EMOJIS } from '../client/emoji';

	interface Props {
		/** 右缘对齐时向左展开（避免浮层溢出视口） */
		flip?: boolean;
		/** 选中某个 emoji */
		onpick: (code: string) => void;
	}

	let { flip = false, onpick }: Props = $props();
</script>

<div class="emoji-picker" class:is-flip={flip}>
	{#each EMOJIS as e (e)}
		<button type="button" onclick={() => onpick(e)}>{e}</button>
	{/each}
</div>

<style>
	/* 浮层：锚在 emoji 按钮上方，展开不占文档流、不顶起表单 */
	.emoji-picker {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 0;
		z-index: 20;
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		width: 264px;
		padding: var(--space-2, 0.5rem);
		border: 1px solid var(--color-border-light);
		border-radius: var(--radius-md, 0.5rem);
		background: var(--color-surface);
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
	}

	/* 空间不足时（按钮距表单右缘 < 面板宽）贴右缘向左展开 */
	.emoji-picker.is-flip {
		left: auto;
		right: 0;
	}

	.emoji-picker button {
		width: 32px;
		height: 32px;
		font-size: var(--text-lg, 1.125rem);
		line-height: 1;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm, 0.375rem);
		cursor: pointer;
	}

	.emoji-picker button:hover {
		background: var(--color-bg-tertiary);
	}

	/* 窄容器自适应：评论区所在容器变窄时面板收窄（容器查询挂在父组件的
	   .sc-comments 上，此处读其 inline-size 变量） */
	@container comments (max-width: 480px) {
		.emoji-picker {
			width: min(264px, 90cqw);
		}
	}
</style>
