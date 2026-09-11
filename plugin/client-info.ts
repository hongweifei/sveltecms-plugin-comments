/**
 * 评论插件客户端信息采集服务（UA / IP / User 表反查）。
 *
 * 设备环境与归属地一律复用框架设施：
 * - UA 解析用仓库依赖 ua-parser-js（先 matchesGim 浏览器主版本号）
 * - 系统名走框架 parseOS（Client Hints 优先判 Win11，与 audit 同源）
 * - IP 归属地用 $lib/common/server/ip-region 的 lookupRegion（ip2region
 *   离线库 + 内置缓存，best-effort，失败留空）
 * - 登录用户的头像 / 昵称走 user 表实时反查（依赖 manifest 声明的
 *   'user' 系统表只读权限）
 *
 * 此处保留框架没有的 gravatar 哈希（createHash 在文件顶部，与服务端 crypto
 * 复用的同一工具相区分）。
 */
import { createHash } from 'node:crypto';
import { UAParser } from 'ua-parser-js';

import type { RequestEvent } from '@sveltejs/kit';
import type { PluginContext } from '$lib/cms/types/plugin';
import { getChPlatform, getChPlatformVersion, parseOS } from '$lib/common/server/request-context';
import { lookupRegion } from '$lib/common/server/ip-region';
import { userAvatarUrl } from '$lib/cms/utils/user-avatar';
import type { CommentRow, ResolvedUser } from './helpers';

/** gravatar / cravatar 头像哈希（邮箱小写去空白后 md5）；无邮箱返回 null */
export function gravatarHash(email: string | null | undefined): string | null {
	if (!email) return null;
	return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

/** 收集客户端设备 / 归属地信息（UA 解析 + IP 离线库反查） */
export interface ClientInfo {
	os: string | null;
	browser: string | null;
	region: string | null;
}

interface ContextWithDb {
	db: Pick<PluginContext['db'], 'find' | 'create' | 'update'>;
}

export interface ClientInfoService {
	/**
	 * 采集评论提交时的设备与归属地——单条评论少量字段，单次调用开销可忽略。
	 * UA 解析失败 / IP 归属地离线库 miss 均留空，绝不阻塞主流程。
	 */
	collect(ua: string | null, ip: string): Promise<ClientInfo>;
	/**
	 * 批量反查 user 表：本次列表涉及的全部 userId → { name, avatar }。
	 * 一次 IN 查询，规模受列表分页约束（20 顶层 + 500 后代上限）。
	 * 表为 manifest 声明的 'user' 系统表只读权限——读不到（私有集合）则返回空 Map。
	 */
	resolveUsers(rows: CommentRow[]): Promise<Map<string, ResolvedUser>>;
}

/** 浏览器主版本号格式化（126.0.0.0 → 126，无版本号时仅留名） */
function formatBrowserPart(part: { name?: string; version?: string } | undefined) {
	const name = part?.name ?? '';
	if (!name) return null;
	const major = part?.version?.split('.')[0] ?? '';
	return major ? `${name} ${major}` : name;
}

export function createClientInfoService(ctx: ContextWithDb): ClientInfoService {
	return {
		async collect(ua, ip) {
			const parser = new UAParser(ua ?? '');
			return {
				os: parseOS(getChPlatform() ?? '', getChPlatformVersion() ?? '', ua ?? undefined) || null,
				browser: formatBrowserPart(parser.getBrowser()),
				region: await lookupRegion(ip)
			};
		},
		async resolveUsers(rows) {
			const ids = [
				...new Set(
					rows
						.map((r) => (typeof r.userId === 'string' && r.userId ? r.userId : null))
						.filter((v): v is string => v !== null)
				)
			];
			if (ids.length === 0) return new Map();
			const users = await ctx.db.find('user', {
				filter: { id: { $op: 'in', $val: ids } },
				limit: ids.length
			});
			return new Map(
				(users.data as Array<{
					id: unknown;
					name?: unknown;
					image?: unknown;
					email?: unknown;
				}>).map((u) => [
					String(u.id),
					{
						name: typeof u.name === 'string' && u.name ? u.name : null,
						avatar: userAvatarUrl(u)
					}
				])
			);
		}
	};
}

/**
 * 工具：从 RequestEvent 解析 IP 与 UA（IP / UA 缺失处返回 null / undefined——由
 * 调用方决定回退策略）。
 */
export function readClientHints(event: RequestEvent) {
	const ip =
		typeof event.getClientAddress === 'function' ? event.getClientAddress() : null;
	const ua = event.request.headers.get('user-agent');
	return { ip, ua };
}
