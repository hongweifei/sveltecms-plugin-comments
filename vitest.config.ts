import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * 插件独立仓库测试配置：宿主框架在仓内 .sveltecms/（ensure-host 自动装配）。
 * `#lib` 全部解析到 .sveltecms/src/lib（类型、test-helpers、服务端能力与前端
 * 共享同一口径）；`$app/*` 别名直接复用宿主的 __mocks__——宿主升级测试基建
 * （如新增 $app mock）时这里零改动。运行前 pnpm test 已自动 ensure。
 */
const HOST = path.resolve(import.meta.dirname, '.sveltecms');

export default defineConfig({
	resolve: {
		alias: {
			'#lib': path.join(HOST, 'src/lib'),
			'$app/env/private': path.join(HOST, 'src/__mocks__/env-private.ts'),
			'$app/env': path.join(HOST, 'src/__mocks__/app-env.ts'),
			'$app/state': path.join(HOST, 'src/__mocks__/app-state.ts')
		}
	},
	// 组件渲染测试（svelte/server render）需要 Svelte 编译器；引擎测试不受影响
	plugins: [
		svelte({
			compilerOptions: { runes: true },
			preprocess: [vitePreprocess()]
		})
	],
	test: {
		include: ['plugin/**/*.test.ts'],
		environment: 'node',
		globals: false,
		testTimeout: 30000,
		hookTimeout: 30000,
		maxWorkers: 4,
		fileParallelism: true,
		server: {
			deps: {
				// @lucide/svelte 的 .svelte 文件默认被 externalize 了，node 直载会炸
				// Unknown file extension——强制交 vite 管线（svelte 插件转译）。
				// 模式需兼容 Windows 反斜杠路径与 pnpm store 的 @lucide+svelte 形态
				inline: [/@lucide[/+\\]svelte/]
			}
		}
	}
});
