<!--
	评论前台插槽 v3：注册到 frontend:content-after，默认主题在正文之后渲染
	（ThemePluginSlot eager glob，零 props）。匿名页有 60s 公共缓存，评论一律
	客户端 fetch；文案经 ctx.i18n 注册、由 /api/v1/i18n/comments 下发
	（loadPluginMessages），整块挂在 mounted 之后（避免 SSR 水合不一致）。

	能力：path/contentId 双绑定（优先内容项 id——由主题模板注入的
	window.__CMS_PAGE__ 提供，回落 URL 路径）、无限嵌套回复（rootId 锁定根
	评论，服务端按顶层分页 + 后代一次带出，前台平铺在根评论下一层——twikoo
	式，回复内容带「回复 @目标」前缀而非层层缩进）、
	分页加载更多、评论计数、cravatar/gravatar 头像（邮箱 md5，无邮箱回退
	字母色块）、访客身份三字段（昵称可选/邮箱必填/主页可选，服务端 HttpOnly
	cookie 记住、回访预填）、点赞（服务端按访客幂等）、举报、删除自己的评论、
	本人待审即时可见、设备环境与地区展示（服务端解析）、官方回复徽章、
	访客账号渠道（已绑定微信/QQ 标签 + 未绑定渠道的 ?bind=1 绑定入口）。

	样式遵循默认主题设计系统（CSS 变量 + scoped style + 全局 .btn 类），
	状态色在本组件内定义并随 .dark 适配（主题未提供 danger/success 令牌）。
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { getCsrfToken } from '#lib/common/utils/csrf.ts';
	import { loadPluginMessages } from '#lib/cms/utils/i18n-client.ts';
	import {
		MAX_AUTHOR_NAME_LENGTH,
		MAX_EMAIL_LENGTH,
		MAX_WEBSITE_LENGTH,
		MAX_CONTENT_LENGTH,
		type PublicComment,
		type CommentListBody,
		type CommentSubmitBody
	} from '../shared';
	import { formatRelativeTime, letterOf, hueOf } from '../client/format';
	import {
		visitorBindUrl,
		visitorChannelStateOf,
		type VisitorAccountPayload,
		type VisitorChannelState
	} from '../visitor-channels';
	import CaptchaField from './CaptchaField.svelte';
	import EmojiPicker from './EmojiPicker.svelte';
	import MyComments from './MyComments.svelte';

	/** 评论项：与服务端 toPublic() 共享同一类型（shared.ts）——
	    此前本地手写一份，服务端加了 featured 客户端就漏字段（静默错位）。 */
	type CommentItem = PublicComment;

	let mounted = $state(false);
	let tops = $state<CommentItem[]>([]);
	let children = $state<CommentItem[]>([]);
	let page = $state(1);
	let hasMore = $state(false);
	let count = $state(0);
	let loading = $state(true);
	let loadingMore = $state(false);
	/**
	 * D1：被截断线程的续拉状态：rootId → { after: 已展示后代数, hasMore }。
	 * /list 首拉填充 truncatedThreads 后初始化（after=loaded）；每次续拉成功
	 * 推进 after，hasMore=false 时前端隐藏按钮。排序切换/重拉时重置。
	 */
	let threadPages = $state<Record<string, { after: number; hasMore: boolean; loading: boolean }>>(
		{}
	);
	let loadFailed = $state(false);
	let submitting = $state(false);
	let submitted = $state(false);
	/** 刚提交的评论是否进入待审（审核关闭时为 false，发布即公开） */
	let submittedPending = $state(true);
	let errorMsg = $state('');
	let content = $state('');
	let authorName = $state('');
	let email = $state('');
	let website = $state('');
	/** better-auth 登录态：非空时身份三字段隐藏，服务端按账号落库 */
	let account = $state<{ name: string } | null>(null);
	/**
	 * 访客身份（框架 /api/auth/visitor/session，支持微信与 QQ）：providers 控制
	 * 入口显隐，visitor 非空时隐藏身份三字段——昵称与头像来自签名 cookie，
	 * 服务端认定。已登录后再取一次账号渠道（/api/auth/visitor/account）：
	 * 一个访客 id 可挂微信与 QQ 两个渠道，没挂上的渠道给「绑定」入口，
	 * 避免用户换个渠道登录时被框架当成切换账号、评论拆成两份。
	 */
	let visitorProviders = $state<{ id: string; label: string; start: string }[]>([]);
	let visitor = $state<{ provider: string; nickname: string; avatar: string | null } | null>(null);
	/** 已登录时取到的账号渠道；null = 未取到（不展示明细也不引导绑定） */
	let channels = $state<VisitorChannelState | null>(null);
	let honeypot = $state('');
	let replyTo = $state<{ id: string; name: string } | null>(null);
	let replyContent = $state('');
	let replying = $state(false);
	let busyId = $state<string | null>(null);
	let flash = $state('');
	let likedIds = $state<Set<string>>(new Set());
	let bindingKey = $state<'contentId' | 'path'>('path');
	let contentId = $state<string | null>(null);
	/** 集合 slug（主题模板注入）：站点级类型白名单判定用，服务端仍会校验归属 */
	let contentType = $state<string | null>(null);
	/** 排序模式（C2-4）：latest 最新在前 / hot 最热（likes 降序）在前 */
	let sortMode = $state<'latest' | 'hot'>('latest');
	/** 内容级设置（C1-4，/list 回传）：closed 隐藏表单、requireLogin 提示登录 */
	let contentSettings = $state<{
		closed: boolean;
		requireLogin: boolean;
		featuredOnly: boolean;
	} | null>(null);
	/** 站点白名单未开启此绑定（/list enabled=false） */
	let siteEnabled = $state(true);
	/** B2b：站点开启「游客邮箱可留空」时输入框去掉必填（服务端同步放行） */
	let guestEmailOptional = $state(false);
	/** 站点允许匿名游客评论；关闭时未登录且无微信身份提示登录 */
	let guestAllowed = $state(true);
	/**
	 * 正文上限（站点可配，/list 下发）：先前硬编码 2000（服务端硬上限），
	 * 而站点默认配 500——用户能输 2000 字却在提交时被 400 拒绝，前台只给
	 * 一句笼统的「失败」。取服务端下发值，服务端硬上限作兜底。
	 */
	let maxContentLength = $state(MAX_CONTENT_LENGTH);
	/** 官方标（可选）：/list canOfficial=true（登录站方成员）时表单出「官方」勾选 */
	let canOfficial = $state(false);
	let markOfficial = $state(false);
	let replyOfficial = $state(false);
	/** CAPTCHA（C1-3）：框架启用 forms 作用域时渲染验证码并随提交上送 */
	let captchaRequired = $state(false);
	let captchaSvg = $state('');
	let captchaId = $state('');
	let captchaAnswer = $state('');
	let captchaLoading = $state(false);
	/** 编辑自己的评论（C2-3）：行内编辑态 */
	let editingId = $state<string | null>(null);
	let editContent = $state('');
	let editBusy = $state(false);
	/** emoji 选择器（C2-5）：目标输入区 main / reply */
	let emojiFor = $state<'main' | 'reply' | null>(null);
	let mainInputEl = $state<HTMLTextAreaElement | null>(null);
	let replyInputEl = $state<HTMLTextAreaElement | null>(null);

	const BASE = '/api/v1/plugin/comments';

	// 文案由插件注册、经 /api/v1/i18n/comments 下发（与服务端同一份，两端共用）；
	// 取词失败时回退 key 本身，不阻塞渲染
	let messages = $state<Record<string, string>>({});
	const tr = $derived((key: string) => messages[key] ?? key);
	const t = $derived({
		title: tr('title'),
		placeholder: tr('placeholder'),
		replyPlaceholder: tr('replyPlaceholder'),
		nameLabel: tr('nameLabel'),
		nameOptional: tr('nameOptional'),
		emailLabel: tr('emailLabel'),
		emailOptional: tr('emailOptional'),
		reportReasonLabel: tr('reportReasonLabel'),
		reportReasonPlaceholder: tr('reportReasonPlaceholder'),
		websiteLabel: tr('websiteLabel'),
		visitorLogin: tr('visitorLogin'),
		visitorAs: tr('visitorAs'),
		visitorLogout: tr('visitorLogout'),
		visitorBind: tr('visitorBind'),
		visitorAccount: tr('visitorAccount'),
		wechatBadge: tr('wechatBadge'),
		qqBadge: tr('qqBadge'),
		submit: tr('submit'),
		submitReply: tr('submitReply'),
		submitting: tr('submitting'),
		moderation: tr('moderation'),
		published: tr('published'),
		tooFast: tr('tooFast'),
		failed: tr('failed'),
		loadFailed: tr('loadFailed'),
		empty: tr('empty'),
		guest: tr('guest'),
		reply: tr('reply'),
		cancel: tr('cancel'),
		like: tr('like'),
		unlike: tr('unlike'),
		report: tr('report'),
		reported: tr('reported'),
		del: tr('del'),
		deleteConfirm: tr('deleteConfirm'),
		reportConfirm: tr('reportConfirm'),
		pendingBadge: tr('pendingBadge'),
		officialBadge: tr('officialBadge'),
		authorBadge: tr('authorBadge'),
		loadMore: tr('loadMore'),
		loadMoreReplies: tr('loadMoreReplies'),
		replyToPrefix: tr('replyToPrefix'),
		sortLatest: tr('sortLatest'),
		sortHot: tr('sortHot'),
		closed: tr('closed'),
		siteClosed: tr('siteClosed'),
		loginToComment: tr('loginToComment'),
		edit: tr('edit'),
		save: tr('save'),
		editedFailed: tr('editedFailed'),
		captchaLabel: tr('captchaLabel'),
		captchaPlaceholder: tr('captchaPlaceholder'),
		captchaFailed: tr('captchaFailed'),
		timeJustNow: tr('timeJustNow'),
		timeMinutesAgo: tr('timeMinutesAgo'),
		timeHoursAgo: tr('timeHoursAgo'),
		timeDaysAgo: tr('timeDaysAgo')
	});

	/**
	 * 相对时间（客户端组件，无 SSR 水合顾虑）；超一周回落本地日期。
	 * 文案走 i18n 词表（t.time*）——此前在函数里硬编码中英双语，站点接入
	 * 第三语言时无从扩展；且 <html lang> 未设时恒落到英文分支，中文站点
	 * 也显示「5m ago」。
	 */
	function timeOf(iso: string): string {
		return formatRelativeTime(iso, {
			justNow: t.timeJustNow,
			minutesAgo: t.timeMinutesAgo,
			hoursAgo: t.timeHoursAgo,
			daysAgo: t.timeDaysAgo
		});
	}

	function csrfHeaders(): Record<string, string> {
		return { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() };
	}

	function bindingParam(): string {
		const base =
			bindingKey === 'contentId' && contentId
				? `contentId=${encodeURIComponent(contentId)}`
				: `path=${encodeURIComponent(window.location.pathname)}`;
		// contentType 供 /list 的 enabled 标志按类型白名单判定（仅 UI 提示）
		return contentType ? `${base}&contentType=${encodeURIComponent(contentType)}` : base;
	}

	/** 登录 / 退出后回到当前文章（含查询串），由框架回调原路返回 */
	function returnTo(): string {
		return window.location.pathname + window.location.search;
	}

	/**
	 * 访客身份探测：框架统一访客接口（`/api/auth/visitor/session`）下发可用提供方
	 * 与社交登录态；未配置提供方时不显示入口，已登录时用昵称回填表单。
	 * 失败静默——评论本身不依赖这条链路。
	 */
	async function loadVisitor() {
		try {
			const res = await fetch('/api/auth/visitor/session', {
				headers: { accept: 'application/json' }
			});
			if (!res.ok) return;
			const body = (await res.json()) as {
				enabled?: boolean;
				providers?: { id: string; label: string; start: string }[];
				authenticated?: boolean;
				visitor?: { provider?: string; nickname?: string; avatar?: string | null } | null;
			};
			visitorProviders = body.providers ?? [];
			if (body.authenticated && body.visitor?.nickname) {
				visitor = {
					provider: body.visitor.provider ?? '',
					nickname: body.visitor.nickname,
					avatar: body.visitor.avatar ?? null
				};
				authorName = body.visitor.nickname;
				// 渠道明细与身份并行取（同一次探测，不额外等待登录链路）
				void loadChannels();
			}
		} catch {
			/* 增强能力失败不影响匿名评论 */
		}
	}

	/**
	 * 账号渠道：已挂在本访客账号下的微信 / QQ。读取失败只是少一块增强信息——
	 * 身份、评论、点赞都照常；此时不展示待绑定渠道，避免误把当前渠道再绑一遍。
	 */
	async function loadChannels() {
		try {
			const res = await fetch('/api/auth/visitor/account', {
				headers: { accept: 'application/json' },
				cache: 'no-store'
			});
			if (!res.ok) return;
			const body = (await res.json()) as VisitorAccountPayload;
			channels = visitorChannelStateOf(body, visitorProviders, visitor?.provider ?? null);
		} catch {
			/* 账号目录失败按「渠道未知」处理 */
		}
	}

	/**
	 * 访客提供方展示名：已知的微信/QQ 用插件 i18n（中英双语），其余提供方用
	 * 框架下发的 label，最后回落 id——新增提供方无需改插件。
	 */
	function providerLabel(id: string): string {
		if (id === 'wechat') return t.wechatBadge;
		if (id === 'qq') return t.qqBadge;
		return visitorProviders.find((p) => p.id === id)?.label ?? id;
	}

	async function fetchCount() {
		try {
			const res = await fetch(`${BASE}/count?${bindingParam()}`);
			if (res.ok) count = ((await res.json()) as { count?: number }).count ?? 0;
		} catch {
			/* 计数失败不阻塞主列表 */
		}
	}

	/** 「我的评论」面板里的增删改完成后：刷新本页列表与计数（状态可能已变） */
	function refreshAfterManage() {
		void load();
		void fetchCount();
	}

	/** /list 响应体：与服务端共享同一类型（shared.ts）——此前本地手写一份，
	    服务端新增 maxLength/minInterval 等字段时前端会静默丢弃。 */
	type ListBody = CommentListBody;

	async function fetchList(targetPage: number): Promise<ListBody> {
		const res = await fetch(
			`${BASE}/list?${bindingParam()}&page=${targetPage}&pageSize=20&sort=${sortMode}`
		);
		if (!res.ok) throw new Error(String(res.status));
		return (await res.json()) as ListBody;
	}

	/** CAPTCHA 签发（C1-3）：框架启用时 /list 回传 captchaRequired，此处拉取挑战 */
	async function loadCaptcha() {
		captchaLoading = true;
		try {
			const res = await fetch('/api/v1/captcha');
			const data = (await res.json()) as { enabled: boolean; id?: string; svg?: string };
			captchaId = data.id ?? '';
			captchaSvg = data.svg ?? '';
			captchaAnswer = '';
		} finally {
			captchaLoading = false;
		}
	}

	async function load() {
		// 绑定键：内容项 ID 优先（主题模板注入），查询为空则回落路径（兼容纯路径评论）
		const pageCtx = (window as unknown as { __CMS_PAGE__?: { id?: string; collection?: string } })
			.__CMS_PAGE__;
		contentId = pageCtx?.id ?? null;
		contentType = pageCtx?.collection ?? null;
		bindingKey = contentId ? 'contentId' : 'path';
		try {
			let body = await fetchList(1);
			if (contentId && (body.data?.length ?? 0) === 0 && (body.children?.length ?? 0) === 0) {
				bindingKey = 'path';
				body = await fetchList(1);
			}
			tops = body.data ?? [];
			children = body.children ?? [];
			likedIds = new Set(body.likedIds ?? []);
			hasMore = body.hasMore ?? false;
			page = 1;
			loadFailed = false;
			siteEnabled = body.enabled ?? true;
			guestEmailOptional = body.guestEmailOptional ?? false;
			guestAllowed = body.allowGuest ?? true;
			maxContentLength = body.maxLength ?? MAX_CONTENT_LENGTH;
			canOfficial = body.canOfficial ?? false;
			// 登录态由 /list 服务端按会话下发（本地无 better-auth HTTP 端点可探测）
			if (body.viewer) account = { name: body.viewer.name };
			// 回访免重填：服务端 HttpOnly cookie 记住的游客身份（/list 的 remembered）。
			// 只在首次加载应用，避免切排序/翻页覆盖用户当前输入。
			if (!account && !visitor && !identityRestored && body.remembered) {
				authorName = body.remembered.authorName;
				email = body.remembered.email;
				website = body.remembered.website;
				identityRestored = true;
			}
			contentSettings = body.contentSettings ?? null;
			// D1：重建被截线程的续拉游标（重拉/切排序都以最新一批为准）
			const nextPages: Record<string, { after: number; hasMore: boolean; loading: boolean }> = {};
			for (const t of body.truncatedThreads ?? []) {
				nextPages[t.rootId] = { after: t.loaded, hasMore: true, loading: false };
			}
			threadPages = nextPages;
			const needCaptcha = body.captchaRequired ?? false;
			if (needCaptcha && !captchaRequired) {
				captchaRequired = true;
				loadCaptcha();
			} else if (!needCaptcha) {
				captchaRequired = false;
			}
		} catch {
			loadFailed = true;
		} finally {
			loading = false;
		}
		fetchCount();
	}

	/** 切换排序（C2-4）：重拉列表（首页起，分页游标重置） */
	function setSort(mode: 'latest' | 'hot') {
		if (sortMode === mode) return;
		sortMode = mode;
		loading = true;
		load();
	}

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		try {
			const body = await fetchList(page + 1);
			tops = [...tops, ...(body.data ?? [])];
			children = [...children, ...(body.children ?? [])];
			// 翻页合并已赞集合（保留此前页/本会话内的点赞态）
			if (body.likedIds?.length) {
				likedIds = new Set([...likedIds, ...body.likedIds]);
			}
			hasMore = body.hasMore ?? false;
			page += 1;
		} catch {
			flash = t.failed;
		} finally {
			loadingMore = false;
		}
	}

	/**
	 * D1：单线程后代续拉（/list truncatedThreads 的「查看更多回复」）。
	 * 服务端按 createdAt 升序 + after offset 精确衔接（不重），此处仍以 id 去重
	 * 合并兜底并发/新评论竞态，合并后按升序重排（与 /list children 次序一致，
	 * repliesOf 分组依赖该序）。
	 */
	async function loadThreadReplies(rootId: string) {
		const st = threadPages[rootId];
		if (!st || st.loading || !st.hasMore) return;
		threadPages[rootId] = { ...st, loading: true };
		try {
			const res = await fetch(
				`${BASE}/children?${bindingParam()}&rootId=${encodeURIComponent(rootId)}&after=${st.after}&limit=50`
			);
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as {
				data?: CommentItem[];
				hasMore?: boolean;
				likedIds?: string[];
			};
			const batch = body.data ?? [];
			if (body.likedIds?.length) {
				likedIds = new Set([...likedIds, ...body.likedIds]);
			}
			if (batch.length > 0) {
				const seen = new Set(children.map((c) => c.id));
				const fresh = batch.filter((c) => !seen.has(c.id));
				if (fresh.length > 0) {
					const merged = [...children, ...fresh];
					merged.sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1));
					children = merged;
				}
			}
			threadPages[rootId] = {
				after: st.after + batch.length,
				hasMore: body.hasMore ?? false,
				loading: false
			};
		} catch {
			threadPages[rootId] = { ...st, loading: false };
			flash = t.failed;
		}
	}

	/**
	 * 按与 /list 完全一致的次序插入（顶层 createdAt 降序、回复升序）：
	 * 服务端就是这么排的，前端若盲插（顶层一律置顶 / 回复一律追加），
	 * 一旦本地时间不是最新（种子数据、导入评论、跨时区写入），
	 * 就会出现「刚发出在一个位置、刷新后跳到另一位置」。
	 */
	function insertOrdered(list: CommentItem[], item: CommentItem, dir: 'desc' | 'asc') {
		const at = list.findIndex((it) =>
			dir === 'desc'
				? String(it.createdAt) < String(item.createdAt)
				: String(it.createdAt) > String(item.createdAt)
		);
		if (at < 0) return [...list, item];
		return [...list.slice(0, at), item, ...list.slice(at)];
	}

	function localInsert(item: CommentItem) {
		if (item.rootId) children = insertOrdered(children, item, 'asc');
		else tops = insertOrdered(tops, item, 'desc');
		if (!item.pending) count += 1;
	}

	/** 访客身份回填是否已应用：只在首次加载预填一次，切排序/翻页不覆盖当前输入 */
	let identityRestored = $state(false);

	function buildPayload(): Record<string, unknown> {
		return {
			content: replyTo ? replyContent : content,
			// 登录用户 / 微信访客省略身份字段（服务端按账号或签名身份落库）
			authorName: account || visitor ? undefined : authorName,
			email: account || visitor ? undefined : email,
			website: account || visitor ? undefined : website || undefined,
			path: window.location.pathname,
			contentId: contentId ?? undefined,
			contentType: contentType ?? undefined,
			parentId: replyTo?.id ?? undefined,
			// 官方标（可选）：仅具备官方身份的登录用户（canOfficial）显示勾选，勾选随提交
			// 上送；服务端 canPostOfficial 权威复核，无身份即便传也强制 false（防伪造）
			official: (replyTo ? replyOfficial : markOfficial) ? true : undefined,
			// CAPTCHA（C1-3）：框架启用时随提交上送，服务端一次性消费
			captchaId: captchaRequired ? captchaId || undefined : undefined,
			captchaAnswer: captchaRequired ? captchaAnswer || undefined : undefined,
			_hp: honeypot
		};
	}

	/** /submit 回传的是 toPublic 投影 + status，与 /list 单条同构 */
	/** /submit 响应体：与服务端共享（shared.ts） */
	type SubmitBody = CommentSubmitBody;

	function afterSubmit(body: SubmitBody) {
		const item = body.comment;
		if (!item || item.status === 'spam') return;
		// 直接用服务端投影：头像、环境信息、主页、归属全部权威，
		// 前端不再猜（此前 avatar 恒为 null → 新评论只显示字母色块，刷新后才正确）
		// 解构掉 status（服务端附加的审核态列，不属于公开投影）
		const { status: _status, ...publicItem } = item;
		localInsert(publicItem);
		// 是否待审由服务端判定（审核开关关闭时直接 approved，提示语随之变化）
		submittedPending = item.pending;
		// 身份回填由服务端写入 HttpOnly cookie（/submit 落库成功后写），前端不落任何存储
	}

	/**
	 * 提交（顶层评论与回复共用）。
	 *
	 * 此前 submit() 与 submitReply() 是两份 90% 相同的实现——同为 POST
	 * /submit、同一套 429 / 204 / 2xx / 403 四分支处理，只有「清哪些输入
	 * 字段」与「用哪个 busy 标志」不同。两份各写一遍的代价是：改一处分支
	 * 忘了另一处（如加验证码重试时只改了一个），行为随提交入口不同而分叉。
	 *
	 * 现在共用一条路径，差异以参数传入：
	 * - kind：决定成功后清理哪组字段
	 * - busy 标志由调用方自行置位/复位（提交期间禁用按钮）
	 */
	async function postComment(
		kind: 'main' | 'reply'
	): Promise<'ok' | 'spam' | 'failed' | 'ratelimited' | 'captcha'> {
		try {
			const res = await fetch(`${BASE}/submit`, {
				method: 'POST',
				headers: csrfHeaders(),
				body: JSON.stringify(buildPayload())
			});
			if (res.status === 429) {
				errorMsg = t.tooFast;
				return 'ratelimited';
			}
			if (res.status === 204) {
				// 蜜罐命中：服务端静默成功，无响应体——不可调 json()（会抛错落进
				// catch 显示「操作失败」，等于告诉机器人被拦了）。按成功收尾。
				submitted = true;
				clearInputs(kind);
				return 'ok';
			}
			if (res.ok) {
				afterSubmit((await res.json()) as SubmitBody);
				submitted = true;
				clearInputs(kind);
				if (captchaRequired) loadCaptcha();
				return 'ok';
			}
			// CAPTCHA 失败（403 + Captcha 文案）：换新挑战让用户重试
			const captchaFailed = await isCaptchaFailure(res);
			errorMsg = captchaFailed ? t.captchaFailed : t.failed;
			if (captchaFailed && captchaRequired) loadCaptcha();
			return captchaFailed ? 'captcha' : 'failed';
		} catch {
			errorMsg = t.failed;
			return 'failed';
		}
	}

	/** 提交成功后清理对应入口的输入字段 */
	function clearInputs(kind: 'main' | 'reply') {
		if (kind === 'main') {
			content = '';
			replyTo = null;
			replyContent = '';
			markOfficial = false;
		} else {
			replyContent = '';
			replyTo = null;
			replyOfficial = false;
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (submitting) return;
		errorMsg = '';
		submitted = false;
		submitting = true;
		try {
			await postComment('main');
		} finally {
			submitting = false;
		}
	}

	async function submitReply(c: CommentItem) {
		if (replying || !replyContent.trim()) return;
		replying = true;
		errorMsg = '';
		try {
			await postComment('reply');
		} finally {
			replying = false;
		}
	}

	/** 识别 CAPTCHA 校验失败（403 + error 文案含 Captcha） */
	async function isCaptchaFailure(res: Response): Promise<boolean> {
		try {
			const body = (await res.json()) as { error?: string };
			return !!body.error && body.error.includes('Captcha');
		} catch {
			return false;
		}
	}

	// ─── 编辑自己的评论（C2-3） ───

	function startEdit(c: CommentItem) {
		editingId = c.id;
		editContent = c.content;
	}

	function cancelEdit() {
		editingId = null;
		editContent = '';
	}

	async function saveEdit(c: CommentItem) {
		if (editBusy || !editContent.trim()) return;
		editBusy = true;
		try {
			const res = await fetch(`${BASE}/edit`, {
				method: 'POST',
				headers: csrfHeaders(),
				body: JSON.stringify({ id: c.id, content: editContent })
			});
			if (res.ok) {
				const body = (await res.json()) as { content?: string; pending?: boolean };
				const patch = (it: CommentItem) => ({
					...it,
					content: body.content ?? it.content,
					pending: body.pending ?? it.pending
				});
				tops = tops.map((it) => (it.id === c.id ? patch(it) : it));
				children = children.map((it) => (it.id === c.id ? patch(it) : it));
				// 已发布评论在审核开启时编辑后回待审，公开计数随之变化
				void fetchCount();
				cancelEdit();
			} else {
				flashOnce(t.editedFailed);
			}
		} catch {
			flashOnce(t.editedFailed);
		} finally {
			editBusy = false;
		}
	}

	// ─── emoji 选择器（C2-5，纯前端轻量起步） ───

	/** 面板展开方向：默认从按钮向右；按钮距表单右缘放不下 264px 时贴右缘向左 */
	let emojiAlign = $state<'left' | 'right'>('left');

	function toggleEmojiPicker(target: 'main' | 'reply', btn?: HTMLElement | null) {
		if (emojiFor === target) {
			emojiFor = null;
			return;
		}
		if (btn) {
			const form = btn.closest('form') ?? btn.closest('.composer');
			const space = form
				? form.getBoundingClientRect().right - btn.getBoundingClientRect().right
				: 999;
			emojiAlign = space >= 272 ? 'left' : 'right';
		}
		emojiFor = target;
	}

	// 点面板外收起：打开期间监听 pointerdown，落在 emoji 锚点（主表单
	// .emoji-anchor / 回复表单 .reply-form-actions 含面板与按钮）之外即关闭。
	// 按钮自身在锚点内——收起由原 toggle 负责，避免此处先关后 toggle 又开。
	$effect(() => {
		if (!emojiFor) return;
		const onDocDown = (e: PointerEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t?.closest?.('.emoji-anchor, .reply-form-actions')) emojiFor = null;
		};
		document.addEventListener('pointerdown', onDocDown, true);
		return () => document.removeEventListener('pointerdown', onDocDown, true);
	});

	function insertEmoji(code: string) {
		const isReply = emojiFor === 'reply';
		const el = isReply ? replyInputEl : mainInputEl;
		const cur = isReply ? replyContent : content;
		let next = cur + code;
		if (el && el.selectionStart !== null) {
			const s = el.selectionStart;
			const e = el.selectionEnd ?? s;
			next = cur.slice(0, s) + code + cur.slice(e);
		}
		if (isReply) replyContent = next;
		else content = next;
		emojiFor = null;
	}

	function flashOnce(msg: string) {
		flash = msg;
		setTimeout(() => (flash = ''), 2500);
	}

	async function like(c: CommentItem) {
		if (busyId === c.id) return;
		busyId = c.id;
		try {
			const res = await fetch(`${BASE}/like`, {
				method: 'POST',
				headers: csrfHeaders(),
				body: JSON.stringify({ id: c.id })
			});
			if (res.ok) {
				const body = (await res.json()) as { liked?: boolean; likes?: number };
				const likes = body.likes ?? (body.liked ? c.likes + 1 : Math.max(0, c.likes - 1));
				tops = tops.map((it) => (it.id === c.id ? { ...it, likes } : it));
				children = children.map((it) => (it.id === c.id ? { ...it, likes } : it));
				// toggle：服务端为准（已赞→取消、未赞→点赞）
				const next = new Set(likedIds);
				if (body.liked) next.add(c.id);
				else next.delete(c.id);
				likedIds = next;
			}
		} finally {
			busyId = null;
		}
	}

	async function report(c: CommentItem) {
		if (busyId === c.id) return;
		// C2：确认 + 可选理由合并为单次 prompt（提示文本自带换行）——取消（null）
		// 放弃举报，确定但留空（''）按无理由上报；服务端只存非空理由
		const reason = window.prompt(`${t.reportConfirm}\n${t.reportReasonPlaceholder}`);
		if (reason === null) return;
		busyId = c.id;
		try {
			const trimmed = reason.trim();
			const res = await fetch(`${BASE}/report`, {
				method: 'POST',
				headers: csrfHeaders(),
				body: JSON.stringify({ id: c.id, ...(trimmed ? { reason: trimmed.slice(0, 200) } : {}) })
			});
			if (res.ok) {
				const body = (await res.json()) as { status?: string };
				if (body.status === 'pending') {
					const doomed = collectDoomed(c.id);
					tops = tops.filter((it) => !doomed.has(it.id));
					children = children.filter((it) => !doomed.has(it.id));
					count = Math.max(0, count - 1);
				}
				flashOnce(t.reported);
			}
		} finally {
			busyId = null;
		}
	}

	async function remove(c: CommentItem) {
		if (!confirm(t.deleteConfirm) || busyId === c.id) return;
		busyId = c.id;
		try {
			const res = await fetch(`${BASE}/delete`, {
				method: 'POST',
				headers: csrfHeaders(),
				body: JSON.stringify({ id: c.id })
			});
			if (res.ok) {
				const doomed = collectDoomed(c.id);
				tops = tops.filter((it) => !doomed.has(it.id));
				children = children.filter((it) => !doomed.has(it.id));
				// 级联删线程时删掉的可能不止一条，计数交给服务端重算
				void fetchCount();
			} else {
				flashOnce(t.failed);
			}
		} catch {
			flashOnce(t.failed);
		} finally {
			busyId = null;
		}
	}

	/** 回复平铺挂在根评论下（rootId 线程分组），渲染时不再逐层嵌套 */
	const repliesOf = $derived.by(() => {
		const map = new Map<string, CommentItem[]>();
		for (const it of children) {
			const key = it.rootId ?? it.parentId ?? '';
			if (!key) continue;
			const list = map.get(key) ?? [];
			list.push(it);
			map.set(key, list);
		}
		return map;
	});

	/** id → 评论（解析「回复 @目标」昵称用） */
	const itemById = $derived.by(() => {
		const map = new Map<string, CommentItem>();
		for (const it of tops) map.set(it.id, it);
		for (const it of children) map.set(it.id, it);
		return map;
	});

	function replyTargetName(c: CommentItem): string | null {
		if (!c.parentId) return null;
		const parent = itemById.get(c.parentId);
		return parent ? (parent.authorName ?? t.guest) : null;
	}

	/** 评论条目锚点 id（回复 @目标 点击跳转到被回复条目） */
	function commentAnchorId(id: string): string {
		return `comment-${id}`;
	}

	/** 跳转落点高亮的目标评论 id（state 驱动 class，替代运行时 classList.add
	    ——既让 Svelte 静态识别 .is-jump-flash 选择器，也符合组件化） */
	let jumpFlashId = $state<string | null>(null);

	/** 跳转到被回复的评论：平滑滚动到条目并高亮闪一下。目标必在 DOM——
	    reply-target 仅在父评论已加载（itemById 命中，tops∪children 均已渲染）时才渲染。 */
	function jumpToParent(id: string | null | undefined) {
		if (!id) return;
		const el = document.getElementById(commentAnchorId(id));
		if (!el) return;
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		jumpFlashId = id;
		window.setTimeout(() => {
			if (jumpFlashId === id) jumpFlashId = null;
		}, 1600);
	}

	/** 收集 id 及其全部后代（children 平铺存储，沿 parentId 链扩散） */
	function collectDoomed(id: string): Set<string> {
		const doomed = new Set<string>([id]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const it of children) {
				if (it.parentId && doomed.has(it.parentId) && !doomed.has(it.id)) {
					doomed.add(it.id);
					grew = true;
				}
			}
		}
		return doomed;
	}

	onMount(() => {
		mounted = true;
		// 取插件文案（zh/en 由服务端按当前语言下发，组件不再自带双语）
		loadPluginMessages('comments').then((m) => (messages = m));
		// 访客身份与列表并行探测：框架未配置微信/QQ 时入口自动隐藏
		loadVisitor();
		// 登录态不再于此探测：本应用 better-auth 端点不走 HTTP（/api/auth/*
		// 一律 410 Gone），由 /list 响应 viewer 字段随数据下发（load 内接线）
		load();
	});
