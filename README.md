# 天监 dsh-supervisor

给 DeepSeek Harness 用的**需求监督插件**：施工代理每完成一个阶段，把汇报交给天监；天监在**干净上下文**里对照用户批准的基线审一次，判断有没有发生需求偏移，并当场给出裁决与纠偏建议。

设计细节见同目录上一级的 `dsh-supervisor_Spec.md`（决策已全部拍板，见 §0.5 台账）。

## 当前状态：v1.3（B1–B8 完成 + 用户意图接入 P0/P1 + 独立页重制）

| 已实现 | 说明 |
|---|---|
| 存储域 `supervisor` v1 | storage-domain，per-record，落盘 `~/.dsh/storages/supervisor/`；表 `baselines` / `reviews` / `reports` / `journal`（journal 带哈希链） |
| 设置域 `supervisor_settings` v1 | 单条布局：审查开关、引擎、轻审/深审模型、超时、证据上限、阻断阈值、定时兜底、阈值打断 |
| 证据采集器（B3） | 订阅 `session/event` 全量事件折叠：回合/步/工具调用与失败/命令/待办/目标/用户请求/事件直方图；`workspace/changes` 到达即采文件级 +/−；按 `write`/`edit` 调用推定被改文件 |
| 司天汇编（B4） | 基线 + 机器证据 + 最近几次审查 + 施工方自述 → 审查简报（**基线永远完整注入**，只有证据块会被字数上限裁剪） |
| 观天轻审（B5） | 单次隔离模型调用（零父上下文、`temperature: 0`），严格 JSON 裁决：`aligned` / `minor` / `drift` / `critical` + findings + suggestion + blocking |
| 观天深审（B6） | 两段式：第一段「细读」找疑点，第二段「对抗核验」逐条核验后才出裁决；轻审判出偏移或阶段很大时自动升级（可关） |
| 定时兜底（B7a） | 每 60 秒检查一次：回合已结束 + 有新改动 + 距上次审查超过 `autoReviewMinutes`（默认 20）→ 自动复审一次，最多每 20 分钟一次 |
| 阈值打断（B7b） | 连续偏移或严重偏移达阈值时，在下一次 `agent/pre-step` 返回 `{kind:'reject'}` 强制中断该回合；触发后计数清零并有 30 分钟冷却。**默认关闭**，等 UI 能显示提醒后再开 |
| `supervisor` 工具 | 九个 action：`status`、`baseline_set`、`report`、`review`、`evidence`、`review_list`、`journal_tail`、`settings`、`ack` |
| 三个界面（v1.0） | 浏览器半边 `client.js`，宿主经 `POST /api/dsh-supervisor/rpc` 提供快照：<br>① **侧栏「天监」图标 + 中央总览页**：跨项目 rollup、裁决分布与阈值、最近审查、基线、政策与配置表单<br>② **输入框上方胶囊**：状态灯 + 一键启用/停用本会话<br>③ **会话内「天监」标签页**：本会话裁决、疑点、纠偏指令、自述 vs 机采、阈值仪表、阶段台账、审计链、分析记录 |
| 降级 | 存储或模型不可用时工具返回 `degraded` 并继续，不阻塞施工 |

尚未实现（见 spec §19）：B10 kyzmem 回流，以及深审升级为「能自己读仓库的子代理」（`观天` 预设已就绪，就差把深审从"两次模型调用"换成"spawn 只读子代理"）。

## 预设（B9）

`cordis.patch.yml` 里声明了两套 Agent 预设，新建会话时可在预设选择器里选：

| 预设 | 用途 |
| --- | --- |
| `御天司监`（yutian） | 完整开发工具面（与 standard 一致）+ 协作约章：**每阶段结束强要求调用 supervisor 汇报**，不由模型判断必要性；主代理不扮演司天/观天，只负责唤起天监 |
| `观天`（guantian） | 只读审查者：persona + 只读 fs + 搜索 + 问用户 + 压缩，无 bash/write/edit/web；干净上下文，一次性审查用 |

