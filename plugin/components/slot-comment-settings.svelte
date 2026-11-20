<!--
	创作者内容级评论控制：注册到管理端内容表单插槽 collection-form-fields-after
	（FormPage 传入 contentType / mode / recordId）。站点级白名单（站长在插件
	配置页管「哪些地方能评」）之外，单篇内容的评论行为由创作者自行决定：

	- 关闭评论：该内容不接收任何评论
	- 仅登录可评：游客提交拒绝
	- 仅展示精选：公开列表只显示被创作者勾选精选的评论（公众号式）

	读写走 /admin/content-settings（非 public 端点，管理端登录态 + CSRF）。
	编辑模式加载当前值、切换即保存（patch 语义，只发变更的开关）；
	创建模式尚无内容项 id，显示「保存后可配置」提示。

	可见性门（C4-*）：FormPage 透传 contentType（集合 slug）与 recordId，组件先查
	/admin/eligible——服务端判定「类型命中 enabledTypes 或（pages 记录）其公共
	路径命中 enabledPaths」才渲染，两条命中路径下设置均被前台真实消费（path
	绑定经插件内 page-paths 桥反查同一记录）。未命中的集合编辑时不出现
	「配了也无效」的开关。contentType 缺失或查询失败（网络抖动）保守视为可渲染。

	i18n：文案在 i18n.ts 统一注册（ctx.i18n），组件经 /api/v1/i18n/comments
	取词（loadPluginMessages），不占用框架 messages/ 命名空间（同 slot-comments
	前台组件模式）。
-->
<script lang="ts">
	import { showToast } from '#lib/common/utils/toast.ts';
	import { getCsrfToken } from '#lib/common/utils/csrf.ts';
	import { loadPluginMessages } from '#lib/cms/utils/i18n-client.ts';

	let {
		mode = undefined,
		recordId = undefined,
		contentType = undefined
	}: {
		mode?: 'create' | 'edit';
		recordId?: string;
		/** 当前编辑的集合 slug（FormPage 透传）——站点未对该类型开启评论时整体隐藏 */
		contentType?: string;
	} = $props();

	const BASE = '/api/v1/plugin/comments';

	type Settings = { closed: boolean; requireLogin: boolean; featuredOnly: boolean };

	let settings = $state<Settings | null>(null);
	let loading = $state(true);
	let savingKey = $state<string | null>(null);
	/** 该集合是否可能开评论（站点白名单命中）；null = 判定中，false 整体隐藏。
	 *  contentType 挂载后不变，初值捕获是有意的（后续判定走 $effect 读最新值） */
	/* svelte-ignore state_referenced_locally */
	let eligible = $state<boolean | null>(contentType ? null : true);

	// 文案由插件注册、经 /api/v1/i18n/comments 下发（与服务端同一份，两端共用）；
	// 取词失败时回退 key 本身，不阻塞渲染。key 用 settings_ 前缀避免与前台同名冲突
	let messages = $state<Record<string, string>>({});
	const tr = $derived((key: string) => messages[key] ?? key);
	const t = $derived({
		title: tr('settings_title'),
		sub: tr('settings_sub'),
		hintCreate: tr('settings_hintCreate'),
		loading: tr('settings_loading'),
		closed: tr('settings_closed'),
		closedHint: tr('settings_closedHint'),
		requireLogin: tr('settings_requireLogin'),
		requireLoginHint: tr('settings_requireLoginHint'),
		featuredOnly: tr('settings_featuredOnly'),
		featuredOnlyHint: tr('settings_featuredOnlyHint'),
		saved: tr('settings_saved'),
		saveFailed: tr('settings_saveFailed')
	});

	const ROWS = $derived([
		{ key: 'closed' as const, label: t.closed, hint: t.closedHint },
		{ key: 'requireLogin' as const, label: t.requireLogin, hint: t.requireLoginHint },
		{ key: 'featuredOnly' as const, label: t.featuredOnly, hint: t.featuredOnlyHint }
	]);

	async function load() {
		if (mode !== 'edit' || !recordId) {
			loading = false;
			return;
		}
		try {
			// contentType 随查询携带：设置行按 (类型, contentId) 判别读写，防跨集合
			// 同 id 记录串读（服务端对无类型历史行仍兼容命中）
			let url = `${BASE}/admin/content-settings?contentId=${encodeURIComponent(recordId)}`;
			if (contentType) url += `&contentType=${encodeURIComponent(contentType)}`;
			const res = await fetch(url);
			if (res.ok) settings = (await res.json()) as Settings;
		} finally {
			loading = false;
		}
	}

	async function toggle(key: keyof Settings) {
		if (!settings || !recordId || savingKey) return;
		savingKey = key;
		try {
			const res = await fetch(`${BASE}/admin/content-settings`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
				body: JSON.stringify({
					contentId: recordId,
					...(contentType ? { contentType } : {}),
					[key]: !settings[key]
				})
			});
			if (res.ok) {
				settings = (await res.json()) as Settings;
				showToast(t.saved, 'success');
			} else {
				showToast(t.saveFailed, 'error');
			}
		} catch {
			showToast(t.saveFailed, 'error');
		} finally {
			savingKey = null;
		}
	}

	$effect(() => {
		// 取插件文案（zh/en 由服务端按当前语言下发，组件不再自带双语）
		loadPluginMessages('comments').then((m) => (messages = m));
		// 站点未对该记录开启评论 → 设置 UI 整体隐藏（查询失败保守视为可显示，
		// 不因网络抖动把创作者能用的开关藏掉）。服务端判定 = 类型命中
		// enabledTypes 或（pages 记录）其公共路径命中 enabledPaths——带 recordId
		// 才有第二种命中（首页 / 等路径白名单下编辑其它内容不再误显示设置）。
		if (contentType) {
			const q = new URLSearchParams({ contentType });
			if (mode === 'edit' && recordId) q.set('recordId', recordId);
			fetch(`${BASE}/admin/eligible?${q.toString()}`)
				.then((res) => (res.ok ? (res.json() as Promise<{ eligible?: boolean }>) : null))
				.then((data) => {
					if (data && typeof data.eligible === 'boolean') eligible = data.eligible;
				})
				.catch(() => {});
		}
		load();
	});
