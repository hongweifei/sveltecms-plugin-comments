/**
 * 前台纯展示工具的单测：formatRelativeTime / letterOf / hueOf。
 *
 * 这些函数此前埋在 1600 行的 .svelte 里，无法单测——相对时间的时区陷阱
 * （UTC 无标记串被当本地时间解析）正是靠这类断言兜住的。
 */
import { describe, expect, it } from 'vitest';
import { formatRelativeTime, letterOf, hueOf } from './format';

const WORDS = {
	justNow: '刚刚',
	minutesAgo: '{n} 分钟前',
	hoursAgo: '{n} 小时前',
	daysAgo: '{n} 天前'
};

describe('formatRelativeTime', () => {
	// 固定基准时刻：2026-01-02T03:04:05Z
	const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

	it('一小时内显示分钟', () => {
		const iso = new Date(NOW - 5 * 60000).toISOString();
		expect(formatRelativeTime(iso, WORDS, NOW)).toBe('5 分钟前');
	});

	it('不足一分钟显示「刚刚」', () => {
		const iso = new Date(NOW - 30_000).toISOString();
		expect(formatRelativeTime(iso, WORDS, NOW)).toBe('刚刚');
	});

	it('一小时内按分钟取整', () => {
		const iso = new Date(NOW - 59 * 60000).toISOString();
		expect(formatRelativeTime(iso, WORDS, NOW)).toBe('59 分钟前');
	});

	it('不足一天显示小时', () => {
		const iso = new Date(NOW - 3 * 3600_000).toISOString();
		expect(formatRelativeTime(iso, WORDS, NOW)).toBe('3 小时前');
	});

	it('不足一周显示天数', () => {
		const iso = new Date(NOW - 2 * 86400_000).toISOString();
		expect(formatRelativeTime(iso, WORDS, NOW)).toBe('2 天前');
	});

	it('超过一周回落本地日期', () => {
		const iso = new Date(NOW - 30 * 86400_000).toISOString();
		const out = formatRelativeTime(iso, WORDS, NOW);
		expect(out).not.toMatch(/前$/);
		expect(out.length).toBeGreaterThan(0);
	});

	it('SQLite CURRENT_TIMESTAMP 形态（UTC 无时区标记）按 UTC 解析', () => {
		// 'YYYY-MM-DD HH:MM:SS' 是 UTC；若被当本地时间解析，东八区会差 8 小时
		const iso = '2026-01-02 03:00:00';
		// 基准取该时刻之后 4 分钟 → 应显示 4 分钟前（若按本地解析则为 236 分钟前）
		expect(formatRelativeTime(iso, WORDS, Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('4 分钟前');
	});

	it('非法输入原样返回', () => {
		expect(formatRelativeTime('not-a-date', WORDS, NOW)).toBe('not-a-date');
	});

	it('占位符按计数替换', () => {
		const iso = new Date(NOW - 7 * 60000).toISOString();
		const out = formatRelativeTime(iso, { ...WORDS, minutesAgo: 'min {n}' }, NOW);
		expect(out).toBe('min 7');
	});
});

describe('letterOf', () => {
	it('取昵称首字', () => {
		expect(letterOf('尘跃')).toBe('尘');
	});

	it('英文首字母大写', () => {
		expect(letterOf('alice')).toBe('A');
	});

	it('空昵称回退问号', () => {
		expect(letterOf(null)).toBe('?');
		expect(letterOf('   ')).toBe('?');
	});
});

describe('hueOf', () => {
	it('同一昵称恒得同色相', () => {
		expect(hueOf('尘跃')).toBe(hueOf('尘跃'));
	});

	it('色相落在 0-359', () => {
		for (const n of ['a', '张三', 'user-123', '🚀']) {
			const h = hueOf(n);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
		}
	});

	it('空昵称回退 0', () => {
		expect(hueOf(null)).toBe(0);
	});
});
