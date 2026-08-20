# MVP：可拖拽智能体工作流编排（物业场景）

**agent 节点默认由 dsh（DeepSeek Harness）底座驱动**——每个节点是一个真实 agent：自主循环、bash/文件系统工具、会话持久化、技能系统，工作区即节点目录。dsh 不可用时自动回退内置工具循环。画布层先跑通"拖拽编排 → 按拓扑序执行 → 节点状态实时回流"的闭环。

## dsh 底座接入（agent 运行时）

- 安装：`npm i -g --prefix ~/.local/npm-global @deepseek-ai/dsh`（需 Node≥20；系统 Node 18 时用 `DSH_NODE` 指向新 node，如便携版 `/tmp/node-v22.20.0-darwin-arm64/bin/node`）
- 首次跑 `dsh --profile headless "hi"` 自动初始化 `~/.dsh/profiles/headless/`
- 修 sharp 原生缺包：`cd <dsh安装>/node_modules && npm i @img/sharp-darwin-arm64 --no-save`
- GLM 接入：`~/.dsh/profiles/headless/cordis.patch.yml` 里给 `llm-pi-ai` 配 hand-declared provider（`api: anthropic-messages`、`baseURL: https://open.bigmodel.cn/api/anthropic`、`apiKeyEnv: GLM_API_KEY`），并把 `agent-default-model` 指到该 route
- 启动需 `node --expose-internals`（HMR 服务要求；编排器已内置）
- 编排器探测：`agent-runtime.js` 的 `detectDsh()` 检查 node/bin/profile/凭据；节点执行 spawn `dsh --profile headless <task>`，cwd=节点工作区（`data/workspaces/<节点名>/`），产物落盘可复用；失败自动回退内置循环并在节点状态标注
- 迁移方向：编排器/飞书工具改造为 Cordis 插件（`ctx.agents`/`ctx.tools` seam），画布做 client 插件——届时不再 spawn 子进程而是进程内调用

## 快速开始

完整产品以 dsh 插件入口为准。该入口包含工作流库、运行历史、凭据、触发器、审批、结构化输出和变量系统；`server/` 下的旧 Express 服务仅保留为兼容演示，不再扩展新能力。

```sh
# 1. 构建画布（生成 /wf1/ 插件资源和旧 Express 兼容资源）
sh dsh-plugins/build-web.sh

# 2. 启动 dsh web profile（需要 Node >= 20）
DSH_NODE=/tmp/node-v22.20.0-darwin-arm64/bin/node \
  sh dsh-plugins/start.sh web
# → http://127.0.0.1:3080/wf1/
```

端口由 dsh `web` profile 配置决定。浏览器访问 `/wf1/` 使用正式的 `/wf1/api/*` 运行时。

## 功能

