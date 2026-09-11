/**
 * 编辑器/工具链的 Svelte 配置——只管语言服务提示，不参与运行（插件代码由
 * 宿主 vite 编译）。没有它，svelte-vscode 按 Svelte 4 默认解析 .svelte：
 * $state/$derived/$props 全部标红。与宿主对齐（runes: true + vitePreprocess）。
 */
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
	preprocess: [vitePreprocess()],
	compilerOptions: {
		runes: true
	},
	extensions: ['.svelte']
};
