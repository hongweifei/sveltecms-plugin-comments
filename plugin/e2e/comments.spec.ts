import { test, expect } from '@playwright/test';
// helpers 自持（vendored 自宿主 e2e/helpers.ts，见 host-helpers.ts 头注）；
// 由根 playwright.config 纳入运行
import { createPageViaUi, getAdminContext } from './host-helpers';

/**
 * 评论插件主流程（C3-5）：插件启用 → 站点级白名单（类型 pages）→ 发布页面
 * → 前台游客提交 → 管理端待审通过 → 前台可见。
 *
 * 覆盖 2026-09-06 语义：站点级纯白名单（留空 = 全关，故必须先配置），
 * 审核默认开启（pending → approved 才对外可见）。
 *
 * D2 稳定化（2026-09-09）：不再 waitForLoadState('networkidle')——vite dev 的
 * HMR websocket 长连接使 networkidle 永不满足（实测 90s 超时拖死用例），等待
 * 一律交给 web-first 断言（toBeVisible 自带轮询重试，且首访路由的冷编译由
 * 断言超时吸收）；goto 只等 SSR 文档就绪（load）。
 */
test.describe.configure({ mode: 'serial' });

const COMMENT_TEXT = `e2e 评论内容 ${Date.now()}`;
let slug = '';

/** 首访路由冷编译（vite dev 按需编译）下断言锚点的统一宽限 */
const READY_TIMEOUT = 60_000;

test.describe('评论插件主流程', () => {
	test('启用插件并配置类型白名单', async ({ browser }) => {
		const ctx = await getAdminContext(browser);
		const page = await ctx.newPage();

		await page.goto('/admin/plugins/comments');

		// D2：启用插件（新库默认禁用）——dev 冷启动下 SSR 一到达「已禁用」按钮即
		// 可见，但客户端事件可能尚未 attach（hydration 竞态），单次 click 会落空、
		// 状态不变。轮询点击直到「已启用」出现（水合完成后点击才真正触发 toggle）。
		const on = page.locator('button', { hasText: '已启用' }).first();
		const off = page.locator('button', { hasText: '已禁用' }).first();
		await expect(async () => {
			if ((await on.count()) > 0) return; // 已启用
			if ((await off.count()) > 0) await off.click();
			throw new Error('plugin toggle not applied yet');
		}).toPass({ timeout: READY_TIMEOUT });
		await expect(on).toBeVisible({ timeout: 20_000 });

		// 站点级白名单：内容类型直选 chips（点击「pages」选中）
		await page.locator('button', { hasText: /^pages$/ }).first().click();
		// 保存配置
		await page.locator('button', { hasText: '保存配置' }).first().click();
		await expect(page.locator('body')).toContainText(/配置已保存|已保存/, { timeout: 10_000 });

		await ctx.close();
	});

	test('发布页面 → 前台游客提交评论（进入待审）', async ({ browser }) => {
		const ctx = await getAdminContext(browser);
		const page = await ctx.newPage();
		slug = `e2e-comments-${Date.now()}`;

		await createPageViaUi(page, {
			title: `E2E 评论页 ${slug}`,
			slug,
			content: '评论区测试正文',
			publish: true
		});
		await ctx.close();

		// 游客（匿名会话）：白名单类型命中 → 表单可用，游客必填邮箱
		const anon = await browser.newContext();
		const anonPage = await anon.newPage();
		await anonPage.goto(`/${slug}`);
		await expect(anonPage.locator('#comment-content')).toBeVisible({ timeout: READY_TIMEOUT });
		await anonPage.locator('#comment-content').fill(COMMENT_TEXT);
		await anonPage.locator('#comment-email').fill('e2e-guest@example.com');
		await anonPage.locator('button[type="submit"]', { hasText: '发表评论' }).click();

		// 审核默认开启：提交后提示待审，本人（按 visitorId）即时可见
		await expect(anonPage.locator('body')).toContainText('审核通过后', { timeout: 10_000 });
		await expect(anonPage.locator('body')).toContainText(COMMENT_TEXT, { timeout: 10_000 });
		await anon.close();
	});

	test('管理端待审通过 → 前台公开可见', async ({ browser }) => {
		const ctx = await getAdminContext(browser);
		const page = await ctx.newPage();

		// 待审快筛（status select 字段自带筛选；通知 link 同款深链）
		await page.goto('/admin/content/comments?filter_status=pending');
		await expect(page.locator('body')).toContainText(COMMENT_TEXT, { timeout: READY_TIMEOUT });

		// 勾选该行 → 批量「通过」。同 test1 的 hydration 竞态：dev 冷启动下行复选框
		// SSR 即渲染，未水合时 check() 只改 DOM 不通知 Svelte（工具栏永不出现）。
		// 不能只看 isChecked（DOM 已勾选但 state 空会误判停手）——工具栏未出现就
		// 强制再走一轮 uncheck→check，水合后的点击必然触发 selectedIds 更新。
		const rowCheck = page
			.locator('tr', { hasText: COMMENT_TEXT })
			.first()
			.locator('input[type="checkbox"]');
		const approveBtn = page.locator('button', { hasText: '通过' }).first();
		await expect(async () => {
			if ((await approveBtn.count()) > 0) return;
			if (await rowCheck.isChecked()) await rowCheck.uncheck();
			await rowCheck.check();
			throw new Error('batch toolbar not rendered (hydrating)');
		}).toPass({ timeout: READY_TIMEOUT });
		await approveBtn.click();
		await expect(page.locator('body')).toContainText(/成功|已/, { timeout: 10_000 });

		// 前台公开可见（免登录新会话）
		const anon = await browser.newContext();
		const anonPage = await anon.newPage();
		await anonPage.goto(`/${slug}`);
		await expect(anonPage.locator('body')).toContainText(COMMENT_TEXT, { timeout: READY_TIMEOUT });
		await anon.close();

		await ctx.close();
	});

	test('移动端 320px：评论表单与长内容不产生横向溢出', async ({ browser }) => {
		// 移动端回归：表单操作组、身份三字段、验证码行与长 URL 评论都不得
		// 把页面撑出横向滚动（grid/flex 子项 min-width、长串断行两处修复的守卫）
		const ctx = await browser.newContext({ viewport: { width: 320, height: 760 } });
		const page = await ctx.newPage();
		await page.goto(`/${slug}`, { waitUntil: 'load' });

		const composer = page.locator('#comment-content');
		await expect(composer).toBeVisible({ timeout: READY_TIMEOUT });

		const longText = `长链接 ${'https://example.com/' + 'a'.repeat(120)}`;
		await composer.fill(longText);
		await page.locator('#comment-email').fill('e2e-mobile@example.com');
		await page.locator('button[type="submit"]', { hasText: '发表评论' }).click();
		await expect(page.locator('body')).toContainText('审核通过后', { timeout: 10_000 });

		const metrics = await page.evaluate(() => ({
			vw: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth
		}));
		expect(metrics.scroll).toBeLessThanOrEqual(metrics.vw);

		// 提交按钮落在视口内（操作组换行后仍靠容器右缘）
		const submit = page.locator('.composer button[type="submit"]').first();
		const box = await submit.boundingBox();
		expect(box).not.toBeNull();
		expect(Math.round(box!.x + box!.width)).toBeLessThanOrEqual(metrics.vw);
		await ctx.close();
	});
});