</script>

{#if mounted}
	<section class="sc-comments">
		<div class="sc-comments-head">
			<h2 class="sc-comments-title">
				{t.title}
				{#if count > 0}<span class="sc-comments-count">{count}</span>{/if}
			</h2>
			<!-- 我的评论：访客按统一访客 id、登录用户按账号管理自己发过的评论 -->
			<MyComments maxLength={maxContentLength} onchanged={refreshAfterManage} />
		</div>

		<!-- 发表区在列表上方（twikoo 式）。三级联动门控：站点白名单（enabled）→
		     创作者关闭（contentSettings.closed）→ 创作者要求登录（requireLogin） -->
		{#if !siteEnabled}
			<p class="sc-comments-note">{t.siteClosed}</p>
		{:else if contentSettings?.closed}
			<p class="sc-comments-note">{t.closed}</p>
		{:else if !guestAllowed && !account && !visitor}
			<p class="sc-comments-note">
				{t.loginToComment}
				{#each visitorProviders as provider (provider.id)}
					<a
						class="wechat-link"
						href={`${provider.start}?returnTo=${encodeURIComponent(returnTo())}`}
					>
						{t.visitorLogin.replace('{provider}', providerLabel(provider.id))}
					</a>
				{/each}
			</p>
		{:else if contentSettings?.requireLogin && !account && !visitor}
			<p class="sc-comments-note">{t.loginToComment}</p>
		{:else}
			<form class="composer" onsubmit={submit}>
				<!-- 蜜罐：视觉隐藏但不在 display:none（防自动填充/爬虫识别），填了即机器人 -->
				<div class="honeypot" aria-hidden="true">
					<label for="comment-hp">Leave blank</label>
					<input
						id="comment-hp"
						name="_hp"
						type="text"
						bind:value={honeypot}
						tabindex="-1"
						autocomplete="off"
					/>
				</div>

				<label class="sr-only" for="comment-content">{t.title}</label>
				<textarea
					id="comment-content"
					class="field"
					bind:value={content}
					bind:this={mainInputEl}
					rows="3"
					maxlength={maxContentLength}
					required
					placeholder={t.placeholder}></textarea>

				<!-- 访客身份：未登录显示微信/QQ入口，已登录显示昵称、已绑定渠道与退出；
				     身份三字段随之隐藏 -->
				{#if visitor}
					<div class="wechat-identity">
						{#if visitor.avatar}
							<img class="wechat-avatar" src={visitor.avatar} alt="" />
						{/if}
						<span class="wechat-name">
							{t.visitorAs.replace('{name}', visitor.nickname)}
						</span>
						<!-- 已绑定渠道：同一访客账号挂多个渠道后，从任一入口登录都是同一份评论 -->
						{#each channels?.bound ?? [] as binding (binding.provider)}
							<span
								class="channel-chip"
								class:is-current={binding.provider === channels?.current}
								title={providerLabel(binding.provider)}
							>
								{providerLabel(binding.provider)}
							</span>
						{/each}
						<!-- 未绑定渠道：走 bind=1 挂到当前账号；直接登录会被框架当成切换账号 -->
						{#each (channels?.available ?? []).filter((provider) => provider.start) as provider (provider.id)}
							{@const bindUrl = visitorBindUrl(provider.start, returnTo())}
							<a class="wechat-link" href={bindUrl} title={provider.label}>
								{t.visitorBind.replace('{provider}', providerLabel(provider.id))}
							</a>
						{/each}
						<!-- 账号页链接只在账号端点可用时出现：更早的框架版本没有该页面 -->
						{#if channels}
							<a class="wechat-link is-quiet" href="/account">{t.visitorAccount}</a>
						{/if}
						<a
							class="wechat-link"
							href={`/api/auth/visitor/logout?returnTo=${encodeURIComponent(returnTo())}`}
						>
							{t.visitorLogout}
						</a>
					</div>
				{:else if visitorProviders.length > 0 && !account}
					<div class="wechat-identity">
						{#each visitorProviders as provider (provider.id)}
							<a
								class="wechat-link"
								href={`${provider.start}?returnTo=${encodeURIComponent(returnTo())}`}
							>
								{t.visitorLogin.replace('{provider}', providerLabel(provider.id))}
							</a>
						{/each}
					</div>
				{/if}

				<div class="composer-meta">
					{#if !account && !visitor}
						<input
							id="comment-author"
							class="field field-sm"
							type="text"
							bind:value={authorName}
							maxlength={MAX_AUTHOR_NAME_LENGTH}
							placeholder={t.nameOptional}
							autocomplete="name"
						/>
						<input
							id="comment-email"
							class="field field-sm"
							type="email"
							bind:value={email}
							maxlength={MAX_EMAIL_LENGTH}
							required={!guestEmailOptional}
							placeholder={guestEmailOptional ? t.emailOptional : t.emailLabel}
							autocomplete="email"
						/>
						<input
							id="comment-website"
							class="field field-sm"
							type="url"
							bind:value={website}
							maxlength={MAX_WEBSITE_LENGTH}
							placeholder={t.websiteLabel}
							autocomplete="url"
						/>
					{/if}
					<span class="composer-actions">
						<span class="emoji-anchor">
							<button
								type="button"
								class="btn-emoji"
								title="emoji"
								aria-label="emoji"
								onclick={(e) => toggleEmojiPicker('main', e.currentTarget)}
							>
								😊
							</button>
							<!-- 浮层：从 emoji 按钮上方弹出（右缘对齐、向左展开），不顶起表单 -->
							{#if emojiFor === 'main'}
								<EmojiPicker flip={emojiAlign === 'right'} onpick={insertEmoji} />
							{/if}
						</span>
						{#if canOfficial}
							<label class="official-check">
								<input type="checkbox" bind:checked={markOfficial} />
								{t.officialBadge}
							</label>
						{/if}
						<button type="submit" class="btn btn-primary" disabled={submitting}>
							{submitting ? t.submitting : t.submit}
						</button>
					</span>
				</div>

				{#if captchaRequired}
					<CaptchaField
						svg={captchaSvg}
						bind:answer={captchaAnswer}
						loading={captchaLoading}
						label={t.captchaLabel}
						onrefresh={loadCaptcha}
					/>
				{/if}

				{#if submitted}
					<p class="sc-comments-note is-success">{submittedPending ? t.moderation : t.published}</p>
				{:else if errorMsg}
					<p class="sc-comments-note is-danger">{errorMsg}</p>
				{/if}
				{#if flash}
					<p class="sc-comments-note is-success">{flash}</p>
				{/if}
			</form>
		{/if}

		{#if !loading && (tops.length > 0 || hasMore)}
			<div class="sc-comments-sort" role="tablist" aria-label="{t.sortLatest}/{t.sortHot}">
				<button
					type="button"
					class:is-active={sortMode === 'latest'}
					onclick={() => setSort('latest')}
				>
					{t.sortLatest}
				</button>
				<button type="button" class:is-active={sortMode === 'hot'} onclick={() => setSort('hot')}>
					{t.sortHot}
				</button>
			</div>
		{/if}

		{#if loading}
			<p class="sc-comments-note">…</p>
		{:else if loadFailed}
			<p class="sc-comments-note is-danger">{t.loadFailed}</p>
		{:else if tops.length === 0}
			<p class="sc-comments-empty">{t.empty}</p>
		{:else}
			<div class="sc-comments-list">
				{#each tops as c (c.id)}
					<!-- {@const} 必须是 each 的直接子级（Svelte 5 规则），置于 div.thread 之前 -->
					{@const threadPage = threadPages[c.id]}
					<div class="thread">
						{@render commentRow(c, false)}
						{#if (repliesOf.get(c.id)?.length ?? 0) > 0 || threadPage}
							<div class="replies">
								{#each repliesOf.get(c.id) ?? [] as r (r.id)}
									{@render commentRow(r, true)}
								{/each}
								{#if threadPage?.hasMore}
									<button
										type="button"
										class="btn btn-sm load-replies"
										disabled={threadPage.loading}
										onclick={() => loadThreadReplies(c.id)}
									>
										{threadPage.loading ? '…' : t.loadMoreReplies}
									</button>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>

			{#if hasMore}
				<div class="sc-comments-more">
					<button type="button" class="btn" disabled={loadingMore} onclick={loadMore}>
						{loadingMore ? '…' : t.loadMore}
					</button>
				</div>
			{/if}
		{/if}
	</section>
{/if}

{#snippet commentRow(c: CommentItem, isReply: boolean)}
	<article
		class="comment"
		id={commentAnchorId(c.id)}
		class:is-reply={isReply}
		class:is-jump-flash={jumpFlashId === c.id}
	>
		<span class="avatar" style="--hue: {hueOf(c.authorName)}">
			{letterOf(c.authorName)}
			{#if c.avatar}
				<img
					class="avatar-img"
					src={c.avatar}
					alt=""
					loading="lazy"
					onerror={(e) => e.currentTarget.remove()}
				/>
			{/if}
		</span>
		<div class="comment-main">
			<div class="comment-head">
				{#if c.website}
					<a class="comment-author" href={c.website} target="_blank" rel="nofollow noopener">
						{c.authorName ?? t.guest}
					</a>
				{:else}
					<span class="comment-author">{c.authorName ?? t.guest}</span>
				{/if}
				{#if c.official}
					<span class="badge is-official">{t.officialBadge}</span>
				{:else if c.isAuthor}
					<span class="badge is-author">{t.authorBadge}</span>
				{/if}
				{#if c.visitorProvider}
					<span
						class="badge"
						class:is-wechat={c.visitorProvider === 'wechat'}
						class:is-qq={c.visitorProvider === 'qq'}
					>
						{providerLabel(c.visitorProvider)}
					</span>
				{/if}
				{#if c.pending}
					<span class="badge">{t.pendingBadge}</span>
				{/if}
				<time class="comment-time">{timeOf(c.createdAt)}</time>
			</div>
			{#if editingId === c.id}
				<div class="edit-form">
					<textarea
						class="field"
						bind:value={editContent}
						rows="3"
						maxlength={maxContentLength}
						required></textarea>
					<div class="reply-form-actions">
						<button
							type="button"
							class="btn btn-primary btn-sm"
							disabled={editBusy}
							onclick={() => saveEdit(c)}
						>
							{editBusy ? '…' : t.save}
						</button>
						<button type="button" class="btn btn-sm" onclick={cancelEdit}>{t.cancel}</button>
					</div>
				</div>
			{:else}
				<p class="comment-body">
					{#if isReply && c.parentId && replyTargetName(c)}
						<span class="reply-target">
							{t.replyToPrefix}
							<button type="button" class="reply-mention" onclick={() => jumpToParent(c.parentId)}>
								@{replyTargetName(c)}
							</button>
						</span>
					{/if}{c.content}
				</p>
			{/if}
			{#if c.os || c.browser || c.region}
				<p class="comment-env">
					{#if c.region}<span>{c.region}</span>{/if}
					{#if c.os}<span>{c.os}</span>{/if}
					{#if c.browser}<span>{c.browser}</span>{/if}
				</p>
			{/if}
			<div class="comment-actions">
				<button
					type="button"
					onclick={() =>
						(replyTo = replyTo?.id === c.id ? null : { id: c.id, name: c.authorName ?? t.guest })}
				>
					{t.reply}
				</button>
				<button
					type="button"
					class:is-liked={likedIds.has(c.id)}
					disabled={busyId === c.id}
					aria-pressed={likedIds.has(c.id)}
					title={likedIds.has(c.id) ? t.unlike : t.like}
					onclick={() => like(c)}
				>
					♥ {c.likes > 0 ? c.likes : ''}
					{likedIds.has(c.id) ? '' : t.like}
				</button>
				<button type="button" onclick={() => report(c)}>{t.report}</button>
				{#if c.mine && editingId !== c.id}
					<button type="button" onclick={() => startEdit(c)}>{t.edit}</button>
				{/if}
				{#if c.mine}
					<button type="button" class="is-danger" onclick={() => remove(c)}>{t.del}</button>
				{/if}
			</div>

			{#if replyTo?.id === c.id}
				<form
					class="reply-form"
					onsubmit={(e) => {
						e.preventDefault();
						submitReply(c);
					}}
				>
					<p class="reply-form-hint">
						{t.replyToPrefix} @{replyTo.name}
					</p>
					<textarea
						class="field"
						bind:value={replyContent}
						bind:this={replyInputEl}
						rows="2"
						maxlength={maxContentLength}
						required
						placeholder={t.replyPlaceholder}></textarea>
					{#if captchaRequired}
						<CaptchaField
							svg={captchaSvg}
							bind:answer={captchaAnswer}
							loading={captchaLoading}
							label={t.captchaLabel}
							onrefresh={loadCaptcha}
						/>
					{/if}
					<div class="reply-form-actions">
						<button
							type="button"
							class="btn-emoji"
							aria-label="emoji"
							onclick={(e) => toggleEmojiPicker('reply', e.currentTarget)}
						>
							😊
						</button>
						<!-- 浮层：同主表单，不顶起操作行 -->
						{#if emojiFor === 'reply'}
							<EmojiPicker flip={emojiAlign === 'right'} onpick={insertEmoji} />
						{/if}
						{#if canOfficial}
							<label class="official-check">
								<input type="checkbox" bind:checked={replyOfficial} />
								{t.officialBadge}
							</label>
						{/if}
						<button type="submit" class="btn btn-primary btn-sm" disabled={replying}>
							{replying ? t.submitting : t.submitReply}
						</button>
						<button type="button" class="btn btn-sm" onclick={() => (replyTo = null)}>
							{t.cancel}
						</button>
					</div>
				</form>
			{/if}
		</div>
	</article>
{/snippet}

<style>
	/* 主题未提供语义状态色，本组件内自定义并随 .dark 适配（applyTheme 保证
	   html 的 .dark class 始终反映实际生效模式，含 auto 档） */
	.sc-comments {
		--c-danger: #dc2626;
		--c-success: #16a34a;
	}
	:global(.dark) .sc-comments {
		--c-danger: #f87171;
		--c-success: #4ade80;
	}

	.sc-comments {
		margin-top: var(--space-8, 2rem);
		padding-top: var(--space-8, 2rem);
		border-top: 1px solid var(--color-border-light);
		/* 显示自定义钩子（站长在主题 CSS 覆盖）：头像尺寸/间距可按主题微调；
		   container 查询让评论区随所在容器（全宽 or 侧栏窄栏）自适应布局 */
		container: comments / inline-size;
		--comments-avatar-size: 36px;
		--comments-avatar-size-sm: 28px;
		--comments-thread-gap: var(--space-3, 0.75rem);
	}

	/* 标题行：左侧标题 + 计数，右侧「我的评论」入口（面板从入口下方展开） */
	.sc-comments-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3, 0.75rem);
		margin-bottom: var(--space-4, 1rem);
	}
	.sc-comments-title {
		display: flex;
		align-items: center;
		gap: var(--space-2, 0.5rem);
		font-size: var(--text-lg, 1.125rem);
		font-weight: 600;
		margin: 0;
	}

	.sc-comments-count {
		padding: 0 var(--space-2, 0.5rem);
		font-size: var(--text-xs, 0.75rem);
		font-weight: 500;
		line-height: 1.7;
		color: var(--color-text-secondary);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 999px;
	}

	/* 平铺列表（twikoo 式）：无线条无卡片，线程之间以留白分隔 */
	.sc-comments-list {
		display: grid;
		gap: var(--space-6, 1.5rem);
		margin-top: var(--space-4, 1rem);
		min-width: 0;
	}
	.thread {
		min-width: 0;
	}

	/* twikoo 式平铺行：无卡片背景/边框，线程之间留白分隔 */
	.comment {
		display: flex;
		gap: var(--comments-thread-gap);
		padding: var(--space-3, 0.75rem) 0;
	}
	.comment.is-reply {
		padding: var(--space-2, 0.5rem) 0;
	}
	.comment.is-reply .avatar {
		width: var(--comments-avatar-size-sm);
		height: var(--comments-avatar-size-sm);
		font-size: var(--text-xs, 0.75rem);
	}

	.avatar {
		position: relative;
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: var(--comments-avatar-size);
		height: var(--comments-avatar-size);
		font-size: var(--text-sm, 0.875rem);
		font-weight: 600;
		color: #fff;
		background: hsl(var(--hue, 220) 45% 48%);
		border-radius: 999px;
		user-select: none;
		overflow: hidden;
	}
	:global(.dark) .avatar {
		background: hsl(var(--hue, 220) 38% 58%);
	}
	.avatar-img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.comment-main {
		flex: 1;
		min-width: 0;
	}

	.comment-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 0.5rem);
		overflow-wrap: anywhere;
	}

	.comment-author {
		font-size: var(--text-sm, 0.875rem);
		font-weight: 600;
		color: var(--color-text);
		text-decoration: none;
	}
	a.comment-author:hover {
		color: var(--color-primary);
	}

	.badge {
		padding: 0 var(--space-2, 0.5rem);
		font-size: var(--text-xs, 0.75rem);
		font-weight: 500;
		line-height: 1.7;
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border);
		border-radius: 999px;
	}
	.badge.is-official {
		color: var(--color-primary);
		background: var(--color-primary-light);
		border-color: transparent;
	}
	/* 作者标：内容作者自评徽章——中性偏绿，与站方「官方」标区分层级 */
	.badge.is-author {
		color: var(--c-success);
		background: transparent;
		border-color: color-mix(in oklab, var(--c-success) 45%, transparent);
	}
	/* 微信标：访客经公众号网页授权登录后提交——微信品牌绿，与作者标区分 */
	.badge.is-wechat {
		color: #07c160;
		background: transparent;
		border-color: color-mix(in oklab, #07c160 45%, transparent);
	}
	/* QQ 标：访客经 QQ 互联登录后提交 */
	.badge.is-qq {
		color: #12b7f5;
		background: transparent;
		border-color: color-mix(in oklab, #12b7f5 45%, transparent);
	}

	.wechat-identity {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2, 0.5rem);
		align-items: center;
		margin-bottom: var(--space-2, 0.5rem);
		font-size: var(--text-sm, 0.875rem);
		color: var(--color-text-secondary);
	}
	.wechat-avatar {
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 999px;
		object-fit: cover;
	}
	.wechat-link {
		color: #07c160;
		text-decoration: none;
		font-weight: 500;
	}
	.wechat-link:hover {
		text-decoration: underline;
	}
	/* 账号页入口是次要动作：中性色，不抢「绑定 / 退出」的视觉权重 */
	.wechat-link.is-quiet {
		color: var(--color-text-muted);
		font-weight: 400;
	}

	/* 已绑定渠道：小圆角标签；当前正在用的渠道描边用主色 */
	.channel-chip {
		padding: 0 var(--space-2, 0.5rem);
		font-size: var(--text-xs, 0.75rem);
		font-weight: 500;
		line-height: 1.6;
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		white-space: nowrap;
	}
	.channel-chip.is-current {
		color: var(--color-primary);
		border-color: color-mix(in oklab, var(--color-primary) 45%, transparent);
	}

	.comment-time {
		margin-left: auto;
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.comment-body {
		margin-top: var(--space-1, 0.25rem);
		font-size: var(--text-sm, 0.875rem);
		line-height: 1.7;
		/* anywhere 同时参与最小内容宽度计算：长 URL / 无空格串不会把评论行
		   与整块列表撑出容器（break-word 只影响换行，不改变 min-content） */
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.comment-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3, 0.75rem);
		margin-top: var(--space-2, 0.5rem);
	}
	.comment-actions button {
		padding: 0;
		font-size: var(--text-xs, 0.75rem);
		font-family: inherit;
		color: var(--color-text-muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: color var(--transition-fast, 0.18s ease);
	}
	.comment-actions button:hover {
		color: var(--color-primary);
	}
	.comment-actions button:disabled {
		cursor: default;
	}
	.comment-actions button.is-liked {
		color: var(--color-primary);
		font-weight: 600;
	}
	.comment-actions button.is-danger:hover {
		color: var(--c-danger);
	}

	/* 回复平铺在根评论下一层（twikoo 式），缩进对齐根评论正文左缘 */
	.thread {
		display: grid;
		gap: var(--space-2, 0.5rem);
	}
	.replies {
		display: grid;
		gap: var(--space-2, 0.5rem);
		margin-left: calc(var(--comments-avatar-size) + var(--comments-thread-gap));
	}

	.reply-target {
		margin-right: var(--space-2, 0.5rem);
		font-weight: 600;
		color: var(--color-text-secondary);
	}
	/* 「@目标」为唯一可点击区（跳转被回复条目），「回复」前缀保持静态 */
	.reply-mention {
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		cursor: pointer;
		transition: color var(--transition-fast, 0.18s ease);
	}
	.reply-mention:hover {
		color: var(--color-primary);
	}

	/* 跳转落点高亮：左侧强调条 + 底色短暂闪动（平滑滚动结束同时开始；
	   is-jump-flash 类由 jumpFlashId state 驱动） */
	.comment.is-jump-flash {
		border-radius: var(--radius-md, 0.5rem);
		animation: comment-jump-flash 1.6s ease-out;
	}
	@keyframes comment-jump-flash {
		0%,
		35% {
			background: color-mix(in oklab, var(--color-primary) 10%, transparent);
			box-shadow: inset 3px 0 0 var(--color-primary);
		}
		100% {
			background: transparent;
			box-shadow: inset 3px 0 0 transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.comment.is-jump-flash {
			animation: none;
			background: color-mix(in oklab, var(--color-primary) 10%, transparent);
		}
	}

	.comment-env {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3, 0.75rem);
		margin-top: var(--space-1, 0.25rem);
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-muted);
	}

	.reply-form {
		display: grid;
		gap: var(--space-2, 0.5rem);
		margin-top: var(--space-3, 0.75rem);
	}
	.reply-form-hint {
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary);
	}
	.reply-form-actions {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 0.5rem);
		min-width: 0;
	}
	.reply-form-actions > * {
		min-width: 0;
	}
	.btn-sm {
		padding: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
		font-size: var(--text-xs, 0.75rem);
	}

	.sc-comments-more {
		display: flex;
		justify-content: center;
		margin-top: var(--space-4, 1rem);
	}

	/* —— 发表区（列表上方）—— */
	.composer {
		display: grid;
		gap: var(--space-3, 0.75rem);
		padding: var(--space-4, 1rem);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius, 0.5rem);
	}
	/* grid / flex 子项默认 min-width:auto：内部宽内容（验证码图 + 输入、
	   身份三字段）会把轨道撑出容器，窄屏整块溢出。统一放开收缩。 */
	.composer > *,
	.reply-form > * {
		min-width: 0;
	}
	.composer-meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3, 0.75rem);
		align-items: center;
		justify-content: space-between;
		min-width: 0;
	}
	/* 操作组（emoji / 官方 / 提交）：整体靠右，窄屏换行时成组落到下一行，
	   不与换行后的身份输入挤在同一行 */
	.composer-actions {
		display: inline-flex;
		align-items: center;
		gap: var(--space-3, 0.75rem);
		margin-left: auto;
		min-width: 0;
	}
	/* emoji 锚点（行左缘）：浮层从按钮上方弹出 */
	.emoji-anchor {
		position: relative;
		display: inline-flex;
	}
	/* 官方标勾选（站方成员专属）：与发表按钮成组靠右（margin-left:auto），
	   小字、次要色，控件 14px 与文本行垂直居中 */
	.official-check {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1, 0.25rem);
		margin-left: auto;
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary);
		cursor: pointer;
		user-select: none;
	}
	.official-check input {
		width: 14px;
		height: 14px;
		accent-color: var(--color-primary);
		cursor: pointer;
	}
	.field-sm {
		flex: 1;
		min-width: 140px;
		max-width: 240px;
	}

	.field {
		width: 100%;
		padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
		font-family: inherit;
		font-size: var(--text-sm, 0.875rem);
		color: var(--color-text);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm, 0.375rem);
		transition:
			border-color var(--transition-fast, 0.18s ease),
			box-shadow var(--transition-fast, 0.18s ease);
		resize: vertical;
	}
	.field:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--color-primary-light);
	}
	.field::placeholder {
		color: var(--color-text-muted);
	}

	.honeypot {
		position: absolute;
		top: auto;
		left: -9999px;
		width: 1px;
		height: 1px;
		overflow: hidden;
	}

	.sc-comments-note {
		font-size: var(--text-sm, 0.875rem);
		color: var(--color-text-secondary);
	}
	.sc-comments-note.is-danger {
		color: var(--c-danger);
	}
	.sc-comments-note.is-success {
		color: var(--c-success);
	}

	.sc-comments-empty {
		margin-top: var(--space-4, 1rem);
		padding: var(--space-6, 1.5rem);
		font-size: var(--text-sm, 0.875rem);
		color: var(--color-text-secondary);
		text-align: center;
		background: var(--color-surface);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius, 0.5rem);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* ─── 排序切换（C2-4）：与上方发表表单拉开间距 ─── */
	.sc-comments-sort {
		display: flex;
		gap: var(--space-2, 0.5rem);
		margin-top: var(--space-6, 1.5rem);
		margin-bottom: var(--space-3, 0.75rem);
	}
	.sc-comments-sort button {
		padding: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
		font-size: var(--text-xs, 0.75rem);
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border-light);
		border-radius: 9999px;
		background: transparent;
		cursor: pointer;
	}
	.sc-comments-sort button.is-active {
		color: #fff;
		background: var(--color-primary);
		border-color: var(--color-primary);
	}

	/* ─── emoji（C2-5） ─── */
	.btn-emoji {
		padding: 0 var(--space-2, 0.5rem);
		font-size: var(--text-lg, 1.125rem);
		line-height: 1;
		background: transparent;
		border: none;
		cursor: pointer;
	}
	/* ─── 行内编辑（C2-3） ─── */
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 0.5rem);
		margin-top: var(--space-1, 0.25rem);
	}

	/* ─── 窄容器自适应（左右布局站点的侧栏 / 移动端）────────────
	   容器查询按评论区实际宽度降级：头像收小、回复缩进减半、
	   emoji 面板收窄——站长无需任何配置，插件随主题容器自适应。
	   变量覆写落在容器内的 .sc-comments-list（容器不能自询自己）。 */
	@container comments (max-width: 480px) {
		.sc-comments-list {
			--comments-avatar-size: 28px;
			--comments-avatar-size-sm: 22px;
			--comments-thread-gap: var(--space-2, 0.5rem);
		}
		.comment-time {
			margin-left: 0;
			width: 100%;
			order: 3;
		}
		/* 窄屏身份三字段各占整行，不再留 240px 上限的右侧空白 */
		.field-sm {
			max-width: none;
		}
	}
</style>
