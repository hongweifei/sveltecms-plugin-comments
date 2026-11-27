import type { Plugin } from '#lib/cms/types/plugin.ts';
import { registerSchema } from '#lib/cms/utils/index.ts';
import type { CommentRow } from './helpers';
import { normalizePagePath, sanitizeAuthorName } from './validate';
import { bindingOf } from './helpers';

import { createConfigService } from './config';
import { createContentSettingsService } from './content-settings';
import { createBlacklistService } from './blacklist';
import { createClientInfoService } from './client-info';
import { createPagePathService } from './page-paths';
import { createApiDeps } from './deps';
import { createCountComments, registerPublicApi } from './api-public';
import { registerInteractionApi } from './api-interactions';
import { registerAdminApi } from './api-admin';
import { messages } from './i18n';
// 仅类型导入：把 `comments/count` 的形状并入框架服务契约表（declaration merging）
import type { CommentsCountService } from './service-count';

/**
 * 评论插件（官方范例 T3-3，v3）：
 * - 绑定双键：path（页面路径）与 contentId（内容项 ID）至少其一，两种绑定
 *   在提交/列表/计数全链路等价；
 * - 无限嵌套回复：parentId 指向同绑定下已审核父评论（任意层级），rootId
 *   恒指向所在根评论——列表按顶层分页、后代按 rootId 一次带出，前台平铺
 *   在根评论下一层（回复内容带「回复 @目标」前缀）；
 * - 访客身份：昵称（可选）/邮箱（必填，仅存储，对外只输出 gravatar 哈希）/
 *   主页（可选），服务端以 HttpOnly cookie 记住填写者（回访预填）；
 * - 访客账号渠道（框架 visitor_accounts / visitor_bindings）：微信 / QQ 授权登录
 *   挂到同一个访客 id 上，身份条列出已绑定渠道、未绑定渠道走 ?bind=1 绑定；
 *   解绑与两个账号的合并由框架账号页处理，合并只并身份、不迁历史评论；
 * - 环境信息（twikoo 模式）：服务端从 UA 解析系统/浏览器、从 IP 异步解析
 *   归属地（best-effort，失败留空）；
 * - 互动：点赞（comment_likes 按 visitor 去重）、举报（达阈值自动回待审）、
 *   删除自己的评论（登录者任意本人评论；游客限本人待审）；
 * - 自己的待审评论对自己可见（visitorId/userId 匹配，带「审核中」标记）；
 * - 站点级开关（manifest.config，纯白名单，站长职责）：只配置**开启**评论的
 *   页面路径与内容类型（集合 slug，经内容引擎校验归属），任一命中即开启，
 *   两列表留空 = 全站不开启；
 * - 内容级设置（创作者控制，plugin_comments_content_settings）：创作者在内容
 *   编辑表单自行关闭评论 / 仅登录可评 / 仅展示精选（featured，公众号式人工
 *   精选），经 collection-form-fields-after 插槽渲染；
 * - 管理员回复（/admin/reply，免审 + official 标记）与关键词黑名单设置；
 * - 新评论 emit `comments:submitted`（宿主/其他插件可订阅做通知——插件
 *   ctx 只能订阅 notification 且系统表不可达，管理员推送属宿主职责）。
 *
 * 扩展点组合：collection（审核工作台走通用内容 UI）+ api（public/admin 端点，
 * 非 public 自动经 requireAdminAccessApi）+ slot（前台 content-after）+
 * filters（本集合落库前归一）。
 *
 * 代码组织（A 方案端点域拆分后）——本文件存编排：manifest、集合定义、事件订阅、
 * beforeWrite filter 与端点接线；15 个端点 handler 按域拆到 api-public（提交与
 * 读链路）/ api-interactions（点赞举报删除编辑）/ api-admin（管理端六类），
 * register 闭包共享态（限流器、计数缓存、通知工具）收敛为 deps.ts 的 ApiDeps
 * 显式注入。跨端点公共层按职责拆到：
 * - helpers.ts（HTTP / binding / 公开投影、CommentRow 类型）
 * - config.ts（manifest.config 三型适配 + 站点级开关判定）
 * - content-settings.ts（内容类型反查 + 内容级设置读写）
 * - blacklist.ts（关键词黑名单 KV 存储）
 * - client-info.ts（UA / IP / 地区采集 + user 表反查 + gravatar）
 * - page-paths.ts（路径 ↔ pages 记录换算桥）
 * - validate.ts（输入归一 / 绑定 / 黑名单解析，纯函数层）
 */

