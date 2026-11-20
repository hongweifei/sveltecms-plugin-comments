# sveltecms-plugin-comments

SvelteCMS 官方评论插件——独立仓库开发，经[社区插件市场](https://github.com/hongweifei/sveltecms-marketplace)分发。

功能：前台评论区（嵌套线程/点赞/举报/编辑删除/游客与登录双态）、官方回复（免审 + 徽章 + 邮件通知）、后台审核列表与行内回复、内容级开关、IP 属地/设备环境、黑名单、精选。完整说明见 [docs/FEATURES.md](docs/FEATURES.md)（概念模型 / 状态机 / 配置项 / 端点 / 反滥用）。

## 仓库结构

```
plugin/            插件源码（唯一事实源；发布 zip 时内容直接落 zip 根）
  plugin.ts        manifest + 装配入口
  components/      前台/后台插槽组件（宿主编译期 glob 收录）
  e2e/             Playwright 端到端用例（host-helpers.ts 为宿主 e2e 基建
                   的 vendored 最小移植——外部插件不应依赖宿主未承诺的内部件）
  *.test.ts        vitest 单元/SSR 渲染测试
scripts/
  ensure-host.mjs  宿主框架自动装配（clone + install + 插件挂载，幂等）
  sync-watch.mjs   plugin/ 热同步进宿主运行副本（pnpm dev 的 watch 侧）
  package.mjs      打发布 zip + 打印 SHA-256
  reset-e2e-db.mjs 擦净 e2e 数据库
vitest.config.ts   测试配置（#lib 解析到 .sveltecms/src/lib）
playwright.config.ts  e2e 配置（就地起宿主 dev server，独立 DB）
.sveltecms/        宿主框架 checkout（自动创建，gitignore，勿手改）
```

> 宿主即 SvelteKit 3：类型从 `.sveltecms/node_modules/$app` 借用（ensure 会把它链接到本仓
> `node_modules/$app`，`tsconfig.json` 的 `extends`/`types` 由此解析）。

## 开发

**clone 本仓，一条命令起一切**。
宿主框架自动装配进仓内 `.sveltecms/`（首次 clone + install 慢几分钟，之后增量）：

```bash
pnpm install
pnpm dev          # 自动装配宿主 → 起框架 dev server(5178) + 插件热同步 watch
```

打开 http://localhost:5178 —— 完整站点已带评论插件（首次访问 `/admin` 会跳登录页，
注册的第一个用户即管理员）。改 `plugin/` 下任何代码：`.svelte` 组件与 `.ts` 模块经
watch 同步后由宿主 vite HMR 秒级生效；`plugin.ts` 装配逻辑改动在后台
「插件管理 → comments → 重载」或重启 dev。

其余命令（都自动 ensure，无需先跑 dev）：

```bash
pnpm test         # vitest：单元 + SSR 渲染
pnpm check        # svelte-check 类型门禁
pnpm e2e          # Playwright：起宿主 dev(5178) 跑全链路
pnpm package      # 打发布 zip + SHA-256
```

### 宿主版本控制

- 默认 clone `master`；锁定分支/标签：`SVELTECMS_REF=v1.2.0 pnpm ensure`
- 强制刷新宿主到上游最新：`SVELTECMS_HOST_PULL=1 pnpm ensure`
  （默认不 pull——装配后宿主锁定在 clone 时的 commit，行为可复现）
- 换框架仓库源：`SVELTECMS_REPO=<git URL>`
- 迁移初始化：`drizzle/` 按脚手架契约不入 git，ensure 检测到 fresh clone
  缺失时自动在宿主跑一次 `drizzle-kit generate`（仅系统核心表版本化迁移；
  插件/集合表由运行时动态 DDL 创建）——站长部署 starter 时同理自备 `pnpm db:generate`

## 发布与上架

```bash
node scripts/package.mjs           # dist/comments-<version>.zip + SHA-256
git tag v0.2.0 && git push --tags  # Release 工作流自动挂 zip
```

上架社区市场：向 [sveltecms-marketplace](https://github.com/hongweifei/sveltecms-marketplace)
提 PR，`marketplace.json` 加一条 repo 项即可（发 Release 即自动上架/更新）：

```json
{ "type": "repo", "url": "github.com/hongweifei/sveltecms-plugin-comments" }
```

## 安装（站点侧）

后台 `/admin/plugin-market` 市场页一键安装；或手动放置本仓 `plugin/` 内容到
站点 `data/plugins/comments/`。**含 Svelte 组件的插件必须构建前就位**
（宿主编译期 glob，zip 运行时安装不生效组件）——手动放置后重启 dev /
重新构建，市场安装会提示重启。

## 版本策略

`plugin/plugin.ts` manifest 的 `version` 是唯一版本源（package.json 同步）；
对宿主的最低兼容版本要求发布时写入 Release notes（宿主 API 面
`ctx.*` 门面与插槽名保持向后兼容）。
