import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { baseColumns } from '$lib/cms/db/schema-helpers';

/**
 * 评论主表。绑定双键：path（页面路径）与 contentId（内容项 ID）至少其一；
 * parentId 指向同绑定下的父评论（任意层级，无限嵌套）；rootId 指向所在
 * 根评论（顶层评论为 null，回复恒为根 id）——列表按顶层分页、后代按
 * rootId 一次性带出，前台递归组装整棵树。
 * 身份字段：email 仅存储（gravatar 头像源 + 管理端可见），对外只输出
 * md5 哈希；website 为访客主页。环境字段 os/browser/region 由服务端
 * 从 UA 与 IP 解析（twikoo 模式），解析失败留空。
 * 1.x 升级说明：path 由 NOT NULL 放宽为可空（仅 contentId 绑定的 headless
 * 场景）；SQLite 不能放宽既有约束，已装站点需重建表或保留 path 恒填——
 * 见 DEVELOPMENT.md「评论插件」升级小节。
 */
export const comments = sqliteTable(
	'plugin_comments_comments',
	{
		...baseColumns(),
		content: text('content').notNull(),
		authorName: text('author_name'),
		email: text('email'),
		// 遗留快照列：头像已改为 manifest 声明 'user' 系统表实时反查，不再写入；
		// 列保留作读取兜底（SQLite 无法无痛删列，插件表也无迁移路径）
		avatar: text('avatar'),
		website: text('website'),
		userId: text('user_id'),
		status: text('status').notNull().default('pending'),
		path: text('path'),
		// 内容类型判别（集合 slug）：contentId 跨集合不保证全局唯一
		// （SYSTEM_COLUMNS 不含 id，导入/自定义 id 可撞），仅按 content_id
		// 查询会让不同类型同 id 内容的评论区互串。存端取 resolve 校验过的
		// 归属类型（非客户端原值）；历史行空值 = 匹配任意类型（读兼容）。
		contentType: text('content_type'),
		contentId: text('content_id'),
		parentId: text('parent_id'),
		rootId: text('root_id'),
		official: integer('official', { mode: 'boolean' }).default(false).notNull(),
		// 精选标记（公众号模式）：内容级 featuredOnly 开启时，仅精选评论对外可见
		featured: integer('featured', { mode: 'boolean' }).default(false).notNull(),
		// A3：回复邮件幂等标记——待审回复在审核通过（status→approved）时补发给
		// 父作者后置真，避免同一回复因多次状态更新重复通知。默认 false。
		replyNotified: integer('reply_notified', { mode: 'boolean' }).default(false).notNull(),
		likes: integer('likes').default(0).notNull(),
		reports: integer('reports').default(0).notNull(),
		// C2：举报理由（最近若干条，JSON 字符串数组）——管理员在审核队列可见，
		// 不再"只知被举报三次、不知为何"。
		reportReasons: text('report_reasons'),
		os: text('os'),
		browser: text('browser'),
		region: text('region'),
		visitorId: text('visitor_id').notNull()
	},
	(table) => [
		index('plugin_comments_path_idx').on(table.path),
		index('plugin_comments_content_idx').on(table.contentId),
		index('plugin_comments_parent_idx').on(table.parentId),
		index('plugin_comments_root_idx').on(table.rootId),
		// C3-3：featuredOnly 内容的公开列表按 featured 过滤（公众号式精选）
		index('plugin_comments_featured_idx').on(table.featured)
	]
);

/**
 * 点赞去重：一条评论对一个身份至多一个赞（幂等的依据）。
 * B1：登录用户按 userId 去重（visitorId 的 IP+UA 哈希在同 NAT 下会串扰，
 * 不能作为登录身份的判据）；游客保留 visitorId 口径。
 */
export const commentLikes = sqliteTable('plugin_comments_likes', {
	...baseColumns(),
	commentId: text('comment_id').notNull(),
	userId: text('user_id'),
	visitorId: text('visitor_id').notNull()
});

/** 插件设置（键值）：blacklist = 逗号分隔的关键词黑名单，命中直接进 spam */
export const commentSettings = sqliteTable('plugin_comments_settings', {
	...baseColumns(),
	key: text('key').notNull(),
	value: text('value').default('').notNull()
});

/**
 * 内容级评论设置（创作者控制，公众号模式）：按 (contentType, contentId)
 * 一行——closed 关闭该内容评论；requireLogin 仅登录可评；featuredOnly 仅展示
 * 精选。无记录 = 全 false（不限制）。contentType 可空：历史行与未携带类型的
 * 写入按 contentId 全局匹配（读兼容）；新写行携带管理端声明的类型。
 */
export const commentContentSettings = sqliteTable('plugin_comments_content_settings', {
	...baseColumns(),
	contentId: text('content_id').notNull(),
	contentType: text('content_type'),
	closed: integer('closed', { mode: 'boolean' }).default(false).notNull(),
	requireLogin: integer('require_login', { mode: 'boolean' }).default(false).notNull(),
	featuredOnly: integer('featured_only', { mode: 'boolean' }).default(false).notNull()
});

// 导出 key 必须等于插件注册的集合 slug(comments),内容引擎按
// slug 经 schemaRegistry 查表;否则集合 CRUD 静默失效(引擎注册时强校验)。
// 辅助表的导出 key = 物理表名(plugin_comments_*):插件 ctx.db 的表白名单
// 按物理表名段匹配插件(SEC-5),且 provider 按同一 key 解析 drizzle 表。
export default {
	comments,
	plugin_comments_likes: commentLikes,
	plugin_comments_settings: commentSettings,
	plugin_comments_content_settings: commentContentSettings
};