## 故障复盘：v0.6.0 导致 web boot 失败（已修，v0.6.1）

- 症状：启动即报「应用无法启动或已意外停止 · web boot: 1 entry did not activate · dsh-supervisor: loading」，应用进入安全模式。
- 根因：`package.json` 的 `dsh.client.inject` 里写了 `@deepseek-ai/dsh-client-ui-slots` —— 这个包在本 profile 里**没有对应的插件行**（`Config.listConfigs` 查不到 entry；而 `dsh-client-connection` / `-locale` / `-ui-layout` / `-ui-settings` / `-ui-conversation` 都有）。启动时该条目永远等不到依赖，卡在 `loading`，web boot 判定失败。
- 修复：删掉那条注入；并在 `client.js` 加两层防御——`require('react')` 失败时返回空插件，`apply` 全程 try/catch（UI 挂不上只是「界面不见了」，绝不连累启动）。
- 教训：`dsh.client.inject` 只能写**确实存在的客户端插件包名**；`slots` / `theme` / `timer` 是内核 baseline 服务，不需要也不该出现在这里。任何 client 半边的顶层异常都会拖垮整条前端 bundle，所以客户端代码必须 fail-open。

## 界面（v1.0）

四个落点，全部是原生槽位注册（没有自定义 DOM、没有 iframe）。版式是「工作台」：总览页按紧迫度自上而下排（状态条 → 告警条 → 指标带 → 裁决与阈值 → 审查表 → 基线 → 政策与配置表单），会话页是「左裁决 / 右阈值与元信息」双栏 + 底部阶段台账；样式语言与 harness 默认界面一致（系统字体、8–10px 圆角、`T.surface` 面色、11–13px 字号、无大写跟踪标签）。

| # | 槽位 | 形态 |
|---|---|---|
| ① | `sidebar.panellist` | **左侧栏图标入口「天监」**（与 kyzmem 的「天枢」同款做法，`order: 51` 紧挨天枢） |
| ② | `main`（key `dsh-supervisor`） | **左边栏「天监」点开的独立页**（v1.3 重制）：面向开发者的数据掌控台 —— 报头 + 7 格 KPI 带 + 工具条（项目维度切换 / 筛选 / 密度 / 导出）+ 项目 × 阶段矩阵 + 要求台账 + 基线 + 政策与生效链 + 审计与健康，点行右侧推开抽屉看单条明细 |
| ③ | `conversation.input.dock` | 输入框上方的**胶囊**：`天监` 两字 + 状态灯，点一下启用/停用本会话；灯语＝灰未启用 / 绿监察中 / 黄有偏移 / 红严重 / 呼吸＝审阅中，查看 Tab 后自动复位 |
| ④ | `conversation.view` | 会话内的**「天监」标签页**：本会话裁决、疑点与纠偏指令、自述 vs 机采对照、阈值仪表、阶段台账、审计链、司天与观天的完整分析记录 |

- **侧栏入口的注册方式**（照抄 kyzmem）：`ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:PANEL_ID, order:51, label:'天监' }, Icon))` 与 `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:PANEL_ID }, Panel))` —— 两处用**同一个 id**，点图标才会切到对应面板。
- 界面只读：调 `overview` / `session.state` / `session.toggle` / `review.transcript` / `settings.set` / `notice.ack`，全部落在 `POST /api/dsh-supervisor/rpc`（包私有 RPC 优先，HTTP 后备）。
- **样式**：只用 `--dsw-alias-*` 主题 token，不写字面色（插画除外），不加载任何 DSH Client 包，不注入全局 CSS；因此 `dsh-k-bloom-theme` 换肤时天监会一起变。图标是手绘 SVG，不用 emoji。
- **配置**：面板里的开关与数字立刻写进 `supervisor_settings` 域，等于 `supervisor action=settings`，但不用打字。
- **提醒**：阈值打断挂起的提醒会在总览页、会话 Tab 与胶囊上显示，点「清除提醒」等于 `supervisor action=ack`。
- 宿主通道不可用（例如极简 profile 没装 `connection`）时，界面降级为一句提示，不影响工具面。