</script>

{#if eligible}
<div class="cs-settings">
	<div class="cs-settings-head">
		<span class="cs-settings-title">{t.title}</span>
		<span class="cs-settings-sub">{t.sub}</span>
	</div>

	{#if loading}
		<p class="cs-settings-hint">{t.loading}</p>
	{:else if mode !== 'edit' || !recordId}
		<p class="cs-settings-hint">{t.hintCreate}</p>
	{:else if settings}
		{#each ROWS as row (row.key)}
			<div class="cs-settings-row">
				<div class="cs-settings-text">
					<span class="cs-settings-label">{row.label}</span>
					<span class="cs-settings-hint">{row.hint}</span>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={settings[row.key]}
					aria-label={row.label}
					disabled={savingKey !== null}
					onclick={() => toggle(row.key)}
					class="cs-switch {settings[row.key] ? 'cs-switch-on' : ''}"
				>
					<span class="cs-knob {settings[row.key] ? 'cs-knob-on' : ''}"></span>
				</button>
			</div>
		{/each}
	{/if}
</div>
{/if}

<style>
	.cs-settings {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 0.875rem 1rem;
		margin-top: 0.25rem;
	}
	.cs-settings-head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.625rem;
	}
	.cs-settings-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text);
	}
	.cs-settings-sub {
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
	}
	.cs-settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.375rem 0;
	}
	.cs-settings-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.cs-settings-label {
		font-size: 0.8125rem;
		color: var(--color-text);
	}
	.cs-settings-hint {
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
	}
	.cs-switch {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		width: 2.25rem;
		height: 1.25rem;
		align-items: center;
		border-radius: 9999px;
		background: var(--color-bg-tertiary);
		box-shadow: inset 0 0 0 1px var(--color-border);
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.cs-switch:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.cs-switch-on {
		background: var(--color-primary);
		box-shadow: none;
	}
	.cs-knob {
		position: absolute;
		left: 0.125rem;
		width: 1rem;
		height: 1rem;
		border-radius: 9999px;
		background: #fff;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
		transition: transform 0.15s ease;
	}
	.cs-knob-on {
		transform: translateX(1rem);
	}
</style>