- **可拖拽画布**（React Flow）：节点拖动、连线（禁止自环）、缩放、小地图
- **三类节点**：输入（文本/附件/飞书链接）、智能体（提示词+工具勾选）、输出（汇总上游）
- **节点属性面板**：点选节点后编辑名称、提示词、输入内容、勾选工具、上传附件
- **智能体工具勾选**：每个智能体节点可勾选 `read_file` / `web_fetch` / `feishu_doc_read` / `feishu_doc_write`；真实模型走 function-calling / tool_use 工具循环，mock 模式演示单次调用
- **节点级 LLM 配置**：每个智能体节点可单独设置**模型**（如 glm-5.3 / glm-5.2 / deepseek-chat）、**渠道**（GLM 的 anthropic 订阅通道 / openai 按量通道）、**工具循环轮数上限**（默认 6，最大 20）。留空则用全局默认——同一个图里不同节点可用不同模型组队协作。节点卡片显示所用模型徽标，运行记录也记录每个节点实际使用的模型。
- **附件上传**：输入节点可上传附件（≤5MB，存 `data/attachments/`）；文本附件运行时直接注入上下文，二进制附件供 `read_file` 工具按需读取
- **飞书链接解析**：输入内容或触发输入里粘贴 `https://xxx.feishu.cn/docx/...` 或 `/wiki/...` 链接，运行时自动识别并注入文档全文（需配置 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`；未配置时注入占位说明，不影响闭环）
- **结构化变量系统**：模板编辑器覆盖输入、智能体、条件、审批、输出和 HTTP 的 URL/Header/Body。输入 `{{`、`/变量` 或 `/var` 可搜索直接上游的字段树，也可点击、复制或拖拽插入；字段显示类型、说明和当前工作流最近一次运行值。
  - `{{node["n_http_123"].text}}` — 节点兼容文本输出
  - `{{node["n_http_123"].data.json.customer.name}}` — 稳定 ID 的结构化子字段
  - `{{node["n_http_123"].data.json["x.y"][0].name}}` — 特殊键名与数组下标
  - `{{node["n_http_123"].meta.durationMs}}` — 安全执行元数据
  - `{{node["n_http_123"].data.phone | default("未提供")}}` / `| optional` — 缺省值与可选字段
  - `{{$trigger}}` / `{{$upstream}}` — 本次触发输入与全部直接上游
  - 新引用绑定稳定节点 ID，节点重命名不影响运行；旧 `{{节点名}}`、`{{@节点名}}` 和 `{{节点名.json.path}}` 继续兼容并在 lint 中提示升级。
  - 模板留空或不含变量时保留原来的全量上游注入行为，旧图与旧运行记录不需要改写。
- **Plan-Execute 模式（agent 节点开关，默认关）**：打开后该节点执行走三阶段——① 规划器基于任务生成 3-6 步计划（不带工具，无副作用）→ ② 按计划逐步执行，每步输出 `STEP n. 结果`，可调用勾选的工具，某步失败标注并继续 → ③ 总结器基于计划+执行记录产出最终交付（不带工具）。计划/执行全程记录在运行结果的 `planTrace` 里；规划解析失败自动回退为直接执行。适合复杂多步任务；简单整理类任务保持关闭更快更省。节点卡片显示 🗺 Plan 徽标。
- **并发执行**：就绪即发调度器——分支无依赖即并行执行（SSE 事件流里可见 running 状态重叠）
- **分支容错**：某分支失败只跳过"全部上游都失败"的下游节点；仍有成功上游的节点照常执行（缺失输入按空处理），运行整体标 error 但其余分支完整跑完
- **环检测**：成环直接拒绝执行
- **实时状态**：SSE 推送 `run-start` / `node-status`(queued/running/success/error/skipped) / `run-end`，画布节点即时变色
- **持久化**：图结构保存到 `data/graph.json`；"重置示例"恢复内置并行分支示例
- **双模式 LLM**：mock（零依赖演示）/ DeepSeek（OpenAI 兼容接口 + 工具调用）

## 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `GLM_API_KEY` | 启用 GLM 真实模型（优先级高于 DeepSeek） | mock 模式 |
| `GLM_MODEL` | GLM 模型名 | `glm-5.3` |
| `GLM_COMPAT` | GLM 协议通道：`anthropic`（Coding Plan 订阅）/ `openai`（paas/v4 按量） | `anthropic` |
| `GLM_BASE_URL` | 自定义端点 | 按 COMPAT 选默认 |
| `DEEPSEEK_API_KEY` | 启用 DeepSeek 模型 | mock 模式 |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 自定义端点/模型 | 官方默认 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书开放平台应用凭据（自建应用，需开 docx 读权限） | 链接解析返回占位 |

> 注意：智谱同一个 Key 在两条通道的计费独立——Coding Plan 订阅走 `/api/anthropic`，按量余额走 `/api/paas/v4`。余额不足报 1113 时切 `GLM_COMPAT=anthropic`（或反之）。

## 架构

```text
web/                    前端（Vite + React 18 + @xyflow/react）
  src/App.jsx           画布 + 工具栏 + SSE 订阅
  src/FlowNode.jsx      自定义节点渲染（类型色 + 运行状态 + 工具/附件徽标）
  src/NodePanel.jsx     右侧属性面板（提示词/工具勾选/附件上传）
server/                 后端（Node 18 + Express，除 Express 外零依赖）
  server.js             静态托管 + 图 CRUD + 运行/附件/工具 API + SSE
  orchestrator.js       并发调度器（就绪即发 + 失败分支传播）+ 事件广播
  llm.js                LLM 适配层（MockLLM / DeepSeekLLM 含工具循环）
  tools.js              工具注册表 + 执行器（read_file/web_fetch/feishu_*）
  feishu.js             飞书链接识别 + 开放平台 API（docx→markdown）
data/graph.json         持久化的工作流图（gitignore）
data/attachments/       上传的附件存储
```

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/graph` | 读取图（无文件时返回内置示例） |
| PUT | `/api/graph` | 保存图 |
| POST | `/api/graph/reset` | 重置为示例图 |
| POST | `/api/attachments` | 上传附件 `{ filename, contentBase64 }`（≤5MB） |
| GET | `/api/attachments` | 列出已上传附件 |
| GET | `/api/tools` | 工具清单 + 飞书配置状态 |
| POST | `/api/run` | 触发执行 `{ graph, triggerInput }` |
| GET | `/api/runs` | 最近 20 次运行历史（含各节点输出） |
| GET | `/api/events` | SSE 事件流（node-status 成功事件带 `outputPreview` 前 4000 字 + planMode 节点的 `trace`） |

## 与 DeepSeek Harness 的映射关系

这个 MVP 刻意复刻了 dsh 的分层思路，为后续迁移到 dsh 插件体系做准备：

| MVP 组件 | dsh 对应概念 |
|---|---|
| `orchestrator.js` 逐节点驱动 | 自研 orchestrator + `ctx.agents` 起子 agent（不走向 `ctx.workflowEngine` 的脚本路线，因其无保存工作流/断点恢复） |
| 每个智能体节点的提示词 | agent preset（`packages/preset`：per-session 从 cordis.yml 组装提示词+工具集） |
| SSE 事件流 | dsh 的 `session/event` 广播（浏览器端从会话日志渲染） |
| `llm.js` 适配层 | `ctx.llm` 适配器 seam（`packages/llm`） |
| `data/graph.json` | `ctx.storage`（非会话存储 seam） |
| 运行时触发输入 | `agent.inject()` 注入模型可见上下文 |
| React Flow 画布 | 未来作为 dsh client 插件（`ui-slots` 的 `register()` 挂载） |

## 后续路线（对应完整方案）

1. **输出节点写回飞书**：输出节点绑定飞书文档 token，执行完自动 `feishu_doc_write`（工具已就绪，缺节点级配置 UI）
2. **人工审批节点** → dsh `ctx.approval`
3. **整体迁入 dsh**：orchestrator/工具改为 Cordis 插件，画布改为 `ui-slots` 注册的 client 插件

## 已知限制

- 飞书写回为追加段落块（block_type=2），不保留富文本格式
- 无节点级重试；无运行暂停/取消
- mock 模式输出为模板文本（会演示一次工具调用）
- 编辑后需点"保存"才持久化（运行时会自动保存）

## dsh 产品插件形态（dsh-ccpg 系插件，跑在 web profile）——完全体

`dsh-plugins/` 下三个 Cordis 插件 + 一个 profile，整个产品跑在 dsh 进程内：

| 包 | 职责 |
|---|---|
| `dsh-ccpg-tools` | 飞书文档读写 + load_skill 技能渐进加载，注册到 `ctx.tools`（与 dsh 自带 bash/fs 工具同池） |
| `dsh-ccpg-orchestrator` | DAG 调度引擎；**agent 节点 = `ctx.agents.create` 进程内真实 dsh agent**（followup → whenIdle → session events 聚合输出，同官方 headless 驱动模式）；节点 cwd = 工作区；`/wf1/api/*` HTTP + SSE 挂 `ctx.webServer` |
| `dsh-ccpg-web` | 画布静态托管（`web-dist/`），SPA fallback `/wf1/` |

- profile：`~/.dsh/profiles/wf1/`（dsh-base + 上述插件行 + GLM provider patch，端口 4021）
- 启动：`sh dsh-plugins/start.sh` → 画布 http://127.0.0.1:4021/wf1/
- 前端 API base 经 `window.__WF1_API_BASE__='/wf1'` 注入（旧 Express 入口默认 '' 不受影响）
- 插件依赖用 file: 链到 dsh 主安装的 node_modules（版本不漂移）；改插件源码后需在 profile 里重装（`dsh plugin --profile web add <路径>`）
- E2E 已验证：报修工作流经 profile HTTP API 执行，agent 节点进程内跑 dsh agent（glm-5.3），自主产出工单 md 落盘节点工作区，SSE 全程回流

### 已知 dsh 插件开发事实（踩坑记录）

- `defineTool` 必须带 `output: { schema, render }`（文本工具 schema `{type:'string'}`）
- `ctx.webServer.register` 路由形状是 `{kind:'exact'|'prefix', path, handler}`，重复 path 抛错
- 给 `ctx` 挂自定义属性需 `provide` 声明，直接赋值抛 "cannot set property without provide"
- 插件包里的 `@deepseek-ai/*` 依赖不会从 dsh 主安装解析，需显式 file: 链接安装

### 插件路径完整 HTTP 面（补齐）

| 端点 | 说明 |
|---|---|
| `POST/GET /wf1/api/attachments` | 附件上传（base64 ≤5MB）/列表；落盘 `dsh-plugins/dsh-ccpg-orchestrator/data/attachments/`，agent 节点运行前自动复制进节点工作区，dsh 自带 read 工具直接读 |
| `GET /wf1/api/skills` | 技能目录清单；数据源 `~/.dsh/workflow-one-skills/*.md`（用户可编辑，WF1_SKILLS_DIR 可覆盖） |
| `GET /wf1/api/llm-config` | 模型配置：agentDefaultModel 当前选择 + `ctx.llm.listModels` 路由模型表 |

- 技能数据源统一在 `~/.dsh/workflow-one-skills`（dsh-ccpg-tools 的 load_skill 与编排器的目录索引/端点同源）
- agent 面板「技能」chip 多选（选中注入技能目录索引，正文模型自主 load_skill）
- E2E 已验证：上传巡检附件 + 勾选「工单规范」技能 → agent 用 read 读附件、调 load_skill 加载规范、按规范格式产出工单 md（session 日志证实两次工具调用）

### 本地分发（2026-08-19）

`dsh-plugins/setup.sh` 一条龙：建 profile → `dsh plugin add` 三插件 → SDK 依赖引导（dsh 内层 node_modules 软链）→ patch 组装。任何装了 dsh（node≥20）的机器 clone 本仓库后 3 步可用（build-web.sh / setup.sh / start.sh，见 dsh-plugins/README.md）。全新 profile 已端到端验证（画布 200、28 工具、附件+技能场景：load_skill 调用、read 读附件、产物按技能规范格式）。**修复：AgentOptions 无 systemPrompt 字段，节点提示词经 scoped setup 的 `systemPrompt.section({name:'deployment:persona', order:0})` 同名覆盖 persona 槽位注入**（此前 agent 不落盘不调技能的根因）。

### 工作流库（2026-08-19）

侧边栏新增「工作流」tab：命名工作流列表（卡片含名称/智能体数/节点数/更新时间），支持新建/打开编辑/重命名/删除。后端 `GET|POST /wf1/api/workflows` + `GET|DELETE|PATCH /wf1/api/workflows/detail`，存储 `<orchestrator>/data/workflows/<id>.json`。画布打开工作流后「保存」写回该工作流（未打开时保持草稿 graph 旧行为）。旧 Express 入口（4020）同步实现同语义端点，双入口一致。