### 卡片样式

工作台的每个块都是一个卡片：`T.surface` 底色 + `1px solid T.border` 轮廓 + `10px` 圆角 + `12–14px` 内边距，间距 `9–16px`。侧栏总览页的 `SvPane`（裁决与阈值、最近审查、基线、政策·配置）、四格指标带 `SvRail`、告警条，以及会话 Tab 的 `TabBlock`（当前裁决、触发与核对、阈值仪表、基线）和 `TAB_UI.tape` 指标带、`TAB_UI.table` 台账区，全部走同一套卡片样式；强调色只出现在左侧 2px 竖线与文字上，卡片本身不染色。

### 与 `dsh-better-sidebar` 兼容

`dsh-better-sidebar` 的浏览器半边会把服务发布成 `ctx.betterSidebar`（`registerTab` / `registerFileViewer` / `openTab` …）。天监在 `apply` 里探测这个服务，存在时注册一个标签页：

```js
svc.registerTab({
  id: 'dsh-supervisor:overview',
  title: '天监',
  description: '需求监督：跨项目的裁决台账、阈值与政策配置',
  order: 51, single: true,
  icon: (size) => Seal({ size: size || 14, mono: true }),
  component: () => SupervisorPanel({ rpc, inSidebar: true }),
})
```

于是总览页也能出现在该插件的侧栏窗口里（`+` 菜单 / 原生右栏胶囊），与左侧栏图标、中央面板共用同一个页面组件。三个细节：① 用 `ctx.get('betterSidebar')` 探测而不是 `inject` —— 未声明 inject 的属性访问在 cordis 里会抛错，而写进 inject 会在没装该插件时阻断天监激活；② 服务可能比天监晚激活，所以探测按 20 × 500ms 重试；③ 面板每 12 秒轮询，注册只是多挂一个渲染面，没有额外通道。

## 一次典型调用

```
supervisor action=report summary="本阶段做了什么、为什么这样做" touched=["a.js","b.js"]
```

返回：`第 N 阶段审查完成 —— 【存在偏移】` + 结论 + findings + 建议；阻塞级会额外提示「先向用户报告」。审查记录与证据包一并落库，`review_list` / `journal_tail` 可回看。

## 配置

```
supervisor action=settings config={ lightProvider: "opencode-go", lightModel: "deepseek-v4.1-flash" }
```

留空则跟随当前会话模型（从 `request/header` 的 `config.provider/model` 取）。`timeoutMs` 默认 90000，`maxBriefChars` 默认 6000，`driftStreakLimit` 默认 2，`criticalLimit` 默认 3。

## 重要约束
- **运行文件只能 import Node 内置模块。** 插件真实目录在工作区，profile 里是符号链接，ESM 解析不到第三方包（实测 `zod` → `ERR_MODULE_NOT_FOUND`）。结构化校验用自带的 `schema()`（见 `index.js` 顶部）。
- 改完 `index.js` 必须 `plugin_manager set_plugin` 关→开重载，文件改动不会自动生效。
- **客户端半边的 `styles` builtin 取不到**：`require('styles')` 与 `ctx.get('styles')` 在实测中都是 undefined（`Builtin.listBuiltins` 里虽有该方法），所以会话 Tab / 侧栏 / 胶囊一律用 React 内联样式对象，独立页把整页 `<style>` 作为组件子树里的一个节点渲染 —— 这样既能生效，又随卸载自动清除。**不要**依赖 `styles.insert`。
- 天监**没有执行权**：只提醒、给建议、标阻塞，不改用户消息、不拦工具调用。
- 数据不写进本目录，写 profile storage（或后续可选的 `WS/.supervisor/` 只读镜像）。

## 安装

```bash
# 由 DSH 的 plugin_manager 安装（把本目录作为 bundle target，装完 symlink 进 profile）
```
