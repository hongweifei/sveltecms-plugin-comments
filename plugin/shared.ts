/**
 * 客户端与服务端共享的契约层。
 *
 * 为什么要共享：此前前端手写一份 `CommentItem`（17 字段），服务端
 * `toPublic()` 返回另一份（18 字段）——客户端漏了 `featured`，且两边各自
 * 维护一份长度上限常量（2000/40/100/200）。任一侧改字段或改上限，另一侧
 * 静默错位：类型漂移在编译期无声，运行时才表现为「精选标记不显示」或
 * 「用户输 2000 字被服务端 400 拒绝但前端无提示」。
 *
 * 本模块是**纯类型 + 纯常量**，零运行时依赖、零框架 import，客户端与服务端
 * 均可安全引入（服务端不引入浏览器 API，客户端不引入 Node API）。
 *
 * 注意：客户端组件在浏览器里跑，构建产物会带上前缀常量（几十字节）——
 * 这是为契约一致性付出的可接受代价，比两份定义分叉划算。
 */

/**
 * 对外投影的评论（服务端 `toPublic()` 的返回值形状）。
 *
 * 这是「前端能看到的全部」——服务端在此剥离 userId / visitorId / email 明文，
 * 登录用户信息经 user 表实时反查后只留昵称与头像。
 *
 * 字段说明：
 * - `mine`：当前访客/用户是本条评论的作者（前端据此显示编辑/删除入口）
 * - `pending`：待审核（审核开启时新评论先落 pending，前台仅作者本人可见）
 * - `isAuthor`：评论人是**内容**的作者（纯派生量，不落列——内容转作者后
 *   不会留下陈旧标记）
 * - `official`：站方发言（管理员回复或站方成员勾选）
 * - `featured`：人工精选（公众号式）
 */
export interface PublicComment {
	id: string;
	authorName: string | null;
	content: string;
	createdAt: string;
	parentId: string | null;
	rootId: string | null;
	official: boolean;
	isAuthor: boolean;
	featured: boolean;
	likes: number;
	avatar: string | null;
	website: string | null;
	/** 访客登录来源（当前仅 'wechat'）；null = 匿名游客或 CMS 登录用户 */
	visitorProvider: 'wechat' | null;
	os: string | null;
	browser: string | null;
	region: string | null;
	mine: boolean;
	pending: boolean;
}

/** `/list` 响应体（顶层评论 + 后代 + 分页游标 + 站点/内容级开关） */
export interface CommentListBody {
	/** 顶层评论（分页后） */
	data: PublicComment[];
	/** 后代评论（按 rootId 归属，扁平数组） */
	children: PublicComment[];
	/** 当前访客已点赞的评论 id */
	likedIds?: string[];
	/** 顶层是否还有下一页 */
	hasMore?: boolean;
	/** 被截断线程的续拉游标：rootId + 已带出的后代数（/children?after= 的起点） */
	truncatedThreads?: Array<{ rootId: string; loaded: number }>;
	/** 站点级白名单未开启此绑定 → 前台隐藏表单 */
	enabled?: boolean;
	/** 站点开启「游客邮箱可留空」 */
	guestEmailOptional?: boolean;
	/** 站点允许匿名游客评论；false 时前端在无身份时提示登录（登录用户/微信访客不受限） */
	allowGuest?: boolean;
	/** 当前用户是站方成员（可勾选官方标） */
	canOfficial?: boolean;
	/** 内容级设置（创作者控制） */
	contentSettings?: {
		closed: boolean;
		requireLogin: boolean;
		featuredOnly: boolean;
	} | null;
	/** 登录态下的当前用户（仅昵称，绝不含邮箱） */
	viewer?: { name: string } | null;
	/** 站点配置的单条评论字数上限（前端据此设 maxlength） */
	maxLength?: number;
	/** 同一访客两次评论的最小间隔秒数（前端据此提示） */
	minInterval?: number;
	/**
	 * 上次评论记住的访客身份（服务端 HttpOnly cookie `comments_identity`）：
	 * 昵称/邮箱/主页，前端据此预填，回访免重填。登录用户与微信访客不返回。
	 */
	remembered?: {
		authorName: string;
		email: string;
		website: string;
	};
	/** 需要验证码 */
	captchaRequired?: boolean;
}

/** `/submit` 响应体 */
export interface CommentSubmitBody {
	success?: boolean;
	/** 服务端投影回的评论（前端据此本地插入，省一次重拉） */
	comment?: PublicComment & {
		/** 审核状态（pending / approved / spam）——投影本身不含此列，
		    服务端在提交响应里附加，供前端判断是否待审 */
		status?: string;
	};
	/** 验证码挑战（审核触发时前端重拉） */
	captchaRequired?: boolean;
	error?: string;
}

/** 长度上限（服务端校验用；前端据此设 maxlength——必须同源） */
export const MAX_CONTENT_LENGTH = 2000;
export const MAX_AUTHOR_NAME_LENGTH = 40;
export const MAX_PATH_LENGTH = 300;
export const MAX_ID_LENGTH = 64;
export const MAX_KEYWORDS = 200;
export const MAX_KEYWORD_LENGTH = 50;
export const MAX_EMAIL_LENGTH = 100;
export const MAX_WEBSITE_LENGTH = 200;
export const MAX_REPORT_REASON_LENGTH = 200;
/** 举报理由只保留最近若干条（防单条评论理由无限堆积） */
export const MAX_REPORT_REASONS = 10;
/** 举报数达此阈值自动回待审 */
export const REPORT_AUTO_PENDING_THRESHOLD = 3;
/** 列表默认页长 */
export const PAGE_SIZE_DEFAULT = 20;
/** 列表页长上限 */
export const PAGE_SIZE_MAX = 50;
/** 后代单次读放大护栏 */
export const CHILD_CAP = 500;
