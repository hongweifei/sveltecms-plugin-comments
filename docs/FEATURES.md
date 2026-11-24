# 评论插件功能文档

SvelteCMS 官方评论插件的站长/管理员向完整手册。安装与开发见仓根 README。

## 目录

- [概念模型](#概念模型)
- [评论状态机](#评论状态机)
- [站点级配置（站长）](#站点级配置站长)
- [内容级设置（创作者）](#内容级设置创作者)
- [前台能力](#前台能力)
- [管理端能力](#管理端能力)
- [数据表](#数据表)
- [API 端点](#api-端点)
- [对外服务](#对外服务)
- [反滥用与安全](#反滥用与安全)
- [隐私与访客数据](#隐私与访客数据)

## 概念模型

- **双键绑定**：每条评论绑定到「页面路径 `path`」或「内容项 `contentId`（+ `contentType` 判别集合）」至少其一，两条链路在提交/列表/计数全链路等价。前台优先按内容项 id 绑定（主题注入的 `window.__CMS_PAGE__`），无 id 时回落 URL 路径。`path` 存**可读原文**：地址栏里的中文段是 percent-encoding（`/article/%E7%BD%91…`），服务端归一还原为 `/article/网络安全`，后台列表、路径白名单与 pages slug 都按原文比对。
- **无限嵌套回复**：`parentId` 指向任意已审核父评论；`rootId` 恒指向所在根评论。列表按顶层分页、后代按 `rootId` 一次带出，前台平铺在根评论下一层（回复内容带「回复 @目标」前缀，点击跳转定位），避免层层缩进。
- **访客身份（框架统一访客）**：游客用昵称（可选）/ 邮箱（默认必填，仅存储）/ 主页（可选）；评论归属与去重键 `visitorId` = 框架统一访客 id（`cms_visitor` 签名 cookie 里的一年期稳定 UUID，见 `plugin/visitor.ts`）——换 IP、跨天仍是同一个人，「本人待审可见」、点赞去重、限频与隐私导出/删除都按它归人；没有浏览器 cookie 的直连调用回落 IP+UA 哈希。登录用户恒按 `userId` 归身份，昵称/头像实时反查 user 表（manifest 声明只读 `user`），账号改名换头像即刻生效。
- **微信 / QQ 访客**：站点在「系统设置 → 访客登录」配置公众号或 QQ 互联凭据后，表单出现对应「使用微信/QQ登录」入口。登录走框架统一的 `/api/auth/visitor/*`（提供方注册表内置微信与 QQ，新增提供方无需改插件），社交身份并入同一个 `cms_visitor` cookie（七天）；提交时服务端从 `event.locals.visitor` 取昵称与头像，忽略客户端填写的身份字段，落 `visitor_provider` 并按提供方展示徽章（已知提供方用插件中英文案，其余用框架下发的 label）。openid / unionid 只在签名 cookie 里，不落评论表。
- **环境信息**：服务端从 UA 解析系统/浏览器、从 IP 异步解析归属地（best-effort，失败留空；内网地址标注「内网」），落库前归一成「国家·省份·城市·运营商」展示文本（离线库原始记录里的分隔符、占位符与国家代码不上屏）。

## 评论状态机

```
提交 ──(审核开启)──→ pending ──(后台通过)──→ approved ⇄ (回待审/标垃圾)
   └─(审核关闭)──→ approved（免审直发）
黑名单命中 / 举报达阈值(3 次) → spam / 回 pending
```

- `pending`：仅作者本人可见（按 `visitorId`/`userId` 匹配，带「审核中」标记，审核通过后即时公开）
- `approved`：公开可见
- `spam`：仅管理端可见
- **官方回复免审**：具备官方身份的用户（任一角色 `adminAccess`，或角色名列入 `officialRoles` 白名单；框架 0.3 的多角色附加清单同样计入）经前台勾选或后台行内回复直接 `approved` + `official` 徽章。「能登录后台」（`appAccess`）只代表后台准入——内容创作者同样需要它，因此不构成官方身份；创作者回复自己内容下的评论按普通作者评论呈现（作者徽章由投影派生）。
- 新评论一律服务端强制 `pending`（客户端传入状态不可信），审核关闭时才直发

## 站点级配置（站长）

后台「插件管理 → comments → 配置」。核心职责边界：**站点级是纯白名单**（只配置"哪里开"），"关闭"动作归创作者内容级设置。

| 键                   | 类型        | 默认 | 说明                                                                                                           |
| -------------------- | ----------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `moderation`         | boolean     | 开   | 评论审核；关闭则发布即公开（fail-safe：缺省按开）                                                              |
| `allowGuest`         | boolean     | 开   | 允许匿名游客评论；关闭时匿名游客被拒绝，CMS 登录用户与微信访客仍可评                                           |
| `guestEmailOptional` | boolean     | 关   | 开：游客邮箱可留空（表单去必填；关：邮箱必填，作 gravatar 头像源）                                             |
| `hideEnv`            | boolean     | 关   | 开：前台隐藏系统/浏览器/IP 属地，仅管理端可见                                                                  |
| `maxLength`          | number      | 500  | 单条最大字数（0 = 不限；另有服务端硬上限 2000 兜底）                                                           |
| `minInterval`        | number      | 0    | 同一访客两次提交的最小间隔秒数（0 = 不限；超限 429 + Retry-After）                                             |
| `notifyAuthor`       | boolean     | 开   | 新评论**站内**通知内容作者（落具体内容项时定向创作者；非本人评论才发）                                         |
| `notifyReplies`      | boolean     | 开   | 收到回复**邮件**通知被回复者（需 SMTP）；审核开启时延迟到回复**通过后**补发，且同一回复只通知一次              |
| `enabledPaths`       | multiselect | 空   | 开启评论的页面路径白名单（可手输任意路径）                                                                     |
| `enabledTypes`       | multiselect | 空   | 开启评论的内容类型（集合 slug）白名单                                                                          |
| `officialRoles`      | multiselect | 空   | 可发官方回复的角色名白名单（手输角色名；空 = 仅 `adminAccess` 角色）。`appAccess` 代表后台准入，不构成官方身份 |

两个白名单留空 = 全站不开启（插件装上后默认静默）。值以字符串落库，布尔两种形态都认。

## 内容级设置（创作者）

内容编辑表单底部（`collection-form-fields-after` 插槽）——仅在站点白名单命中的集合上出现：

| 设置       | 语义                                       |
| ---------- | ------------------------------------------ |
| 关闭评论   | 该内容不显示评论区（站点开着也可以单点关） |
| 仅登录可评 | 游客见「登录后可评论」提示                 |
| 仅展示精选 | 公众号式：人工精选的已审核评论才对外可见   |

存 `plugin_comments_content_settings`（contentId+contentType 归属，path 绑定经 pages 记录桥反查，两视图等价消费）。

## 前台能力

- 发表评论（游客三字段由服务端 HttpOnly cookie `comments_identity` 记住，180 天有效，回访打开评论区自动预填；登录用户只见正文框——身份由服务端会话判定，`/list` 响应 `viewer` 字段下发登录态）
- 访客登录入口：框架未配置微信/QQ 凭据时不显示；已登录显示「以 {昵称} 身份评论」与退出链接，身份三字段隐藏，昵称与头像由签名 cookie 认定。访客按已登录身份处理：站点关闭「允许游客评论」后匿名游客被拒绝，微信/QQ 登录后仍可评论（未登录访客在表单处看到登录提示与入口）
- 无限嵌套回复、@目标点击跳转（平滑滚动 + 落点高亮）、回复前缀
- 分页「加载更多」；顶层页后代按全局上限 500 条带出（防读放大护栏），被截断的线程标注给前端出「查看更多回复」，经 `/children` 精确续拉不重不漏
- 点赞（幂等，按 visitor/user 去重，刷新后红心持久）
- 举报（可选理由，累加计数）
- 编辑 / 删除自己的评论（登录者按 userId 任意本人评论；游客按 visitorId 限本人待审——撤回场景。已过审评论被编辑且站点审核开启时，自动回 pending 重审，防「通过后再改违规内容」）。删除不留孤儿子树：删顶层 = 级联删整条线程；删回复 = 其直接子回复改挂到其父
- 头像：邮箱 md5 → cravatar.cn（gravatar 国内镜像，`d=404`——无对应头像时返 404）；无邮箱或 404 回退首字母色块（色相按昵称散列）；登录用户头像走 user 表实时值
- 官方徽章（主色调）、作者徽章（内容作者评论派生「作者」，中性色与官方分层）、设备环境行（`Windows 11 · Edge · 浙江`）
- 计数与标题区评论数联动（组件头部）；精选模式下公开计数同样只算精选（`/count` 尊重 `featuredOnly`），供主题/自定义 UI 复用该端点
- 文案 i18n：zh/en 由 `/api/v1/i18n/comments` 按访客语言下发
- 移动端自适应（容器查询，侧栏与手机同款规则）：窄容器收小头像、时间行独占一行、身份三字段各占整行、表单操作组（emoji/官方/发表）换行后仍靠右、验证码图与输入可换行；长 URL／无空格长串在评论正文内断行，不产生页面横向滚动

## 管理端能力

- **审核工作台**：通用内容列表（`comments` 集合）——状态/官方/作者/昵称/邮箱/内容/路径/内容类型/系统/浏览器/属地列，`status/likes/reports/createdAt` 可排序，内容搜索；批量通过/标垃圾/回待审；行展开可直接回复（免审+官方标）
- **字段编辑边界**：编辑表单只渲染人工维护的字段（正文、昵称、邮箱、主页、状态、官方标、举报理由）；绑定键（页面路径/内容类型/内容项 ID）与设备环境（系统/浏览器/属地）、内容归属、登录来源由服务端托管——列表可见，编辑表单不出现，保存时保持原值。新建评论时填写绑定键。
- **待审直达**：新评论进入 `pending` 时向管理员发站内通知，深链带 `filter_status=pending` 一键进队列（举报自动回待审的不再重复通知，随队列处理）
- **登录来源筛选**：评论列表工具栏提供「登录来源」下拉（全部 / 微信 / QQ），选中值写入 URL 的 `filter_visitorProvider`，与通用搜索、状态快筛和批量操作叠加；只在 comments 集合列表出现。URL 带着未知来源（未来新增或手工写入）时保留为当前选中项，切换筛选只改该参数与页码
- **关键词黑名单**：存 `plugin_comments_settings`，经 `/admin/settings` 读写（GET 返回词表；POST 逗号/换行分隔的原始串覆盖）——目前仅提供 API，暂无管理 UI（已知缺口）
- 新评论落库后广播自定义事件 `comments:submitted`，宿主/其他插件可订阅做扩展（如管理员推送增强）
- **编辑表单门控**：`/admin/eligible` 判定某内容是否可评（站点白名单命中），内容编辑表单的创作者设置插槽据此整体显隐

## 数据表

| 表                                 | 用途                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `plugin_comments_comments`         | 评论主表（双绑定、嵌套、状态、存证字段）                      |
| `plugin_comments_likes`            | 点赞（按 commentId + 身份（userId/visitorId）应用层幂等去重） |
| `plugin_comments_settings`         | 站点 KV（黑名单词）                                           |
| `plugin_comments_content_settings` | 内容级设置（closed/requireLogin/featuredOnly）                |

举报计数与精选标记是主表列（`reports`/`reportReasons`/`featured`），无独立表。`visitor_provider` 标记访客登录来源（当前 `wechat`），空 = 匿名游客或 CMS 登录用户；openid / unionid 不落库。

`path` 列存可读原文（中文不编码）；库内若有编码形态的路径，插件升级时经框架 `Plugin.migrations`（版本 1「页面路径统一为可读原文」）自动回填一次——执行记录在 `plugin_migrations`，可重入且不会重复执行。

评论与点赞的 `visitor_id` 统一用框架访客 id（`cms_visitor` 里的稳定 UUID），隐私导出/删除按它归集；历史行存的旧 IP+UA 哈希保持原值。

## API 端点

挂载 `/api/v1/plugin/comments/`。public = 免登录；其余管理员会话。

| 端点                                                                                                                          | 档     | 说明                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `POST /submit`                                                                                                                | public | 提交（蜜罐 204 静默、黑名单静默 spam、限流 IP+minInterval、验证码按 forms 作用域要求） |
| `GET /list`                                                                                                                   | public | 顶层分页 + 后代带出 + likedIds + 本人待审并入 + `viewer`/`canOfficial`/设置下发        |
| `GET /children`                                                                                                               | public | 超长线程续拉（rootId + after 偏移）                                                    |
| `GET /count`                                                                                                                  | public | 计数（featuredOnly 尊重）                                                              |
| `POST /like` `POST /report` `POST /delete` `POST /edit`                                                                       | public | 互动（身份匹配校验在服务端）                                                           |
| `POST /admin/reply` `POST /admin/feature` `GET/POST /admin/settings` `GET/POST /admin/content-settings` `GET /admin/eligible` | admin  | 管理端七类                                                                             |

## 对外服务

插件通过框架的 `ctx.service.provide` 暴露一个服务，供主题或其它插件消费（无需 HTTP、不占前台请求预算）：

| 服务 id | 方法 | 说明 |
| --- | --- | --- |
| `comments/count` | `byPath(path)` | 页面路径的已审核评论数（与 `/count` 同口径：内容级 `featuredOnly`、60s 缓存） |
| `comments/count` | `byContent(contentType, contentId)` | 内容项的已审核评论数 |

主题/插件侧取用：

```ts
const comments = ctx.service.get('comments/count');
const count = comments ? await comments.byPath('/about') : 0;
```

- 服务随插件启用注册、停用撤销；未启用时 `get` 返回 `undefined`，调用方按 0 降级。
- 计数口径与前台 `/count` 端点完全一致（含内容级精选过滤与写路径缓存失效），不会出现「服务数」与「页面 N 条评论」不一致。
- 服务形状经 [service-count.ts](../plugin/service-count.ts) 的 declaration merging 登记进框架服务契约表（`PluginServiceContracts`），框架 0.3 下 `ctx.service.get('comments/count')` 直接是强类型，无需断言。

## 反滥用与安全

- **蜜罐字段** `_hp`：视觉隐藏非 `display:none`，机器人填写 → 204 静默成功（不落库，无从探测）
- **黑名单**：关键词命中 → 静默进 spam（对外仍 success），管理员事后处置
- **举报自动化**：累计 3 次 → approved 自动回 pending（进审核队列）
- **限流**：提交 5 次/分钟/IP，点赞 30、举报 5、删除/编辑各 10 次/分钟/IP（另有 minInterval 按访客抑制连发）；429 带 Retry-After
- **人机校验**：站点 captcha 开 forms 作用域时前台渲染验证码输入（复用框架 CaptchaEngine）
- **数据投影**：对外剥离 `userId`/`visitorId`/email 明文——email 只出 md5 哈希（头像源），`hideEnv` 可再收设备环境
- **身份记忆 cookie**：`comments_identity`（HttpOnly / SameSite=Lax / 180 天）只存游客主动填写的昵称/邮箱/主页，供下次打开评论区预填；随提交刷新，三字段全空时清除，登录用户与社交访客不写入
- **权限声明**：只读 `user`（头像昵称反查）、`pages`（路径↔记录桥）、`roles`（官方标判定）；写全部限本插件前缀表
- **状态不可信原则**：客户端传入 status/official 一律忽略，由服务端按会话与设置裁定

## 隐私与访客数据

评论插件向框架登记了一个访客数据主体（`ctx.privacy.register`，登记键 `comments`），由框架的 `/api/v1/privacy/export`、`/api/v1/privacy/erase` 统一受理——访客凭自己的 `cms_visitor` cookie 自助导出或删除「按访客存的那份数据」，管理员可用 `?visitor=<标识>` 代办。

- **导出**：本人作为游客发表的评论（内容/状态/路径/绑定/昵称/邮箱/时间）与本人的点赞记录。
- **删除**：本人作为游客发表的评论按 `/delete` 同语义清理——顶层评论连带整条线程，回复删除前把他人子回复改挂其父；这些评论上的点赞与本人的点赞一并删除，返回删除行数。
- 登录账号发表的评论挂在 `userId` 上（账号数据，不在此登记范围）；历史行存的是旧 IP+UA 哈希，无法映射到统一访客 id，不在导出/删除范围。

## 已知限制

- 匿名页有 60s 公共缓存——评论一律客户端 fetch，SSR 不含实时评论
- 表结构演进半自动：框架在每次注册时对插件表 `CREATE IF NOT EXISTS` + 比对现有列自动 `ALTER TABLE ADD`（**加列零运维**）；但删列/改类型/放宽约束是 SQLite 无法自动做的破坏性变更——只能弃用留列（如 `avatar` 快照列的处置）或站长手动重建，此类变更会写入 Release notes
- `region` 内网/环回地址标注「内网」；第三方 IP 库不可达时留空（best-effort）。历史行存的离线库原始记录在读取时归一，前台展示与新评论一致
