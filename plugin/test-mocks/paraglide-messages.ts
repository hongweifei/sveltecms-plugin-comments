/**
 * paraglide 文案桩（测试专用，不随插件发布）。
 *
 * 框架 0.3 的 `#lib/paraglide/messages.js` 由宿主 Vite 的 paraglideVitePlugin
 * 以虚拟模块提供；插件仓的 vitest 不加载那个插件，只在渲染宿主组件
 * （FormPage / Dialog 等）做结构断言时被间接引用。这里统一返回空串——
 * 断言看的是插件自己的文案与 DOM 结构，不依赖宿主翻译。
 */
const emptyMessage = () => '';

/** 与真实模块同形：`m.xxx()` 取词 */
export const m = new Proxy({} as Record<string, () => string>, {
	get: () => emptyMessage
});
