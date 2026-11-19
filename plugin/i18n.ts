/**
 * 评论插件 UI 文案（zh / en）。
 *
 * 经 `ctx.i18n.register('comments', messages)` 注入框架：服务端用 `ctx.i18n.t()`
 * 取词，客户端组件经 `GET /api/v1/i18n/comments` 下发（loadPluginI18n）——
 * 插件文案不进框架 messages/ 命名空间，两端共用同一份注册。
 *
 * 约定：key → { locale: 文案 }。管理端内容设置组件的文案统一 `settings_` 前缀，
 * 避免与前台同名 key（如 closed）冲突。
 */
export const messages: Record<string, Record<string, string>> = {
	// —— 前台（slot-comments） ——
	title: { zh: '评论', en: 'Comments' },
	placeholder: { zh: '说点什么…', en: 'Say something…' },
	replyPlaceholder: { zh: '回复…', en: 'Reply…' },
	nameLabel: { zh: '昵称', en: 'Name' },
	nameOptional: { zh: '昵称（可选）', en: 'Name (optional)' },
	emailLabel: { zh: '邮箱（必填，不公开）', en: 'Email (required, never shown)' },
	emailOptional: { zh: '邮箱（可选，不公开）', en: 'Email (optional, never shown)' },
	reportReasonLabel: { zh: '举报理由', en: 'Report reason' },
	reportReasonPlaceholder: {
		zh: '可选：说明举报原因',
		en: 'Optional: why are you reporting this?'
	},
	websiteLabel: { zh: '主页（可选）', en: 'Website (optional)' },
	// 相对时间（前台 timeOf 取词）：此前在组件里硬编码中英双语，
	// 站点接入第三语言时只能二选一，且 <html lang> 未设时恒落到英文分支。
	// 带占位符 {n}，由前端替换计数。
	timeJustNow: { zh: '刚刚', en: 'just now' },
	timeMinutesAgo: { zh: '{n} 分钟前', en: '{n}m ago' },
	timeHoursAgo: { zh: '{n} 小时前', en: '{n}h ago' },
	timeDaysAgo: { zh: '{n} 天前', en: '{n}d ago' },
	submit: { zh: '发表评论', en: 'Post comment' },
	submitReply: { zh: '回复', en: 'Reply' },
	submitting: { zh: '发布中…', en: 'Posting…' },
	moderation: {
		zh: '已提交，审核通过后对所有人显示（你现在可以看到它）。',
		en: 'Submitted — visible to everyone after moderation (you can see it now).'
	},
	published: { zh: '发布成功，已公开显示。', en: 'Published.' },
	tooFast: { zh: '操作太频繁，请稍后再试。', en: 'Too many actions — please slow down.' },
	failed: { zh: '操作失败，请稍后再试。', en: 'Action failed — try again later.' },
	loadFailed: { zh: '评论加载失败。', en: 'Failed to load comments.' },
	empty: { zh: '还没有评论，来抢沙发～', en: 'No comments yet. Be the first.' },
	guest: { zh: '访客', en: 'Guest' },
	reply: { zh: '回复', en: 'Reply' },
	cancel: { zh: '取消', en: 'Cancel' },
	like: { zh: '赞', en: 'Like' },
	unlike: { zh: '取消赞', en: 'Unlike' },
	report: { zh: '举报', en: 'Report' },
	reported: { zh: '已收到举报，感谢反馈。', en: 'Report received — thank you.' },
	del: { zh: '删除', en: 'Delete' },
	deleteConfirm: { zh: '确定删除这条评论吗？', en: 'Delete this comment?' },
	reportConfirm: { zh: '确定举报这条评论吗？', en: 'Report this comment?' },
	pendingBadge: { zh: '审核中', en: 'Pending' },
	officialBadge: { zh: '官方', en: 'Official' },
	authorBadge: { zh: '作者', en: 'Author' },
	loadMore: { zh: '加载更多评论', en: 'Load more comments' },
	// D1：单线程后代被截断后的续拉入口
	loadMoreReplies: { zh: '查看更多回复', en: 'Load more replies' },
	replyToPrefix: { zh: '回复', en: 'Reply to' },
	sortLatest: { zh: '最新', en: 'Latest' },
	sortHot: { zh: '最热', en: 'Top' },
	closed: { zh: '评论已关闭。', en: 'Comments are closed.' },
	siteClosed: { zh: '此处未开启评论。', en: 'Comments are not enabled here.' },
	loginToComment: {
		zh: '该内容的评论仅限登录用户，请先登录。',
		en: 'Comments on this content are limited to signed-in users.'
	},
	edit: { zh: '编辑', en: 'Edit' },
	save: { zh: '保存', en: 'Save' },
	editedFailed: { zh: '编辑失败，请稍后再试。', en: 'Edit failed — try again later.' },
	captchaLabel: { zh: '验证码', en: 'Captcha' },
	captchaPlaceholder: { zh: '输入右图字符', en: 'Type the characters' },
	captchaFailed: { zh: '验证码不正确，请重试。', en: 'Captcha incorrect — please try again.' },

	// —— 管理端内容设置（slot-comment-settings） ——
	settings_title: { zh: '评论设置', en: 'Comment settings' },
	settings_sub: {
		zh: '本篇内容的评论行为（站点级开关在插件配置页）',
		en: 'Per-content comment behavior (site-level switch lives in the plugin config page)'
	},
	settings_hintCreate: {
		zh: '内容首次保存后可在此配置评论开关。',
		en: 'Comment switches become available after the content is saved for the first time.'
	},
	settings_loading: { zh: '加载中…', en: 'Loading…' },
	settings_closed: { zh: '关闭评论', en: 'Close comments' },
	settings_closedHint: { zh: '该内容不接收任何评论', en: 'This content accepts no new comments' },
	settings_requireLogin: { zh: '仅登录用户可评论', en: 'Signed-in users only' },
	settings_requireLoginHint: { zh: '游客提交将被拒绝', en: 'Guest submissions are rejected' },
	settings_featuredOnly: { zh: '仅展示精选评论', en: 'Show featured only' },
	settings_featuredOnlyHint: {
		zh: '公开列表只显示勾选精选的评论',
		en: 'Public list shows featured comments only'
	},
	settings_saved: { zh: '评论设置已保存', en: 'Comment settings saved' },
	settings_saveFailed: { zh: '评论设置保存失败', en: 'Failed to save comment settings' },

	// —— 后台列表行操作（slot-comment-admin-actions，方案 B） ——
	admin_reply: { zh: '回复', en: 'Reply' },
	admin_replyTitle: { zh: '回复评论', en: 'Reply to comment' },
	admin_replySubtitle: { zh: '以官方身份回复，免审直接发布', en: 'Reply as the site, published instantly' },
	admin_replyTo: { zh: '回复', en: 'Reply to' },
	admin_replyOriginal: { zh: '原评论', en: 'Original' },
	admin_replyEscapeHint: { zh: '按 Esc 取消', en: 'Esc to cancel' },
	admin_replyPlaceholder: {
		zh: '官方回复，免审直接发布…',
		en: 'Official reply, published instantly…'
	},
	admin_replySend: { zh: '发送回复', en: 'Send reply' },
	admin_replySending: { zh: '发送中…', en: 'Sending…' },
	admin_replyCancel: { zh: '取消', en: 'Cancel' },
	admin_replySent: { zh: '回复已发布', en: 'Reply published' },
	admin_replyFailed: { zh: '回复失败，请稍后再试', en: 'Reply failed — try again later' },

	// —— 服务端邮件 / 通知（C4：双语站点的发信文案按请求 locale 取词） ——
	// {author} 评论者名、{excerpt} 内容摘要、{siteName} 站点名
	mail_reply_title: {
		zh: '你的评论收到了新回复',
		en: 'Someone replied to your comment'
	},
	mail_reply_action: { zh: '查看回复', en: 'View reply' },
	mail_admin_pending_title: { zh: '新评论待审核', en: 'A new comment is pending review' },
	mail_author_comment_title: {
		zh: '你的内容有新评论',
		en: 'A new comment on your content'
	}
};
