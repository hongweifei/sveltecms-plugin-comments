/**
 * 评论插件公开端点域（A 方案拆分自 plugin.ts）：submit / list / children / count。
 * 共享依赖经 deps.ts 的 ApiDeps 显式注入，各符号解构为同名局部变量——
 * handler 主体与拆分前逐字一致（仅缩进减一层）。
 */

import { type RequestEvent } from '@sveltejs/kit';
import { computeVisitorId } from '#lib/cms/stats.ts';
import { getRequestIp } from '#lib/common/server/rate-limit.ts';
import { userAvatarUrl } from '#lib/cms/utils/user-avatar.ts';
import {
	bindingFilter,
	bindingMatches,
	bindingOf,
	json,
	readJson,
	toPublic,
	type CommentRow,
	type ResolvedUser
} from './helpers';
import {
	clampPaging,
	isHoneypotFilled,
	matchBlacklist,
	normalizeId,
	validateSubmitInput
} from './validate';
import type { ApiDeps } from './deps';

export function registerPublicApi(d: ApiDeps): void {
	const {
		CHILD_CAP,
		COUNT_TTL_MS,
		blacklistService,
		bustCount,
		canPostOfficial,
		cfg,
		contentSettings,
		countCache,
		ctx,
		info,
		lastCommentAt,
		pagePaths,
		sendReplyMail,
		submitLimiter
	} = d;

	/**
	 * 作者标联查派生（不落列）：取本绑定内容记录的 userId——contentId 绑定按
	 * 前端声明的集合类型经内容引擎反查（类型谎报只会查空 → 无徽章，徽章是
	 * 展示性且比对的是服务端落的 row.userId，无伪造面）；path 绑定经 pages 桥
	 * 取页面记录 userId（pages 为声明只读表）。查不到 / 无类型 → null。
	 */
	async function threadAuthorId(binding: {
		path: string | null;
		contentId: string | null;
		contentType: string | null;
	}): Promise<string | null> {
		if (binding.contentId) {
			if (!binding.contentType) return null;
			const rec = (await ctx.content?.findById(binding.contentType, binding.contentId)) as
				Record<string, unknown> | null | undefined;
			const raw = rec?.userId;
			return typeof raw === 'string' && raw ? raw : null;
		}
		if (binding.path) {
			const rid = await pagePaths.pathToRecordId(binding.path);
			if (!rid) return null;
			const row = (await ctx.db.findById('pages', rid)) as Record<string, unknown> | null;
			const raw = row?.userId;
			return typeof raw === 'string' && raw ? raw : null;
		}
		return null;
	}

	// ================== 端点 ==================
	// 提交评论。蜜罐命中返回 204 静默成功（不落库）；黑名单命中静默进
	// spam（对外仍是 success，机器人无从探测）；客户端不可信，状态一律
	// 强制 pending，经后台审核后才对外可见（本人除外——列表端点按
	// visitorId/userId 并入本人待审）。邮箱仅存储（gravatar 源），对外
	// 只出哈希；os/browser/region 在落库前一并解析记入（best-effort），
	// region 归一成「国家·省份·城市·运营商」展示文本。
	// 登录用户头像不再快照——列表时按 user 表实时反查（manifest 声明
	// 'user' 系统表），账号换头像即刻生效。
	ctx.api.register({
		method: 'POST',
		path: '/submit',
		public: true,
		handler: async (event: RequestEvent) => {
			try {
				const rl = await submitLimiter.check({ ip: getRequestIp(event) });
				if (!rl.allowed) {
					return json({ error: 'Too many requests' }, 429, {
						'retry-after': String(rl.retryAfter ?? 60)
					});
				}

				const parsed = await readJson(event);
				if (!parsed.ok) return json({ error: 'Invalid JSON' }, 400);
				if (isHoneypotFilled(parsed.body)) {
					return new Response(null, { status: 204 });
				}

				// CAPTCHA（SEC-6）：框架启用时先于业务校验（一次性消费防重放），
				// 未启用时 checkScope 恒放行——对评论零打扰
				const captchaOk = await ctx.captcha.checkScope('forms', (k) =>
					typeof parsed.body[k] === 'string' && parsed.body[k] ? (parsed.body[k] as string) : null
				);
				if (!captchaOk) return json({ error: 'Captcha verification failed' }, 403);

				// 身份来源：CMS 登录用户取账号；微信访客取签名 cookie 解析出的
				// locals.visitor（框架已验签，客户端传的昵称/邮箱不作数）；其余为游客。
				const user = event.locals.user;
				const visitor = event.locals.visitor;
				const result = validateSubmitInput(parsed.body, {
					skipIdentity: Boolean(user || visitor),
					// B2b：站点开启「游客邮箱可留空」时空值放行（登录路径本就 skipIdentity 不消费）
					emailOptional: cfg.bool('guestEmailOptional', false)
				});
				if (!result.ok) {
					return json({ error: 'Validation failed', fieldErrors: result.fieldErrors }, 400);
				}
				const { content, authorName, email, website, path, contentId, contentType, parentId } =
					result.data;

				// 站点级开关（黑白名单）：黑名单恒定拒绝，白名单留空 = 不限制；
				// 集合类型经内容引擎校验归属（contentSettings.resolve），防客户端伪造
				const resolvedType = await contentSettings.resolve(contentId, contentType);
				if (!cfg.commentsEnabledFor(path, resolvedType)) {
					return json({ error: 'Comments are disabled here' }, 403);
				}

				// 游客评论开关：关闭时未登录一律拒绝
				if (!user && !cfg.bool('allowGuest', true)) {
					return json({ error: 'Login required' }, 403);
				}

				// 内容级设置（创作者控制）：创作者关闭 → 拒绝；需登录 → 未登录
				// 拒绝。contentId 缺失时（path 绑定的页面评论，如 /enterprise 走
				// 路径白名单）经 pagePaths 桥反查 pages 记录——与 /list 消费同口径，
				// 保证「编辑页设了关闭」对两种绑定路径的提交都真实生效。
				const csRecordId =
					contentId ??
					(path && cfg.hasEnabledPaths() ? await pagePaths.pathToRecordId(path) : null);
				if (csRecordId) {
					// 带类型判别：contentId 绑定用服务端校验过的 resolvedType；path 桥命中
					// 恒为 pages 记录。null 类型（历史设置行）经 _$or 兼容仍命中。
					const cs = await contentSettings.get(csRecordId, contentId ? resolvedType : 'pages');
					if (cs.closed) return json({ error: 'Comments are closed here' }, 403);
					// 微信访客同样视为已登录身份（内容级「仅登录可评」对两类身份都放行）
					if (cs.requireLogin && !user && !visitor) {
						return json({ error: 'Login required' }, 403);
					}
				}

				// 字数上限（0 = 不限）
				const maxLength = cfg.num('maxLength', 500);
				if (maxLength > 0 && String(content).length > maxLength) {
					return json(
						{
							error: 'Validation failed',
							fieldErrors: { content: `max ${maxLength}` }
						},
						400
					);
				}

				const ip = getRequestIp(event);
				const ua = event.request.headers.get('user-agent');
				const visitorId = computeVisitorId(ip, ua ?? undefined);

				// 父评论必须存在、已审核，且与本次提交共享绑定（防跨页挂楼）；
				// rootId 锁定所在根评论（父即根 → 父 id，否则沿用父的 rootId）
				let parent: CommentRow | null = null;
				let rootId: string | null = null;
				if (parentId) {
					parent = (await ctx.db.findById('comments', parentId)) as CommentRow | null;
					if (
						!parent ||
						parent.status !== 'approved' ||
						// 挂楼带类型判别：跨集合同 id 的线程不互挂（父行历史空类型视为任意）
						!bindingMatches(parent, {
							path,
							contentId,
							contentType: resolvedType
						})
					) {
						return json(
							{
								error: 'Validation failed',
								fieldErrors: { parentId: 'invalid' }
							},
							400
						);
					}
					rootId =
						typeof parent.rootId === 'string' && parent.rootId ? parent.rootId : String(parent.id);
				}

				// 最小评论间隔（0 = 不限）：抑制同一访客连发
				const minInterval = cfg.num('minInterval', 0);
				if (minInterval > 0) {
					const lastAt = await lastCommentAt(visitorId, user?.id);
					if (lastAt !== null && Date.now() - lastAt < minInterval * 1000) {
						return json({ error: 'Too many requests' }, 429, {
							'retry-after': String(minInterval)
						});
					}
				}

				const { os, browser, region } = await info.collect(ua, ip);
				const hit = matchBlacklist(content, await blacklistService.get());
				// 内容作者反查（contentId 绑定、非 spam 时一次）：供「作者标」投影派生
				// 与下方 notifyAuthor 定向收件人复用——不额外多打一次内容引擎查询。
				// 不落 isAuthor 列（纯派生量，存列会随内容转作者而失真）；本行返回的
				// 投影按 contentAuthorId 即时派生徽章。
				let contentAuthorId: string | null = null;
				if (!hit && contentId && resolvedType) {
					const contentRecord = await ctx.content?.findById(resolvedType, contentId);
					const raw = (contentRecord as Record<string, unknown> | undefined)?.userId;
					if (typeof raw === 'string' && raw) contentAuthorId = raw;
				}
				// 官方标（可选）：仅官方身份角色可带（adminAccess 角色或 officialRoles
				// 白名单）——客户端声明不作数，服务端按登录态 canPostOfficial 复核；
				// 无官方身份即便传 official 也强制 false。
				// 官方评论与 /admin/reply 同语义：免审直发（status=approved），黑名单
				// 命中仍进 spam（站方账号被盗/误发的兜底）。
				const wantOfficial = parsed.body.official === true || parsed.body.official === 'true';
				const official = wantOfficial ? await canPostOfficial(user) : false;
				// 黑名单命中静默进 spam；官方/免审 → approved；否则按审核开关
				const status = hit
					? 'spam'
					: official || !cfg.isModerationEnabled()
						? 'approved'
						: 'pending';
				const record = await ctx.db.create('comments', {
					content,
					// 身份优先级：CMS 账号 > 微信访客 > 表单填写。微信昵称来自签名
					// cookie，客户端提交的 authorName 不参与，避免冒名。
					authorName: user?.name || visitor?.nickname || authorName || null,
					// 登录用户：邮箱取账号（gravatar / 存证），主页不信客户端
					email: user ? user.email || null : visitor ? null : email,
					// 头像：登录用户不落快照（列表按 user 表实时反查）；微信访客落
					// 一次头像快照，列表无邮箱可派生时用它展示
					...(visitor?.avatar ? { avatar: visitor.avatar } : {}),
					website: user || visitor ? null : website,
					userId: user?.id ?? null,
					// 访客登录来源（当前仅 wechat）：前台据此展示「微信」徽章；
					// openid / unionid 不落评论表，去重仍用 visitorId 哈希
					visitorProvider: visitor ? visitor.provider : null,
					status,
					path,
					contentId,
					// 类型判别：存服务端经内容引擎反查过的归属类型（客户端声明不作数；
					// resolve 未过 / path 绑定 → null，读取按「任意类型」兼容命中）
					contentType: contentId ? resolvedType : null,
					// 内容归属快照：后台据此把评论审核权授予内容作者（创作者）
					contentOwnerId: contentAuthorId,
					parentId,
					rootId,
					official,
					likes: 0,
					reports: 0,
					os,
					browser,
					region,
					visitorId
				});

				const id = String(record.id);
				bustCount();

				// 回复邮件通知（C1-2 / A3）：仅在回复**已公开**（免审直发 status=
				// approved）时即时通知父作者；审核开启时回复还是 pending，此刻
				// 发信会「收到通知却看不到」——延后到其审核通过（collection:updated
				// status→approved）时补发，replyNotified 标记幂等。自己回复自己
				// 不发。即时发送也置 replyNotified，防后续再审核重复通知。
				if (parent && !hit && status === 'approved' && cfg.bool('notifyReplies', true)) {
					const toEmail = typeof parent.email === 'string' && parent.email ? parent.email : null;
					const parentVisitor = typeof parent.visitorId === 'string' ? parent.visitorId : null;
					const samePerson = user ? parent.userId === user.id : parentVisitor === visitorId;
					if (toEmail && !samePerson) {
						await ctx.db.update('comments', id, { replyNotified: true });
						sendReplyMail(toEmail, content, path);
					}
				}

				// 管理员通知（C1-1）：仅待审评论提醒（免审 approved 与 spam 静默）。
				// ctx.notification.notifyAdmins 是框架通用原语——插件决定何时通知
				// 与文案，框架不感知具体插件。深链直达待审快筛。
				// C4：标题经 ctx.i18n.t() 按请求 locale 取词（事件驱动路径无请求
				// 上下文时 t() 回退默认语言，不漏裸 key）。
				if (status === 'pending') {
					void ctx.notification.notifyAdmins({
						title: ctx.i18n.t('mail_admin_pending_title'),
						message: `${authorName || user?.name || ctx.i18n.t('guest')}：${String(content).slice(0, 60)}`,
						link: '/admin/content/comments?filter_status=pending'
					});
				}

				// 内容作者通知：评论落在具体内容项上时定向通知创作者（站内通知）。
				// 收件人复用上方为「作者标」反查的 contentAuthorId（同一
				// contentId+resolvedType 非 spam 判定，不重复查内容引擎）；非本人评论
				// 才发；与管理员通知互相独立（可同时发生）。
				if (contentAuthorId && contentAuthorId !== user?.id && cfg.bool('notifyAuthor', true)) {
					void ctx.notification.notifyUser(contentAuthorId, {
						title: ctx.i18n.t('mail_author_comment_title'),
						message: `${authorName || user?.name || ctx.i18n.t('guest')}：${String(content).slice(0, 60)}`,
						link: '/admin/content/comments'
					});
				}

				ctx.event.emit('comments:submitted', {
					id,
					path,
					contentId,
					spam: hit !== null
				});
				// 回传与 /list 同源的公开投影（toPublic）：前端直接拿它做本地插入，
				// 头像 / 环境信息 / 归属等一律服务端权威给出——前端不再凭空组装，
				// 否则「刚发出」与「刷新后」两套数据不一致（头像错、位置跳）。
				// 登录用户的头像 / 昵称不经查库——locals.user 就在手上，直接解析。
				const userBy = user
					? new Map<string, ResolvedUser>([
							[String(user.id), { name: user.name ?? null, avatar: userAvatarUrl(user) }]
						])
					: undefined;
				return json({
					success: true,
					comment: {
						...toPublic(record as CommentRow, true, userBy, {
							hideEnv: cfg.bool('hideEnv', false),
							contentAuthorId
						}),
						status
					}
				});
			} catch (e) {
				ctx.logger.error(`comments: submit failed: ${String(e)}`);
				return json({ error: 'Internal error' }, 500);
			}
		}
	});

	// 已审核评论列表：按顶层评论（rootId 为 null）分页，顶层之下全部后代
	// 经 rootId 一次带出（children 平铺数组，前台按 parentId 递归组装树）。
	// 本人待审（第 1 页）并入：待审顶层进 data，待审回复进 children。绑定
	// ?path= 或 ?contentId= 二选一；顶层排序 ?sort=latest（-createdAt，默认）
	// 或 hot（likes 降序，同赞数按新在前）。
	ctx.api.register({
		method: 'GET',
		path: '/list',
		public: true,
		handler: async (event: RequestEvent) => {
			const binding = bindingOf(event.url.searchParams);
			if (!binding) return json({ error: 'Invalid binding' }, 400);
			const { page, pageSize } = clampPaging(
				event.url.searchParams.get('page'),
				event.url.searchParams.get('pageSize')
			);
			// 排序枚举钳制：仅接受 latest / hot，其余回默认
			const sort = event.url.searchParams.get('sort') === 'hot' ? 'hot' : 'latest';

			const baseFilter: Record<string, unknown> = bindingFilter(binding);

			// 内容级设置的归属记录：contentId 绑定直接取；path 绑定（页面尚无
			// contentId 评论时前端回落此路）经 pagePaths 桥反查 pages 记录——
			// 否则「/enterprise 配了路径白名单、创作者在编辑页设了关闭/精选」在
			// 前台 path 视图下消费不到（配了也无效）。未声明任何路径白名单时
			// 跳过反查（零额外查询）；查不到 = 无内容级设置。
			const csRecordId = binding.contentId
				? binding.contentId
				: binding.path && cfg.hasEnabledPaths()
					? await pagePaths.pathToRecordId(binding.path)
					: null;

			// 精选模式（公众号式）：该内容开启后，公开列表仅展示精选评论——
			// 未精选的已审核评论对所有人隐藏（创作者在后台勾选精选后现身）
			const contentSettingsRow = csRecordId
				? await contentSettings.get(csRecordId, binding.contentId ? binding.contentType : 'pages')
				: null;
			const approvedFilter: Record<string, unknown> = {
				...baseFilter,
				status: 'approved',
				rootId: null
			};
			if (contentSettingsRow?.featuredOnly) approvedFilter.featured = true;

			const approved = await ctx.db.find('comments', {
				filter: approvedFilter,
				sort: '-createdAt',
				page,
				limit: pageSize
			});

			const user = event.locals.user;
			const visitorId = computeVisitorId(
				getRequestIp(event),
				event.request.headers.get('user-agent') ?? undefined
			);
			// B1：登录用户一律按 userId 判定「本人」——同 NAT/UA 的游客不再
			// 互相顶号；游客保留 visitorId（其待审本人可见的既有机制）
			const isMine = (row: CommentRow) =>
				user ? row.userId === user.id : row.visitorId === visitorId;

			// 本人待审并入（仅第 1 页）：待审顶层进 data，待审回复进 children
			const mineFilter: Record<string, unknown> = {
				status: 'pending',
				...bindingFilter(binding)
			};
			mineFilter[user ? 'userId' : 'visitorId'] = user ? user.id : visitorId;
			const own =
				page === 1
					? await ctx.db.find('comments', { filter: mineFilter, limit: 50 })
					: { data: [] as Record<string, unknown>[] };
			const ownRows = own.data as CommentRow[];

			const topRows = [
				...(approved.data as CommentRow[]),
				...ownRows.filter((r) => !r.rootId)
			].sort((a, b) => {
				if (sort === 'hot') {
					const la = typeof a.likes === 'number' ? a.likes : 0;
					const lb = typeof b.likes === 'number' ? b.likes : 0;
					if (la !== lb) return lb - la;
				}
				return String(a.createdAt) < String(b.createdAt) ? 1 : -1;
			});

			// 后代（本页顶层的全部已审核后代 + 本人待审回复），按 rootId 一次带出。
			// CHILD_CAP 是防读放大的护栏：命中即可能被截断（D1）——罕见分支里
			// 按线程精确计数，把「返回数 < 实际数」的线程标注给前端（超长线程
			// 出「查看更多回复」，走 /children 续拉），绝不静默吞掉后代。
			const topIds = topRows.map((r) => String(r.id));
			const childRows: CommentRow[] = [];
			// D1：被截断线程 → { rootId, loaded }。批量按 createdAt 升序全局取最旧
			// CHILD_CAP 条，某线程命中的部分恒为其「createdAt 升序的前缀」，故
			// loaded（已返回数）即可作为 /children 的 offset 精确续拉，不重不漏。
			const truncatedThreads: Array<{ rootId: string; loaded: number }> = [];
			if (topIds.length > 0) {
				const inFilter = { ...baseFilter, rootId: { $op: 'in', $val: topIds } };
				const approvedChildren = await ctx.db.find('comments', {
					filter: { ...inFilter, status: 'approved' },
					sort: 'createdAt',
					limit: CHILD_CAP
				});
				childRows.push(...(approvedChildren.data as CommentRow[]));
				// 仅当批量命中上限（可能被截断）才逐线程计数——常态路径零额外开销
				if (approvedChildren.data.length >= CHILD_CAP) {
					const returnedByRoot = new Map<string, number>();
					for (const c of approvedChildren.data as CommentRow[]) {
						const rid = c.rootId ? String(c.rootId) : '';
						if (rid) returnedByRoot.set(rid, (returnedByRoot.get(rid) ?? 0) + 1);
					}
					for (const rid of topIds) {
						const one = await ctx.db.find('comments', {
							filter: { ...baseFilter, rootId: rid, status: 'approved' },
							limit: 1
						});
						const full = one.meta.total ?? one.data.length;
						const loaded = returnedByRoot.get(rid) ?? 0;
						if (full > loaded) truncatedThreads.push({ rootId: rid, loaded });
					}
				}
				const ownChildRows = ownRows.filter((r) => r.rootId && topIds.includes(String(r.rootId)));
				childRows.push(...ownChildRows);
			}
			childRows.sort((a, b) => (String(a.createdAt) > String(b.createdAt) ? 1 : -1));

			// 登录用户头像 / 昵称实时反查（user 表为 manifest 声明的系统表只读权限）：
			// 本页顶层 + 后代涉及的全部 userId 一次 IN 查询
			const userBy = await info.resolveUsers([...topRows, ...childRows]);
			// B2a：前台隐藏设备环境（os/browser/region）时——投影置 null（库里仍存）
			const hideEnv = cfg.bool('hideEnv', false);

			// 点赞 toggle：回传本页中「当前身份已赞」的评论 id——前端据此渲染
			// 实心红心，刷新后状态不丢。与 /like 同幂等键（登录 userId /
			// 游客 userId IS NULL + visitorId）。
			const pageIds = [...topIds, ...childRows.map((r) => String(r.id))];
			const likedIds: string[] = [];
			if (pageIds.length > 0) {
				const likeFilter: Record<string, unknown> = {
					commentId: { $op: 'in', $val: pageIds }
				};
				if (user) likeFilter.userId = user.id;
				else {
					likeFilter.userId = null;
					likeFilter.visitorId = visitorId;
				}
				const liked = await ctx.db.find('plugin_comments_likes', {
					filter: likeFilter,
					limit: pageIds.length
				});
				for (const l of liked.data as Array<Record<string, unknown>>) {
					if (l.commentId) likedIds.push(String(l.commentId));
				}
			}

			// 作者标联查派生（一次，本页所有行同绑定共用）：评论 userId === 内容
			// 记录 userId 即派生「作者」徽章——不落列，内容转作者后徽章自动跟变。
			const authorId = await threadAuthorId(binding);
			return json({
				data: topRows.map((row) =>
					toPublic(row, isMine(row), userBy, {
						hideEnv,
						contentAuthorId: authorId
					})
				),
				children: childRows.map((row) =>
					toPublic(row, isMine(row), userBy, {
						hideEnv,
						contentAuthorId: authorId
					})
				),
				// 点赞 toggle：本页中当前身份已赞的评论 id（前端渲染实心红心，刷新不丢）
				likedIds,
				// D1：单线程后代超 CHILD_CAP 被截断的线程 rootId 列表——前端据此
				// 在对应线程尾部出「查看更多回复」（走 /children 续拉）
				truncatedThreads,
				// 表单可用状态：站点白名单未开启此绑定时前端隐藏输入框。contentType
				// 取查询串（主题模板注入的集合 slug，客户端值不可信——仅作 UI 提示，
				// /submit 会经内容引擎归属校验后同样复核）；字数上限与最小间隔供
				// 前端即时提示。
				enabled: cfg.commentsEnabledFor(binding.path, event.url.searchParams.get('contentType')),
				// 内容级设置（创作者控制）：csRecordId 覆盖 contentId 绑定与
				// path 桥接命中的两种情形；前端据此隐藏表单（closed）或提示
				// 登录（requireLogin），不必等提交吃 403
				contentSettings: csRecordId
					? {
							closed: contentSettingsRow?.closed ?? false,
							requireLogin: contentSettingsRow?.requireLogin ?? false,
							featuredOnly: contentSettingsRow?.featuredOnly ?? false
						}
					: null,
				// 人机校验（SEC-6）：框架启用 forms 作用域时前端渲染验证码输入
				captchaRequired: await (async () => {
					const s = await ctx.captcha.settings();
					return s.enabled && s.requireForms;
				})(),
				sort,
				allowGuest: cfg.bool('allowGuest', true),
				// B2b：游客邮箱可留空时前端输入框去掉必填（服务端同步放行）
				guestEmailOptional: cfg.bool('guestEmailOptional', false),
				// 官方标（可选）：当前登录用户具备官方身份时前端才显示「官方」勾选框
				// （服务端 canPostOfficial 权威判定，无身份拿到也是 false，且 /submit 会复核）
				canOfficial: await canPostOfficial(event.locals.user),
				// 登录态下发：本应用 better-auth 端点不走 HTTP（/api/auth/* 410），
				// 组件无法自行探测会话——viewer 非空即登录，前端隐藏身份输入，
				// /submit 服务端按会话落身份（与此处同源，伪造无意义）
				viewer: event.locals.user ? { name: event.locals.user.name ?? '' } : null,
				maxLength: cfg.num('maxLength', 500),
				minInterval: cfg.num('minInterval', 0),
				page,
				pageSize,
				total: typeof approved.meta.total === 'number' ? approved.meta.total : approved.data.length,
				hasMore: page * pageSize < (approved.meta.total ?? 0)
			});
		}
	});

	// D1：单线程后代续拉——/list 的 CHILD_CAP 截断后，前端对 truncatedThreads
	// 里的线程出「查看更多回复」。批量按 createdAt 升序全局取最旧 CHILD_CAP 条，
	// 故某线程已返回的恰是其升序「前缀」——续拉用 after=已展示条数（offset）+
	// limit，取升序 [after, after+limit)，与已展示精确衔接（不重）。前端仍以
	// id 去重合并兜底并发重叠。投影与 /list 同口径（isMine / hideEnv）。
	ctx.api.register({
		method: 'GET',
		path: '/children',
		public: true,
		handler: async (event: RequestEvent) => {
			const binding = bindingOf(event.url.searchParams);
			if (!binding) return json({ error: 'Invalid binding' }, 400);
			const rootId = normalizeId(event.url.searchParams.get('rootId'));
			if (!rootId) return json({ error: 'Invalid rootId' }, 400);
			const after = Math.max(0, Number(event.url.searchParams.get('after')) || 0);
			const limit = Math.min(
				CHILD_CAP,
				Math.max(1, Number(event.url.searchParams.get('limit')) || 50)
			);
			const filter: Record<string, unknown> = {
				rootId,
				status: 'approved',
				...bindingFilter(binding)
			};
			// page 换算 offset=after（provider 以 (page-1)*limit 计 offset，limit=
			// after+limit 时 page=1 取整段再本地切片最稳，且 total 直接来自 meta）
			const result = await ctx.db.find('comments', {
				filter,
				sort: 'createdAt',
				limit: after + limit
			});
			const slice = (result.data as CommentRow[]).slice(after, after + limit);
			const total = typeof result.meta.total === 'number' ? result.meta.total : result.data.length;
			const user = event.locals.user;
			const visitorId = computeVisitorId(
				getRequestIp(event),
				event.request.headers.get('user-agent') ?? undefined
			);
			const isMine = (row: CommentRow) =>
				user ? row.userId === user.id : row.visitorId === visitorId;
			const userBy = await info.resolveUsers(slice);
			const hideEnv = cfg.bool('hideEnv', false);
			// 与 /list 同：回传本批中当前身份已赞的 id（前端红心持久）
			const sliceIds = slice.map((r) => String(r.id));
			const likedIds: string[] = [];
			if (sliceIds.length > 0) {
				const likeFilter: Record<string, unknown> = {
					commentId: { $op: 'in', $val: sliceIds }
				};
				if (user) likeFilter.userId = user.id;
				else {
					likeFilter.userId = null;
					likeFilter.visitorId = visitorId;
				}
				const liked = await ctx.db.find('plugin_comments_likes', {
					filter: likeFilter,
					limit: sliceIds.length
				});
				for (const l of liked.data as Array<Record<string, unknown>>) {
					if (l.commentId) likedIds.push(String(l.commentId));
				}
			}
			// 作者标联查派生（与 /list 同，一次共用）——binding 已含 contentType
			const authorId = await threadAuthorId(binding);
			return json({
				rootId,
				data: slice.map((row) =>
					toPublic(row, isMine(row), userBy, {
						hideEnv,
						contentAuthorId: authorId
					})
				),
				likedIds,
				after,
				limit,
				total,
				// 续拉起点 + 本批是否到底（前端下一次 after = after + data.length）
				hasMore: after + slice.length < total
			});
		}
	});

	// 已审核评论计数（页面「N 条评论」），同样支持双绑定。60s 内存缓存
	// （进程内评论变更即失效）——页面头部高频读，不值得每次打库。
	// A1：featuredOnly 内容仅精选评论对外可见，计数必须同口径过滤 featured，
	// 否则「N 条评论」远大于公开列表实际可见数。缓存键并入精选模式位——切换
	// featuredOnly 后落新键直接重算，旧键 60s 自然过期（无独立失效通道）。
	ctx.api.register({
		method: 'GET',
		path: '/count',
		public: true,
		handler: async (event: RequestEvent) => {
			const binding = bindingOf(event.url.searchParams);
			if (!binding) return json({ error: 'Invalid binding' }, 400);
			// 与 /list 同口径：path 绑定经 pagePaths 桥解析内容级设置（featuredOnly
			// 计数必须跟列表一致，否则「N 条评论」与可见列表数对不上——A1 同款）
			const csRecordId =
				binding.contentId ??
				(binding.path && cfg.hasEnabledPaths()
					? await pagePaths.pathToRecordId(binding.path)
					: null);
			const cs = csRecordId
				? await contentSettings.get(csRecordId, binding.contentId ? binding.contentType : 'pages')
				: null;
			const featuredOnly = cs?.featuredOnly ?? false;
			// 缓存键含类型判别：同 contentId 不同集合的计数互不串（与查询口径一致）
			const cacheKey = `${binding.path ?? ''}|${binding.contentId ?? ''}|${
				binding.contentType ?? ''
			}|${featuredOnly ? 'feat' : 'all'}`;
			const cached = countCache.get(cacheKey);
			if (cached && cached.expires > Date.now()) {
				return json({ count: cached.value });
			}
			const filter: Record<string, unknown> = {
				status: 'approved',
				...bindingFilter(binding)
			};
			if (featuredOnly) filter.featured = true;
			const page = await ctx.db.find('comments', { filter, limit: 1 });
			const count = typeof page.meta.total === 'number' ? page.meta.total : page.data.length;
			countCache.set(cacheKey, {
				value: count,
				expires: Date.now() + COUNT_TTL_MS
			});
			return json({ count });
		}
	});
}
