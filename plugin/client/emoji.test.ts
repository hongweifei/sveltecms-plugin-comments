import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import { EMOJIS } from './emoji';
import EmojiPicker from '../components/EmojiPicker.svelte';

/**
 * 表情候选表契约：选择浮层用 emoji 本身作 keyed each 的键
 * （`{#each EMOJIS as e (e)}`）——重复字符会让 Svelte 抛
 * each_key_duplicate，整块浮层渲染失败（线上表现为点开表情即 500）。
 */
describe('emoji 候选表', () => {
	it('无重复项（keyed each 以 emoji 为键）', () => {
		expect(new Set(EMOJIS).size).toBe(EMOJIS.length);
	});

	it('非空且都是非空字符串', () => {
		expect(EMOJIS.length).toBeGreaterThan(0);
		for (const e of EMOJIS) expect(e.trim().length).toBeGreaterThan(0);
	});

	it('选择浮层按候选数渲染按钮', () => {
		const { body } = render(EmojiPicker, { props: { onpick: () => {} } });
		expect((body.match(/<button/g) ?? []).length).toBe(EMOJIS.length);
	});
});
