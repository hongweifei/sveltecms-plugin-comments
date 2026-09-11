import { chromium, type FullConfig } from '@playwright/test';
import { getAdminContext } from '../plugin/e2e/host-helpers';

/**
 * 预热（对齐宿主 playwright.warmup.global.ts 思路）：dev server 端口就绪 ≠
 * 路由编译完成，首个用例的 goto 常吃 30-90s 冷编译、导航半途中止而误判
 * 「按钮没出现」。这里测试跑前用管理员会话串行访问关键路由触发编译。
 *
 * 尽力而为（best-effort）：goto 超时后 vite 的编译仍在服务端进行，预热
 * 照样生效；任何失败都不应阻断测试——用例自身有 navigationTimeout 90s
 * 与 READY_TIMEOUT 轮询兜底。
 */
export default async function warmup(config: FullConfig) {
	const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:5178';
	const browser = await chromium.launch();
	try {
		// globalSetup 自 launch 的 browser 不继承 config.use——baseURL 与超时
		// 显式透传
		const ctx = await getAdminContext(browser, {
			baseURL,
			navigationTimeout: 180_000,
			actionTimeout: 180_000
		});
		const page = await ctx.newPage();
		// 评论 e2e 触达的路由：插件配置页、评论审核列表、前台文章页（/ 兜底）
		for (const path of ['/admin/plugins/comments', '/admin/content/comments', '/']) {
			await page.goto(baseURL + path, { timeout: 180_000, waitUntil: 'load' }).catch(() => {});
		}
		await ctx.close();
	} catch (e) {
		console.warn(`[warmup] 预热未完成（不阻断，用例自带宽限）：${String(e)}`);
	} finally {
		await browser.close();
	}
}
