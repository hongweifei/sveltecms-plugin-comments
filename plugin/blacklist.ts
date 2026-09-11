/**
 * 评论插件关键词黑名单服务。
 *
 * plugin_comments_settings 表单纯作为插件 KV 存储：blacklist 一项以逗号分隔字符串
 * 落库（与 parseBlacklist 的输入格式同构，便于管理端直接回显与覆盖）。
 * get / set 对外暴露 keywords 数组形态；set 接受原始字符串（管理端表单传出），
 * 也接受数组（程序内构造）——内部一律按 parseBlacklist 归一再 join 落库。
 *
 * 命中判定由端点侧直接调用 validate.matchBlacklist，不在服务内（match 是无状态
 * 字符串操作，不属于本服务的存储责任面）。
 */
import type { PluginContext } from '$lib/cms/types/plugin';
import { parseBlacklist } from './validate';

const KEY = 'blacklist';

interface ContextWithDb {
	db: Pick<PluginContext['db'], 'find' | 'create' | 'update'>;
}

export interface BlacklistService {
	/** 读取关键词列表；缺省 → 空数组 */
	get(): Promise<string[]>;
	/**
	 * 写入关键词列表。
	 * 接受 string（管理端逗号 / 换行分隔原始串）或 string[]（程序内构造），
	 * 内部归一为去重 / 小写 / trim 后落库。
	 */
	set(value: string | string[]): Promise<void>;
}

export function createBlacklistService(ctx: ContextWithDb): BlacklistService {
	/** plugin_comments_settings 单行（无记录 → null） */
	async function readSettingRow() {
		const page = await ctx.db.find('plugin_comments_settings', {
			filter: { key: KEY },
			limit: 1
		});
		return page.data[0];
	}

	return {
		async get() {
			const row = await readSettingRow();
			const value = (row as { value?: unknown } | undefined)?.value;
			return parseBlacklist(typeof value === 'string' ? value : '');
		},
		async set(value) {
			const keywords = parseBlacklist(typeof value === 'string' ? value : value.join('\n'));
			const existing = await readSettingRow();
			if (existing && (existing as { id?: unknown }).id) {
				await ctx.db.update('plugin_comments_settings', String((existing as { id: unknown }).id), {
					value: keywords.join(',')
				});
			} else {
				await ctx.db.create('plugin_comments_settings', { key: KEY, value: keywords.join(',') });
			}
		}
	};
}
