/**
 * 评论插件内容级控制服务。
 *
 * 三件套：
 * - resolve(contentId, claimed)：claimed 是主题模板注入的集合 slug，此处
 *   用内容引擎反查 contentId 确认归属——防客户端伪造；查不到则视为类型未知，
 *   由站点级开关的「白名单留空 = 不限制」语义兜底。
 * - get(contentId, contentType?) / set(contentId, patch, contentType?)：
 *   plugin_comments_content_settings 按 (contentType, contentId) 单行存储；
 *   无记录 = 全 false（不限制）。类型判别防跨集合同 id 串读（SYSTEM_COLUMNS
 *   不含 id，导入/自定义 id 可撞）；读侧经 _$or 兼容历史行与未声明类型的
 *   查询（contentType 为 null 的行匹配任意类型），写侧在调用方声明类型时
 *   优先落带类型的行。
 *
 * set 是 patch 语义：patch 中省略的字段保持当前值；这与管理员 UI 的
 * POST /admin/content-settings 行为一致（仅显式给出的字段生效）。
 */
import type { PluginContext } from '#lib/cms/types/plugin.ts';
import { normalizeId } from './validate';

/** 内容级设置三字段（创作者控制） */
export interface ContentSettings {
	closed: boolean;
	requireLogin: boolean;
	featuredOnly: boolean;
}

/** 三字段 patch：仅出现的字段被更新 */
export interface ContentSettingsPatch {
	closed?: boolean;
	requireLogin?: boolean;
	featuredOnly?: boolean;
}

export interface ContentSettingsService {
	/** 校验集合 slug 归属；contentId / claimed 缺失或反查失败均返回 null */
	resolve(contentId: string | null, claimed: string | null): Promise<string | null>;
	/** 读取该内容项的设置；无记录 → 全 false。contentType 省略 = 任意类型（历史口径） */
	get(contentId: string, contentType?: string | null): Promise<ContentSettings>;
	/** patch 语义写入（仅 patch 中出现的字段被更新，缺失字段保持当前值） */
	set(contentId: string, patch: ContentSettingsPatch, contentType?: string | null): Promise<void>;
}

interface ContextWithDb {
	db: Pick<PluginContext['db'], 'find' | 'create' | 'update'>;
	content?: PluginContext['content'];
}

export function createContentSettingsService(ctx: ContextWithDb): ContentSettingsService {
	/**
	 * 内部读取单行（无记录 → null）。带类型时经 _$or 命中「同类型行 + 历史
	 * 空类型行」（旧行无 content_type，不能被新判别读丢）；不带类型 = 旧口径。
	 */
	async function readRow(contentId: string, contentType?: string | null) {
		const filter: Record<string, unknown> = contentType
			? {
					_$or: [
						{ contentId, contentType },
						{ contentId, contentType: null }
					]
				}
			: { contentId };
		const page = await ctx.db.find('plugin_comments_content_settings', {
			filter,
			limit: 1
		});
		return page.data[0] as Record<string, unknown> | undefined;
	}

	return {
		async resolve(contentId, claimed) {
			if (!claimed || !contentId || !ctx.content) return null;
			const record = await ctx.content.findById(claimed, contentId);
			return record ? claimed : null;
		},
		async get(contentId, contentType) {
			const row = await readRow(contentId, contentType);
			return {
				closed: row?.closed === true,
				requireLogin: row?.requireLogin === true,
				featuredOnly: row?.featuredOnly === true
			};
		},
		async set(contentId, patch, contentType) {
			const id = normalizeId(contentId);
			if (!id) return;
			const current = await readRow(id, contentType);
			const values: ContentSettings = {
				closed: patch.closed !== undefined ? patch.closed : current?.closed === true,
				requireLogin:
					patch.requireLogin !== undefined ? patch.requireLogin : current?.requireLogin === true,
				featuredOnly:
					patch.featuredOnly !== undefined ? patch.featuredOnly : current?.featuredOnly === true
			};
			if (current?.id) {
				// 展开为普通对象——interface 无索引签名，不满足 db.update 的
				// Record<string, unknown> 形参
				await ctx.db.update('plugin_comments_content_settings', String(current.id), {
					...values
				});
			} else {
				await ctx.db.create('plugin_comments_content_settings', {
					contentId: id,
					...(contentType ? { contentType } : {}),
					...values
				});
			}
		}
	};
}
