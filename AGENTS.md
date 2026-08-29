# AGENTS.md — 给 AI 编码代理的仓库指南

本仓库（harness-one）是 **dsh（DeepSeek Harness）插件开发工作区**：开发、构建、分发跑在 dsh 里的 Cordis 插件。当前主体是 Workflow One 物业编排套件（7 个默认 `dsh-ccpg-*` 插件 + 独立可选 brand + `web/` 画布），但仓库不限于它——未来任何新 dsh 插件都在这里开发，命名延续 `dsh-ccpg-*` 前缀（ccpg 系列）。

- 仓库通用规则（环境、dsh 插件事实、提交规范）见下方各节，**对所有插件适用**
- Workflow One 专属的架构铁律集中在「Workflow One」一节
- 产品功能文档：`README.md`（主）/ `dsh-plugins/README.md`（安装分发）

## 环境前提

- Node ≥ 22.15.0（Workflow One 用内置 `node:sqlite`；dsh 本体用 `node:zlib` 的 zstd API，22.15 起才有——engines 与脚本最低校验同口径 ≥22.15）。系统自带 Node 版本不够时，用 `DSH_NODE` 环境变量指向任意 ≥ 22.15.0 的 node 可执行文件（setup/start/pack 脚本都认它）
- dsh 全局安装：`npm i -g @deepseek-ai/dsh`
- LLM key 一律经环境变量注入：变量名由 dsh profile 的 provider 配置（`cordis.patch.yml` 的 `apiKeyEnv`）声明，配什么 provider 就用什么变量，文档与代码里不要写死某个 key 名；插件与仓库**不存任何 key**
- 构建脚本为 POSIX sh：macOS / Linux 原生可用，Windows 走 WSL 或 Git Bash

## 提交规范

- Conventional Commits：`feat|fix|build|docs|ci(scope): 摘要`，中文正文说清 what/why，scope 用插件名或模块名（如 `feat(larkauth):`、`fix(web):`）
- 大改动拆多个逻辑提交（引擎 vs 前端 vs 构建 vs 文档分开）；同一文件混多主题时用 patch staging 拆 hunk
- 提交前跑对应面的最小测试；推送前确保 `git status` 干净

## 分支与 PR 规范

分支模型 = **GitHub Flow**（main 常绿 + 短命特性分支），单人开发也遵守：

- **main 始终可部署**：任何时刻检出 main 都能 `build-web.sh + setup.sh` 跑起来。绝不对 main force push
- **主题工作必须开分支**：预计改动 >2 个文件或跨引擎/前端多面的工作，先 `git switch -c feat/xxx`（或 `fix/`、`refactor/` 前缀，与 Conventional Commits 对齐），做完经 PR 合回。目的不是协作，是**隔离**——避免多批不相关工作在同一工作区互相污染（2026-08-21 教训：两批工作混装 + auto-stash，拆提交耗时数倍）
- **分支短命**（1-3 天）：合并后立即删除远端分支；长寿分支是冲突之源
- **小修直推 main 可以**：docs、单行 fix、测试补充等 ≤2 文件的单主题改动
- **PR 流程**（主题分支专用）：
  - push 后开 PR，标题即 Conventional Commit 格式（squash merge 后 commit 历史天然规范）
  - PR 描述写背景/方案/验证结果（截图、测试数字），这是决策记录的档案
  - **合并门槛（缺一不可，合并前自查）**：
    1. **代码审核已做且问题已修**：对完整 diff 自审（可叫 AI 复审），发现的缺陷修完并复测
    2. **本地真实跑通**：改动面相关的真实环境验证——引擎/插件改动要起真 dsh 实测，前端改动要在真实浏览器里点到（E2E 配方见「测试与验证」），不是单测绿就完
    3. 全量回归 + `build-web.sh` 双构建通过；CI 绿
  - **Squash and merge** 合并：WIP 细分提交压成 1 个干净提交；确需保留细分时用 Rebase merge；不用 merge commit
  - 自查：开 PR 后隔 10 分钟过一遍完整 diff 再合
- **多主题并行用 worktree**：`git worktree add ../harness-one-<topic> -b feat/<topic>` 开独立工作目录，各主题互不干扰、随时可弃；同一分支不能检出两个 worktree；新 worktree 要重装 node_modules（多 package 仓库）；用完 `git worktree remove` + 定期 `git worktree prune`

## dsh 插件开发事实（仓库级知识，违反即报错）

无论开发哪个插件都会碰到：

