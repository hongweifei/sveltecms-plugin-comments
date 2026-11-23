/**
 * 插件源码热同步：watch plugin/，变更即拷进 .sveltecms/data/plugins/comments/，
 * 宿主 vite dev 的 watcher 随即 HMR——改插件代码 → 浏览器秒级生效，
 * 这就是 pnpm dev 的「开发体验」层。
 *
 * 与宿主 dev server 并行运行（package.json 的 dev 脚本并起两者）。
 */
import { watch, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'plugin');
const DEST = path.join(ROOT, '.sveltecms/data/plugins/comments');

if (!existsSync(path.join(ROOT, '.sveltecms/package.json'))) {
	console.error('[watch] .sveltecms 不存在——先运行 pnpm dev / pnpm ensure');
	process.exit(1);
}

let timer = null;
let dirty = false;

function sync() {
	const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ensure-host.mjs'), '--sync'], {
		stdio: ['ignore', 'ignore', 'inherit']
	});
	if (r.status !== 0) console.error('[watch] 同步失败（见上）');
	else if (dirty) console.log('[watch] 已同步 →', path.relative(ROOT, DEST));
	dirty = false;
}

// 编辑器保存常触发连串事件：200ms 去抖合并成一次全量同步（目录小，成本可忽略）
function schedule() {
	dirty = true;
	if (timer) clearTimeout(timer);
	timer = setTimeout(sync, 200);
}

watch(SRC, { recursive: true }, (_event, filename) => {
	if (!filename) return;
	const rel = filename.toString();
	// 测试、e2e 与测试桩不进宿主，无需为其变更触发同步
	if (/\.test\.ts$|^e2e[/\\]|^test-mocks[/\\]/.test(rel)) return;
	schedule();
});

console.log('[watch] 监听 plugin/ → .sveltecms/data/plugins/comments/（Ctrl+C 退出）');
