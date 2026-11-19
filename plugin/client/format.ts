/**
 * 前台纯展示工具：无状态、无网络、无 DOM 写副作用，可独立单测。
 *
 * 与服务端逻辑分离：这些函数只在客户端组件里用，但抽出后既能被组件引用，
 * 也能被测试直接断言——此前它们埋在 1600 行的 .svelte 里，无法单测。
 */

/** 相对时间的词表（key 对应 i18n 词条，占位符 {n} 为计数） */
export interface RelativeTimeWords {
	justNow: string;
	minutesAgo: string;
	hoursAgo: string;
	daysAgo: string;
}

/**
 * 相对时间格式化。
 *
 * 时区陷阱：SQLite CURRENT_TIMESTAMP 产出的是 UTC 的 'YYYY-MM-DD HH:MM:SS'
 * （无时区标记）；直接 new Date() 会被 V8 当本地时间解析——东八区即差 8 小时，
 * 刚发的评论显示成「8 小时前」。故对无时区标记的形态补 T/Z 显式按 UTC 解析。
 *
 * 文案由调用方从 i18n 词表传入（不内置中英）——组件里硬编码双语时，站点
 * 接入第三语言就无从扩展。
 */
export function formatRelativeTime(
	iso: string,
	words: RelativeTimeWords,
	now = Date.now()
): string {
	try {
		const raw = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)
			? `${iso.replace(' ', 'T')}Z`
			: iso;
		const d = new Date(raw);
		if (Number.isNaN(d.getTime())) return iso;
		const mins = Math.floor((now - d.getTime()) / 60000);
		if (mins < 1) return words.justNow;
		if (mins < 60) return words.minutesAgo.replace('{n}', String(mins));
		const hours = Math.floor(mins / 60);
		if (hours < 24) return words.hoursAgo.replace('{n}', String(hours));
		const days = Math.floor(hours / 24);
		if (days < 7) return words.daysAgo.replace('{n}', String(days));
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	} catch {
		return iso;
	}
}

/**
 * 昵称首字母（无头像时的色块占位）：多字节字符取第一个码位，
 * 英文取首字母大写。
 */
export function letterOf(name: string | null): string {
	const n = (name ?? '').trim();
	if (!n) return '?';
	const first = [...n][0] ?? '?';
	return first.toUpperCase();
}

/**
 * 昵称 → 稳定的色相（同一昵称恒得同色）。
 *
 * 用码点累加而非 charCodeAt(0)：中文昵称取首字色相分布更均匀——
 * 仅用首字时「张」「李」「王」等高频字会挤在同一色相。
 */
export function hueOf(name: string | null): number {
	const n = (name ?? '').trim();
	if (!n) return 0;
	let hash = 0;
	for (const ch of n) hash = (hash + ch.codePointAt(0)!) % 360;
	return hash;
}