- `defineTool` 必须带 `output: { schema, render }`；文本工具 schema 为 `{type:'string'}`
- `ctx.webServer.register` 形状 `{kind:'exact'|'prefix', path, handler}`；重复 path 抛错
- 给 `ctx` 挂自定义属性必须先 `provide` 声明
- 插件里 `@deepseek-ai/*` 依赖不会从 dsh 主安装解析——`dsh-plugins/bootstrap-deps.sh` 软链解决，勿用 registry 版本
- 浏览器端 module-loader **禁跨插件值导入**（构建纯度门）；插件 client bundle 必须自包含，跨插件 UI 逻辑不得做运行时值导入
- dsh 进程内 `fetch 127.0.0.1` 自请求 404，用 LAN IP
- 官方 UI 特权页（settings/credentials 等）远程必 403（PRIVILEGED_METHODS 钉 loopback），属安全设计不是 bug；插件自有路由不受限
- dsh HMR 会缓存插件模块：改插件代码后必须彻底结束 dsh 进程再重启（macOS/Linux `pkill`，Windows/WSL 用任务管理器或 `taskkill`），半重启不生效
- 新默认插件上线清单：加进 `setup.sh` 与 `pack.sh` 的 `PLUGINS=` 清单（两处同步）、写包内 `cordis.patch.yml` 并在 package.json 声明 `dsh.bundle.patch`（挂载全靠它，profile patch 不再手写插件行）；独立可选插件只进入 `pack.sh` 的 `OPTIONAL_PLUGINS=`；有前端产物则接入 `build-web.sh`；setup.sh 会校验 package name 与目录名一致

## Workflow One（当前主体）

7 个默认插件：tools / orchestrator（引擎+HTTP+SSE）/ web（静态托管）/ canvasui（官方 UI 视图）/ document-preview（文档预览）/ larkauth（飞书登录）/ llm-guard（畸形工具调用防护）。brand 为独立可选插件，默认安装与 `dsh-ccpg-one` 聚合包均不包含。画布 `web/`（Vite + React 18 + @xyflow/react + CodeMirror）。

### 常用命令

```sh
npm test                                   # 全量单测聚合（scripts/run-tests.sh：web 14 套 + orchestrator 17 套 + llm-guard + canvasui + larkauth + one + document-preview）
sh dsh-plugins/build-web.sh                 # 画布双构建（/wf1/ base + 根 base），改前端后必跑（产物不入库，仅落工作区）
sh dsh-plugins/setup.sh [profile] [端口]    # 安装（默认 dsh-ccpg / 4021）
sh dsh-plugins/start.sh <profile>           # 启动
sh dsh-plugins/pack.sh <tag>                # 打包 release（CI 同源）

# 分套运行（改哪跑哪）
cd web && npm test                          # 前端 14 套
cd dsh-plugins/dsh-ccpg-orchestrator && for t in test/*.test.mjs; do node "$t"; done  # orchestrator 17 套
node dsh-plugins/dsh-ccpg-canvasui/test/client.test.mjs         # canvasui 客户端
node dsh-plugins/dsh-ccpg-document-preview/test/index.test.mjs  # 4 例
```

CI：`.github/workflows/ci.yml` 在 PR 与 main push 上跑 `npm test` + `build-web.sh`（产物不入库，仅验证可构建）；发版仍走 `release.yml`。

### 架构铁律（Workflow One 专属）