/**
 * 服务端托管字段：绑定三键（path / contentType / contentId）由提交与回复链路
 * 写入，设备环境三项（os / browser / region）由 UA / IP 解析写入，内容归属
 * 由插件写入。后台编辑表单不渲染这七列（见字段 condition），管理端只做审核
 * 与正文修订；update 载荷里出现这些键一律丢弃，防止表单回填的 null 抹掉库内值。
 */
const SERVER_OWNED_FIELDS = [
	'path',
	'contentType',
	'contentId',
	'contentOwnerId',
	'os',
	'browser',
	'region',
	'visitorProvider'
] as const;

const plugin: Plugin = {
	manifest: {
		name: 'comments',
		version: '0.4.8',
		description: {
			zh: '页面/内容项评论：无限嵌套回复（root_id 锁定根评论）、分页、点赞、举报、gravatar 头像、访客账号与微信/QQ 渠道绑定、设备环境/地区、本人待审可见、管理员回复与关键词黑名单（官方插件范例）',
			en: 'Page/content comments: infinitely nested replies (root_id anchors the thread), pagination, likes, reports, gravatar avatars, visitor account with WeChat/QQ channel binding, device/region, own pending visibility, admin replies and keyword blacklist (reference official plugin)'
		},
		// 宿主兼容：框架 0.3 起插件 API（migrations / service / capability）为本插件
		// 的基线；0.x 阶段 minor 即破坏，0.2 站点继续用插件 0.3.x。
		engines: { cms: '^0.3' },
		// 自定义事件：插件默认只能发射自身命名空间，显式声明便于后台「事件」清单
		// 与审计核对（消费方据此订阅）。
		emits: ['comments:submitted'],
		// SEC-5 声明式系统表权限（只读）：user 表用于登录用户头像/昵称实时反查；
		// pages 表用于路径白名单 ↔ 记录换算（page-paths 桥：/list /count /submit
		// 的 path 绑定解析内容级设置 + /admin/eligible 判定）；roles 表用于官方标
		// 的身份判定（canPostOfficial：adminAccess 或 officialRoles 白名单，60s 缓存）。
		permissions: { readSystemTables: ['user', 'pages', 'roles'] },
		// 管理端插件页渲染 boolean 为「开 / 关」。配置值一律以字符串落库
		// （管理端表单一律字符串化），读取时布尔与字符串两种形态都认。
		// C3：label / placeholder 为 I18nText（{zh, en}），管理端按当前语言渲染
		// （框架 resolvePluginMetaI18n），英文后台不再显示中文。
		config: [
			{
				key: 'moderation',
				type: 'boolean',
				label: {
					zh: '评论审核（关闭则发布即公开）',
					en: 'Comment moderation (off = publish immediately)'
				},
				default: true
			},
			{
				key: 'allowGuest',
				type: 'boolean',
				label: {
					zh: '允许游客评论（关闭则仅登录用户可评论）',
					en: 'Allow guest comments (off = signed-in users only)'
				},
				default: true
			},
			{
				key: 'guestEmailOptional',
				type: 'boolean',
				label: {
					zh: '游客邮箱可留空（B2b：关闭则邮箱必填，作 gravatar 头像源）',
					en: 'Guest email optional (off = required, used as gravatar source)'
				},
				default: false
			},
			{
				key: 'hideEnv',
				type: 'boolean',
				label: {
					zh: '前台隐藏设备环境（B2a：系统/浏览器/IP 属地仅管理端可见）',
					en: 'Hide device info on frontend (OS/browser/IP region admin-only)'
				},
				default: false
			},
			{
				key: 'maxLength',
				type: 'number',
				label: {
					zh: '单条评论最大字数（0 = 不限）',
					en: 'Max characters per comment (0 = unlimited)'
				},
				default: 500,
				placeholder: '0'
			},
			{
				key: 'minInterval',
				type: 'number',
				label: {
					zh: '同一访客评论最小间隔秒数（0 = 不限）',
					en: 'Min interval between comments per visitor (0 = unlimited)'
				},
				default: 0,
				placeholder: '0'
			},
			{
				key: 'notifyReplies',
				type: 'boolean',
				label: {
					zh: '收到回复时邮件通知原作者',
					en: 'Email the original author on reply'
				},
				default: true
			},
			{
				key: 'notifyAuthor',
				type: 'boolean',
				label: {
					zh: '新评论通知内容作者（站内通知）',
					en: 'Notify content author of new comments (in-app)'
				},
				default: true
			},
			{
				key: 'enabledPaths',
				type: 'multiselect',
				source: 'pagePaths',
				allowCustom: true,
				label: {
					zh: '开启评论的页面路径',
					en: 'Page paths with comments enabled'
				},
				placeholder: {
					zh: '手动输入路径，如 /about',
					en: 'Enter a path, e.g. /about'
				},
				default: []
			},
			{
				key: 'enabledTypes',
				type: 'multiselect',
				source: 'contentTypes',
				label: {
					zh: '开启评论的内容类型',
					en: 'Content types with comments enabled'
				},
				default: []
			},
			{
				key: 'officialRoles',
				type: 'multiselect',
				allowCustom: true,
				label: {
					zh: '可发官方回复的角色（留空 = 仅超级管理员角色）',
					en: 'Roles allowed to post official comments (empty = adminAccess roles only)'
				},
				placeholder: {
					zh: '输入角色名后添加，如 editor',
					en: 'Enter a role name, e.g. editor'
				},
				default: []
			}
		]
	},

	async register(ctx) {
		const schema = (await import('./schema')).default;
		registerSchema(ctx.schema, schema);

		// 服务层：注册时构造，闭包持有 ctx
		const cfg = createConfigService(ctx);
		const contentSettings = createContentSettingsService(ctx);
		const blacklistService = createBlacklistService(ctx);
		const info = createClientInfoService(ctx);
		// path ↔ pages 记录换算桥（page-paths 服务）：路径白名单命中的页面，其
		// 内容级设置（closed/requireLogin/featuredOnly）与 eligible 判定共用
		const pagePaths = createPagePathService(ctx);

		ctx.collection.register({
			kind: 'collection',
			slug: 'comments',
			label: '评论',
			labelI18n: { en: 'Comments' },
			icon: 'MessageCircle',
			api: true,
			fields: [
				{
					name: 'content',
					type: 'textarea',
					required: true,
					label: '内容',
					labelI18n: { en: 'Content' }
				},
				{
					name: 'authorName',
					type: 'text',
					label: '昵称',
					labelI18n: { en: 'Name' },
					hint: '匿名评论显示为「访客」'
				},
				{
					name: 'email',
					type: 'text',
					label: '邮箱',
					labelI18n: { en: 'Email' },
					hint: '仅管理端可见，对外只输出 gravatar 哈希'
				},
				{
					name: 'website',
					type: 'text',
					label: '主页',
					labelI18n: { en: 'Website' }
				},
				{
					// 设备环境三项（os / browser / region）是提交时刻服务端从 UA 与 IP
					// 解析出的存证：列表可见，编辑表单不渲染（condition 恒不成立）。
					// 保存时由 beforeWrite 丢弃这些键，库内既有值保持不动。
					name: 'os',
					type: 'text',
					label: '操作系统',
					labelI18n: { en: 'OS' },
					condition: { field: 'id', value: '__never__' }
				},
				{
					name: 'browser',
					type: 'text',
					label: '浏览器',
					labelI18n: { en: 'Browser' },
					condition: { field: 'id', value: '__never__' }
				},
				{
					name: 'region',
					type: 'text',
					label: '地区',
					labelI18n: { en: 'Region' },
					condition: { field: 'id', value: '__never__' }
				},
				{
					// 绑定键三项（path / contentType / contentId）由服务端写入：提交时
					// 归一落库、回复时沿用父绑定。新建评论时填写绑定，既有评论只读——
					// condition 以「新建尚无 id」为条件（String(undefined) === 'undefined'），
					// 编辑时 id 已有值，字段不进表单，beforeWrite 同时丢弃对应载荷键。
					name: 'path',
					type: 'text',
					label: '页面路径',
					labelI18n: { en: 'Page Path' },
					condition: { field: 'id', value: undefined }
				},
				{
					// 内容类型判别（集合 slug）：contentId 跨集合不保证唯一，绑定查询
					// 带类型防串扰。由服务端提交/回复链路落库（新建评论时填写）
					name: 'contentType',
					type: 'text',
					label: '内容类型',
					labelI18n: { en: 'Content Type' },
					condition: { field: 'id', value: undefined }
				},
				{
					name: 'contentId',
					type: 'text',
					label: '内容项 ID',
					labelI18n: { en: 'Content ID' },
					condition: { field: 'id', value: undefined }
				},
				{
					// 访客登录来源（当前仅 wechat）：由提交链路按 locals.visitor
					// 写入，表单不渲染、编辑不覆盖；管理端列表可见，前台据此出徽章。
					name: 'visitorProvider',
					type: 'text',
					label: '登录来源',
					labelI18n: { en: 'Sign-in source' },
					condition: { field: 'id', value: '__never__' }
				},
				{
					// 内容归属：评论所属内容的作者标识。由服务端在提交与回复时写入，
					// 后台按它授予创作者审核权限（RBAC 条件 contentOwnerId = user.id）。
					// 表单恒不展示，仅作为授权与过滤依据。
					name: 'contentOwnerId',
					type: 'text',
					label: '内容归属',
					labelI18n: { en: 'Content owner' },
					hint: '评论所属内容的作者标识，由插件写入',
					condition: { field: 'id', value: '__never__' }
				},
				{
					name: 'status',
					type: 'select',
					required: true,
					label: '状态',
					labelI18n: { en: 'Status' },
					options: ['pending', 'approved', 'spam'],
					defaultValue: 'pending'
				},
				{
					// 官方标（可选）：后台直接新建/编辑评论时可勾选，标记为站方发言
					// （前台「官方」徽章）。前台 /submit 亦支持官方身份角色勾选（服务端
					// canPostOfficial 门禁，见 api-public）
					name: 'official',
					type: 'checkbox',
					label: '官方回复',
					labelI18n: { en: 'Official' },
					defaultValue: false
				},
				{
					// C2：举报理由（最近若干条 JSON 数组）——审核队列里管理员能
					// 看到「为什么被举报」。由 /report 端点累积写入；管理端列表
					// 列展示（json 字段，管理员可见可改，无外部读取路径）
					name: 'reportReasons',
					type: 'json',
					label: '举报理由',
					labelI18n: { en: 'Report reasons' }
				}
			],
			list: {
				columns: [
					'status',
					'official',
					'authorName',
					'visitorProvider',
					'email',
					'content',
					'path',
					'contentType',
					'contentId',
					'os',
					'browser',
					'region',
					'likes',
					'reports',
					'reportReasons',
					'createdAt'
				],
				defaultSort: '-createdAt',
				sortable: ['status', 'likes', 'reports', 'createdAt'],
				searchable: ['authorName', 'content', 'path'],
				batchActions: [
					{
						action: 'approve',
						label: '通过',
						labelI18n: { en: 'Approve' },
						field: 'status',
						value: 'approved',
						variant: 'primary'
					},
					{
						action: 'spam',
						label: '垃圾',
						labelI18n: { en: 'Spam' },
						field: 'status',
						value: 'spam'
					},
					{
						action: 'pending',
						label: '待审',
						labelI18n: { en: 'Back to Pending' },
						field: 'status',
						value: 'pending'
					}
				]
			}
		});

		// 端点域共享依赖（限流器 / 计数缓存 / 通知工具，见 deps.ts）：register 内
		// 构造——每次注册得到全新 store，测试与热重载隔离。
		const d = createApiDeps(ctx, {
			cfg,
			contentSettings,
			blacklistService,
			info,
			pagePaths
		});

		// A3：待审回复的邮件补发——审核开启时新回复以 pending 落库，父作者不应
		// 在回复公开前收到「收到新回复」。评论经任意路径转为 approved（管理端
		// 逐行批量审核走内容引擎 update → collection:updated；举报自动回待审后的
		// 再次通过同理）时，给父作者补发并置 replyNotified 幂等标记——同一回复
		// 只通知一次，反复上下线状态不再重复轰炸。
		// 载荷仅含更新后的完整行；被删评论的 updated 不存在（已无行）。
		ctx.event.on('collection:updated', (data: unknown) => {
			const payload = data as {
				slug?: string;
				record?: Record<string, unknown>;
			};
			if (payload?.slug !== 'comments') return;
			const rec = payload.record;
			if (!rec || rec.status !== 'approved' || rec.replyNotified === true) return;
			if (!rec.parentId) return; // 顶层无补发语义
			if (!d.cfg.bool('notifyReplies', true)) return;
			void (async () => {
				const parent = (await ctx.db.findById(
					'comments',
					String(rec.parentId)
				)) as CommentRow | null;
				if (!parent) return;
				const toEmail = typeof parent.email === 'string' && parent.email ? parent.email : null;
				if (!toEmail) return;
				// 自己回复自己的判定：回复行无提交者身份快照可比 userId——按父的
				// userId 与回复 userId 比对；游客按统一访客 id（visitorId）比对
				const samePerson =
					parent.userId && rec.userId
						? parent.userId === rec.userId
						: parent.visitorId === rec.visitorId;
				if (samePerson) return;
				// 先置标记后发信：并发双 updated 时以「至多一次」为准（发送失败
				// 也认作已处理，不做重试轰炸）
				await ctx.db.update('comments', String(rec.id), {
					replyNotified: true
				});
				d.sendReplyMail(toEmail, String(rec.content ?? ''), (rec.path as string | null) ?? null);
			})().catch(() => {});
		});

		// 端点注册（顺序保持拆分前形态：public → interactions → admin）
		registerPublicApi(d);
		registerInteractionApi(d);
		registerAdminApi(d);

		// 服务供给：主题/其它插件按页面路径或内容项取已审核评论数，不必走 HTTP。
		// 口径与 /count 完全一致（内容级 featuredOnly、60s 缓存与写路径失效共用）。
		// 形状经 service-count.ts 的 declaration merging 登记，消费方拿到强类型。
		const countComments = createCountComments(d);
		ctx.service.provide<CommentsCountService>({
			id: 'comments/count',
			version: '1',
			description: 'Approved comment counts by page path or content item',
			api: {
				byPath: (path: string) => {
					const binding = bindingOf({ path });
					return binding ? countComments(binding) : Promise.resolve(0);
				},
				byContent: (contentType: string, contentId: string) => {
					const binding = bindingOf({ contentType, contentId });
					return binding ? countComments(binding) : Promise.resolve(0);
				}
			}
		});

		// 隐私登记（框架 0.3 统一访客）：访客凭自己的统一访客 cookie 在
		// /api/v1/privacy/export|erase 自助导出或删除「按访客存的那份数据」。
		// 评论/点赞的 visitor_id 就是框架访客 id（见 visitor.ts 的 visitorKeyOf），
		// 故按 id 精确命中；登录账号写的评论挂在 userId 上（账号数据，不在此列）。
		ctx.privacy.register({
			key: 'comments',
			label: '评论与点赞',
			async export(visitorId) {
				const comments = await ctx.db.find('comments', {
					filter: { visitorId, userId: null },
					limit: 1000
				});
				const likes = await ctx.db.find('plugin_comments_likes', {
					filter: { visitorId, userId: null },
					limit: 1000
				});
				return {
					comments: (comments.data as Array<Record<string, unknown>>).map((row) => ({
						id: row.id,
						content: row.content,
						status: row.status,
						path: row.path,
						contentId: row.contentId,
						contentType: row.contentType,
						authorName: row.authorName,
						email: row.email,
						createdAt: row.createdAt
					})),
					likes: (likes.data as Array<Record<string, unknown>>).map((row) => ({
						commentId: row.commentId,
						createdAt: row.createdAt
					}))
				};
			},
			async erase(visitorId) {
				let removed = 0;
				const deleted: string[] = [];
				const mine = await ctx.db.find('comments', {
					filter: { visitorId, userId: null },
					limit: 1000
				});
				// 与 /delete 同语义：顶层评论级联删整条线程；回复删前把直接子回复
				// 改挂其父，别人的回复不跟着消失
				for (const row of mine.data as Array<Record<string, unknown>>) {
					const id = String(row.id);
					if (row.rootId) {
						const kids = await ctx.db.find('comments', {
							filter: { parentId: id },
							limit: 1000
						});
						for (const kid of kids.data as Array<Record<string, unknown>>) {
							await ctx.db.update('comments', String(kid.id), {
								parentId: (row.parentId as string | null) ?? null
							});
						}
					} else {
						const thread = await ctx.db.find('comments', {
							filter: { rootId: id },
							limit: 1000
						});
						for (const child of thread.data as Array<Record<string, unknown>>) {
							await ctx.db.delete('comments', String(child.id));
							deleted.push(String(child.id));
							removed++;
						}
					}
					await ctx.db.delete('comments', id);
					deleted.push(id);
					removed++;
				}
				// 被删评论上的点赞一并清理
				if (deleted.length > 0) {
					const likesOn = await ctx.db.find('plugin_comments_likes', {
						filter: { commentId: { $op: 'in', $val: deleted } },
						limit: 1000
					});
					for (const like of likesOn.data as Array<Record<string, unknown>>) {
						await ctx.db.delete('plugin_comments_likes', String(like.id));
						removed++;
					}
				}
				// 本人点过的赞
				const myLikes = await ctx.db.find('plugin_comments_likes', {
					filter: { visitorId, userId: null },
					limit: 1000
				});
				for (const like of myLikes.data as Array<Record<string, unknown>>) {
					await ctx.db.delete('plugin_comments_likes', String(like.id));
					removed++;
				}
				return removed;
			}
		});

		// 文案注册（key → { locale }）：服务端 ctx.i18n.t() 取词，客户端组件
		// 经 /api/v1/i18n/comments 端点取同一份（不占框架 messages/ 命名空间）
		ctx.i18n.register('comments', messages);

		// 前台插槽：默认主题布局在正文之后渲染（ThemePluginSlot eager glob，零 props）
		ctx.slot.register('frontend:content-after', 'components/slot-comments.svelte');

		// 管理端内容表单插槽（创作者控制）：编辑内容项时渲染评论开关三件套
		// （关闭 / 仅登录 / 仅精选）——「关闭某篇内容的评论」属创作者职责，
		// 与站点级白名单（站长职责）分层。组件按 recordId 读写
		// /admin/content-settings；create 模式无 id 不渲染（先保存再设置）。
		ctx.slot.register('collection-form-fields-after', 'components/slot-comment-settings.svelte');

		// 管理端列表行操作插槽（方案 B）：后台评论列表每行出「回复」——弹层
		// 直连 /admin/reply（免审 + official 徽章 + 父作者通知），挂楼三键从
		// 行数据透传、服务端 bindingMatches 复核。插槽名带集合子名（:comments）
		// ——列表页按当前 slug 取描述符，其他集合列表不出「操作」列；组件内
		// 仍带 contentType 判别门双保险。
		ctx.slot.register(
			'collection-list-row-actions:comments',
			'components/slot-comment-admin-actions.svelte'
		);

		// 管理端列表工具栏插槽：评论审核工作台的「登录来源」筛选。通用列表的
		// 快捷筛选只认 select / radio 字段，visitorProvider 是服务端文本列；
		// 组件把选中的值写进 filter_visitorProvider，服务端对任意字段等值过滤。
		ctx.slot.register(
			'collection-list-toolbar-before',
			'components/slot-comment-list-filter.svelte'
		);

		// 内容管线 filter：本插件集合落库前归一（与 example 同款形态）。
		// A4：comments 集合任何经内容引擎的写入（后台批量审核的通过/垃圾/待审、
		// 精选切换等）在落库前 bust 计数缓存——管理端审核不再最长滞后 60s。
		// （插件自身端点走 ctx.db 直写不经此挂点，已在各端点内显式 bustCount。）
		ctx.filters.register(
			'content:beforeWrite',
			(value, fctx) => {
				if (fctx.collection !== 'comments') return value;
				d.bustCount();
				const data = value as Record<string, unknown>;
				// 写载荷可能是部分补丁（如批量审核只带 status）——只归一载荷中实际出现的字段
				const next: Record<string, unknown> = { ...data };
				// 服务端托管字段（绑定键 + 采集存证）：编辑表单不渲染它们（见字段
				// condition），框架的表单解析仍会把未渲染字段按 null 回填——update
				// 前整键移除，库内既有值原样保留。插件自身写入走 ctx.db 直连，
				// 不经此挂点。
				if (fctx.action === 'update') {
					for (const field of SERVER_OWNED_FIELDS) delete next[field];
				}
				if (typeof next.content === 'string') next.content = next.content.trim();
				if ('authorName' in next) next.authorName = sanitizeAuthorName(next.authorName) || null;
				if ('path' in next && next.path !== null) next.path = normalizePagePath(next.path);
				// official 是 integer(mode:'boolean') 列 + checkbox 表单字段：提交值是
				// 'true'/'false' 字符串，drizzle 的 `v ? 1 : 0` 会把 'false' 也判 truthy
				// 存成 1（取消勾选反而开启）。归一为真布尔——create/update 都要（编辑可
				// 改勾选）。featured 不在此列（非表单字段，只经 /admin/feature 直写）。
				if ('official' in next) {
					const v = next.official;
					next.official = v === true || v === 'true' || v === 1 || v === '1';
				}
				// visitor_id 列 NOT NULL 但**不是**表单字段——管理员在后台「评论」
				// 集合直接新建（或走通用内容 API POST，本集合 api:true）时载荷
				// 天然缺它，drizzle 显式填 null → 整条 INSERT 被 SQLite 拒
				// （用户报的 Failed query 即此）。按 /admin/reply 同款 'admin'
				// 哨兵兜底；仅限 create——update 是补丁语义，不能覆写既有行的归属。
				if (fctx.action === 'create' && typeof next.visitorId !== 'string') {
					next.visitorId = 'admin';
				}
				return next;
			},
			{ priority: 150 }
		);

		// 刻意不做：ctx.menu（集合自动进侧边栏「内容」组）、seed、onUninstall
		// （停用保留表数据，dropData 才经 schemaRegistry 清理）。管理员推送通知
		// = 插件自身职责（notifyReplies/notifyAuthor 配置 + ctx.notification 原语，
		// 已在本文件实现）。
	},

	/**
	 * 版本化数据迁移（框架 0.3）：表结构补齐后、onInstall 之前按 version 升序
	 * 执行，每个迁移与版本记录同一事务；已应用的版本记在 plugin_migrations，
	 * 此后不再重复执行。
	 *
	 * v1：把库内页面路径统一为可读原文。地址栏中的中文段是 percent-encoding
	 * （`/article/%E7%BD%91…`）；归一为原文后，后台列表、路径白名单与 pages
	 * slug 按同一形态呈现与比对。只改动归一后形态发生变化的行，可重入。
	 */
	migrations: [
		{
			version: 1,
			description: '页面路径统一为可读原文',
			async up(mctx) {
				const SCAN = 500;
				let normalized = 0;
				for (let page = 1; ; page++) {
					const res = await mctx.db.find('comments', {
						limit: SCAN,
						page,
						sort: 'createdAt'
					});
					const rows = res.data as Array<Record<string, unknown>>;
					for (const row of rows) {
						const raw = row.path;
						if (typeof raw !== 'string' || !raw.includes('%')) continue;
						const path = normalizePagePath(raw);
						if (!path || path === raw) continue;
						await mctx.db.update('comments', String(row.id), { path });
						normalized++;
					}
					if (rows.length < SCAN) break;
				}
				if (normalized > 0) {
					mctx.log.info(`comments: normalized ${normalized} page path(s)`);
				}
			}
		}
	]
};

export default plugin;
