/**
 * `comments/count` 服务契约（框架 0.3 服务供给协议）。
 *
 * 用 declaration merging 把形状登记到框架的服务契约表：消费方（主题/其它插件）
 * `ctx.service.get('comments/count')` 直接拿到强类型，不必自行断言。本模块只含
 * 类型声明，运行时为空——按 type-only 导入即可参与类型合并。
 */
export interface CommentsCountService {
	/** 页面路径（如 `/article/hello`）→ 已审核评论数；非法路径返回 0 */
	byPath(path: string): Promise<number>;
	/** 内容项（集合 slug + 记录 id）→ 已审核评论数；非法绑定返回 0 */
	byContent(contentType: string, contentId: string): Promise<number>;
}

declare module '#lib/cms/types/plugin-services.ts' {
	interface PluginServiceContracts {
		'comments/count': CommentsCountService;
	}
}