1. **双端节点注册表**：新增节点类型必须两处注册——引擎 `orchestrator/lib/engine.js` 的 `registerKind({execute, lint, edgeTaken, wantsSink, passThrough, observer})` + 前端 `web/src/registry.jsx`（icon/色/preset/summary/badges）。AI 助手侧同步 `lib/assistant.js`（NODE_TYPES + persona 契约）与 `lib/variable-schema.js`（变量树）。两处注册即得调度/审批/超时/重试/UI 全部能力，不要另起旁路。
2. **canvasui bundle 是构建产物**：`lib/client.js` 由 `src/client.js` 生成（gitignore 不入库），直接改会被覆盖；改后重跑 `build-canvasui.sh`（`--check` 逐字比对防漂移）。
3. **4020 Express 回退能力冻结**：新功能只做插件路径（`/wf1/api/*`）；`server/` 仅修 bug。同语义端点双入口实现时以插件端为准。
4. **工作区本地存储**：工作流与运行记录位于当前 dsh 会话工作目录的 `.workflow-one/workflow-one.sqlite`；state/attachments/runtime 继续使用同目录下文件。节点 agent 以工作区根为 cwd、成果只收集各节点 runtime 输出目录；`.workflow-one/` 必须 gitignore，**绝不提交**。飞书凭据仍是 dsh 用户级数据，不迁入工作区。
5. **构建产物一律不入库**（`web-dist/`、`canvasui lib/client.js`、`document-preview/dist/`、`web/dist/` 全部 gitignore）：分发包「拿到即装」由 `pack.sh` 现场重跑构建保证；源码安装先 `build-web.sh` 再 `setup.sh`（setup 已前置校验）。绝不为省一步构建把产物提交进仓库。
6. **消息通知走渠道抽象**：运行级事件、去重、模式判断、摘要脱敏与失败隔离统一放在 `orchestrator/lib/notifications.js`；渠道实现只放 `notification-<channel>.js`，负责配置校验、消息渲染和发送。新增钉钉/企业微信时注册 provider 到 `NotificationChannelRegistry`，并通过 `/wf1/api/tools` 的 `notificationChannels` 暴露给前端；禁止复制运行监听器或在前端写死完整渠道清单。通知失败只能写节点 `notification` 元数据，不能改变业务运行状态。
7. **多运行并发 + 定时任务**：引擎天然多运行（`Orchestrator.runs` Map，runId 全链路隔离），前端查看态以 `inspectedRunId` 为单一事实源（RunSwitcher 胶囊切换），不要回退到单活跃 run 模型；run-start 只跟随本画布发起的运行，schedule/webhook/catch-up 触发不抢占视图。定时调度核心在 `orchestrator/lib/schedule.js`（cron/overlap/misfire/统计），meta 持久化在 `state/triggers.json`（不迁 SQLite）；停机 misfire 的检测是 `detectScheduleMisfire` 纯函数（只回传事实，计数/补跑属主在 index.js 的 ensureTriggers），补跑 source=`catch-up` 只补最近一次；前端面板 `web/src/ScheduleCenter.jsx` + `describeCron`。
8. **助手工具两家族分工**：`canvas_*` 锚定当前绑定画布/草稿（须 `/assistant/bind` 绑定会话）；`workflow_*` 按工作流 id/name 管库，任意会话可用（按会话 cwd 经 `sessionStore` 定工作区，解析失败不回退默认工作区）。两家族共享 `startWorkflowRun`（启动已保存工作流：组装全局/工作流变量+runInputs 校验）与 `runProgressOf/resumableRun` 整形；改库后若画布正打开该工作流必须同步 cv 并广播 `assistant-patch`，`workflow_open` 广播 `assistant-open-workflow`（前端复用 openWorkflow 路径，脏草稿先静默保存）。节点 agent 工具白名单不含 workflow_*/canvas_*，不会递归发起运行。`/wf1/api/trigger`（#63 `/workflow-one` 触发源执行端）同样共享 `startWorkflowRun`：open 复制图后广播 `assistant-open-workflow`，run 以 `source='trigger'` 起跑——改运行组装/绑定语义时三处（workflow_run、workflow_open、trigger 路由）一起看。

### 消息通知节点约束

- `notify` 是 `passThrough + observer` 节点：在线路中必须透传上游输出，不连线也必须观察整次运行；进度统计排除 `notify` 与 `note`
- `terminal` 模式在运行成功、异常或取消后发送一次；`each_node` 在每个业务节点成功/失败后发送，并在运行结束后追加结果通知；断点续跑恢复的节点不重复通知
- 渠道事件保持中立，至少携带 workflow/run/progress/node/stats/summary/reason；飞书卡片结构不得泄漏到调度层
- 飞书群聊使用 `targetType=chat_id` + `oc_`，私聊使用 `targetType=open_id` + `ou_`；旧节点缺少 `targetType` 时兼容为 `chat_id`
- 卡片摘要优先输出节点，无输出节点时回退最后一个成功业务节点；常见 token/password/secret/API key 必须脱敏并限制长度
- 飞书通知使用画布保存的自建应用凭据（或既有 env 兜底），与 larkauth 的用户扫码登录不是同一套身份；工作流导入导出不得携带凭据值

### 前端坑

- JSX 文本里裸 `{{变量}}` 会白屏——必须包字符串（`{'{{x}}'}`）
- React Flow 节点是独立堆叠上下文：节点内弹出菜单的 z-index 只在本节点生效，宿主节点需 `:has(.add-open)` 提层级
- CDP/headless 下 React Flow `n.selected` 不可靠，E2E 断言用 `.toolbar .btn` 精确匹配（图标已 SVG 化，textContent 不含类型字）
- 前端构建**必须**走 `build-web.sh`（双 base），不要直接 `npm run build`

### 测试与验证

- 单测全部是零依赖 node 断言脚本（`node:assert` + 自写 runner），直接 `node <file>` 运行；新插件照此约定写测试
- 改引擎跑 orchestrator 17 套；改前端跑 web 14 套；改 canvasui 跑其 client 测试并重建 bundle；改预览跑 document-preview 4 例
- 通知单测：`node test/notifications.test.mjs && node test/notification-feishu.test.mjs`。真实飞书测试是 `test/notification-feishu.live.mjs`（文件名刻意不匹配 `*.test.mjs`，默认测试/CI 不发送消息）；仅在用户明确批准收件人与实发后，用临时环境变量传入 App ID、App Secret 及 `FEISHU_CHAT_ID=oc_...` 或 `FEISHU_OPEN_ID=ou_...`，凭据绝不写入命令文档、源码、fixture 或日志
- E2E 用 CDP（chrome-devtools）跑真实浏览器验证；dsh 官方 UI 首载慢，等待时间放宽（画布就绪 3.5s→6s），wait text 偶超时先多等几秒再判失败
