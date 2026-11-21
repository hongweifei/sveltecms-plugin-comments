/**
 * pages 记录 ↔ 公共路径双向解析（评论绑定桥）。
 *
 * 站点白名单的 enabledPaths 配的是「路径」（如 /enterprise），而内容级设置
 * （closed / requireLogin / featuredOnly）按 contentId 存储消费。要让「配置了
 * /enterprise 路径白名单」的页面在编辑时显示评论设置、且设置真实生效，必须
 * 打通 path ↔ 记录 id 的换算——本服务即这座桥，口径与后台配置器的
 * buildPagePaths 完全一致（parentId 链拼 slug，seen 防环、最深 10 级）。
 *
 * 两个方向：
 * - pathToRecordId(path)：path→id（/list path 绑定下解析内容级设置、/submit
 *   的 closed 门同口径）。全量拉 pages 建映射，60s TTL 缓存——pages 量级小
 *   （buildPagePaths 同款 limit 500），路径改动静态可接受。
 * - recordPath(id)：id→path（/admin/eligible 判定编辑表单是否显示设置）。
 *   沿 parentId 链 findById 上溯，仅两表未命中时调用，成本有界。
 */
import type { PluginContext } from '#lib/cms/types/plugin.ts';
import { normalizePagePath } from './validate';

interface PageNode {
	slug: string;
	parentId: string | null;
}

const PAGES_LIMIT = 500;
const MAP_TTL_MS = 60_000;
const MAX_DEPTH = 10;

export function createPagePathService(ctx: PluginContext) {
	let cache: { at: number; byId: Map<string, PageNode>; byPath: Map<string, string> } | null =
		null;

	/** id → '/'-joined slug 链（同 buildPagePaths：seen 以 id 防环，深度截断） */
	function joinPath(byId: Map<string, PageNode>, id: string): string | null {
		const segments: string[] = [];
		let cur: string | null = id;
		const seen = new Set<string>();
		while (cur && byId.has(cur) && !seen.has(cur) && segments.length <= MAX_DEPTH) {
			seen.add(cur);
			// 显式标注：node 的类型经 cur = node.parentId 参与 cur 的控制流
			// 推断，循环引用下 TS 拒绝自动推断
			const node: PageNode = byId.get(cur)!;
			segments.unshift(node.slug);
			cur = node.parentId;
		}
		// 链断裂（parentId 指向不存在的行）→ 不产出部分路径（防错绑到前缀）
		if (cur && !byId.has(cur)) return null;
		return segments.length > 0 ? '/' + segments.join('/') : null;
	}

	/** 60s TTL 全量缓存：byId（正向拼路径）+ byPath（反查 id），两向共用 */
	async function ensure(): Promise<{
		byId: Map<string, PageNode>;
		byPath: Map<string, string>;
	}> {
		if (cache && Date.now() - cache.at < MAP_TTL_MS) return cache;
		const byId = new Map<string, PageNode>();
		const byPath = new Map<string, string>();
		try {
			const res = await ctx.db.find('pages', { limit: PAGES_LIMIT });
			for (const r of res.data as Array<Record<string, unknown>>) {
				if (typeof r.id !== 'string' || typeof r.slug !== 'string' || !r.slug) continue;
				byId.set(r.id, {
					slug: r.slug,
					parentId: typeof r.parentId === 'string' && r.parentId ? r.parentId : null
				});
			}
			for (const id of byId.keys()) {
				const path = joinPath(byId, id);
				// 键统一用归一形态（解码百分号编码、去尾斜杠）：评论绑定侧的 path
				// 已经是归一值，pages 的 slug 若含中文则以原文拼出，两边同口径才能命中
				const key = path ? normalizePagePath(path) : null;
				if (key) byPath.set(key, id);
			}
		} catch (e) {
			ctx.logger.error(`comments: page path map build failed: ${String(e)}`);
		}
		cache = { at: Date.now(), byId, byPath };
		return cache;
	}

	return {
		/** path（如 '/enterprise'）→ pages 记录 id；查不到返回 null */
		async pathToRecordId(path: string): Promise<string | null> {
			const { byPath } = await ensure();
			const key = normalizePagePath(path);
			return key ? (byPath.get(key) ?? null) : null;
		},
		/** pages 记录 id → 公共路径（'/xxx'）；行缺失/链断裂返回 null */
		async recordPath(id: string): Promise<string | null> {
			const { byId } = await ensure();
			const path = joinPath(byId, id);
			return path ? normalizePagePath(path) : null;
		},
		/** 配置改动（如后台重排页面）后主动失效缓存 */
		invalidate() {
			cache = null;
		}
	};
}
