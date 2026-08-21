# harness-one — dsh 插件开发工作区

本仓库是 **dsh（DeepSeek Harness）插件开发工作区**：在这里开发、构建、分发跑在 dsh 进程内的 Cordis 插件；未来任何新 dsh 插件都在这里孵化，命名延续 `dsh-ccpg-*` 前缀（ccpg 系列）。

当前主体是 **Workflow One 物业智能体编排套件**（`dsh-plugins/dsh-ccpg-*` 七插件 + `web/` 画布）：拖拽式工作流画布跑在 dsh 进程内，**每个智能体节点是一个真实 dsh agent**（自主循环、bash/文件系统工具、会话持久化、技能系统），工作区即节点目录。画布 → 拓扑调度 → 节点状态实时回流，全链路闭环。

- 画布入口：`http://127.0.0.1:4021/wf1/`（dsh web profile）
- 官方 dsh Web UI：`http://127.0.0.1:4021/`（同进程同端口；画布注册为 conversation.view 一等视图，侧边栏 🧩 进入）
- 右侧工作台侧边栏：官方 UI 右侧为 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（setup.sh 默认从 npm 安装）；我们的「对话记录」tab 排在其 + 菜单第一位，切到工作流视图时自动展开

> 远程访问：setup.sh 里 webserver host 默认 `127.0.0.1`，局域网/Tailscale 需改 `0.0.0.0`（dsh agent 有 bash 能力，仅在可信网络开放）。官方 UI 的 settings/credentials 等特权页仅限 loopback（远程 403 属安全设计），插件自有路由不受影响。

## 快速开始

```sh
# 前提：node>=20、npm i -g @deepseek-ai/dsh
cd dsh-plugins

sh build-web.sh                          # 1. 构建画布（含 document-preview）——产物不入库，源码安装必跑
sh setup.sh [profile] [端口]             # 2. 一条龙安装（默认 dsh-ccpg / 4021）
sh start.sh [profile]                    # 3. 启动
```

**模型不归本仓库配置**：插件里的 agent 全部走 dsh 自己的模型配置（profile 的 `cordis.patch.yml`）。`setup.sh` 会写入一份 GLM provider 示例（`apiKeyEnv: GLM_API_KEY`），此时 `GLM_API_KEY=xxx sh start.sh [profile]` 生效；想换模型/渠道，改 patch 里的 `llm-pi-ai.providers`（openai-completions / anthropic-messages 均可），key 环境变量名跟着 `apiKeyEnv` 走——变量名由 dsh profile 声明，本仓库与插件不写死、不存任何 key。

> lark-cli（飞书官方 CLI）由 setup.sh 自动安装；忘了装也没关系，larkauth 插件启动时会自举补装。

## 画布能力

**7 种节点类型**：输入 / 智能体 / **脚本（QuickJS 沙箱）** / 条件分支 / HTTP 请求 / 输出 / 注释。

- **可拖拽画布**（React Flow）：连线（禁自环/环检测）、缩放、小地图、框选、快捷键（Cmd+S 保存 / Cmd+Z 撤销 / Delete 删除 / Cmd+D 复制 / F 定位错误）
- **智能体节点**：提示词 + 工具勾选（read_file / web_fetch / feishu_doc_read / feishu_doc_write）；节点级模型与渠道（GLM anthropic 订阅 / openai 按量、DeepSeek），同图不同节点可组队；工具循环轮数上限；Plan-Execute 三阶段模式（规划→逐步执行→总结，planTrace 全程记录）；技能 = dsh 原生 skill 工具（`ctx.skills` 目录，节点可勾选定向提示）
- **脚本节点**：QuickJS 沙箱执行同步 `function main(input, workspace)` 返回 JSON。命名参数支持「表达式」（完整变量，仅直接上游）或「JSON 常量」；workspace 仅可 list/read/write/remove 本节点目录（拒绝穿越/反斜杠/符号链接）；超时 100–10000ms；可选 outputSchema 校验（失败即节点失败）；返回值进变量树
- **变量系统**：模板编辑器（输入 `{{` 或 `/变量` 搜索字段树）覆盖全部模板位；稳定 ID 引用 `{{node["n_http_1"].data.json.customer.name}}`、缺省值 `| default("x")`、`{{$trigger}}` / `{{$upstream}}`；改名联动全图替换；旧 `{{节点名}}` 语法兼容
- **运行与调试**：SSE 实时状态（queued/running/success/error/skipped）；就绪即发并发调度；分支容错（单支失败不拖垮其余）；节点重试 / 失败继续 / 超时；运行取消 / 重放 / 导出；试运行（手填假输入、关闭即中断）；节点级运行详情（实际输入、产物、token 用量、trace）
- **结果面板**：时间线按图拓扑稳定排序（跳过分支也可见）；最终结果取输出节点、失败不被中间结果顶替；过程产物折叠分组；产物流式下载（Range 206 / 统一 MIME / HTML sandbox CSP）与全屏预览（PDF/DOCX/XLS(X)/PPTX 本地渲染）
- **触发与集成**：webhook（token 鉴权）、cron 定时、飞书写回（输出节点可选）
- **持久化**：工作流库（命名工作流 CRUD）、运行历史（含 graph 快照）、重启恢复（触发器落盘 + 链式定时等待）
- **可靠性**：保存失败 toast 报错并中止运行；命名工作流运行带 graphFingerprint 指纹校验（409 拒绝跑错版本）

## 画布 AI 助手

官方 dsh Web UI 的聊天里直接改图（同 session，经 canvas_* 工具落图）：`canvas_get_graph` / `canvas_graph_summary` / `canvas_graph_patch`（批量原子操作，含 script 节点契约）/ `canvas_lint_graph` / `canvas_run_workflow` / `canvas_run_status`。聊天记录在右侧 better-sidebar 的「对话记录」tab 实时显示该 session 的消息与工具调用流（不可见时自动暂停轮询）。

## 飞书

- **账号登录**：官方 dsh Web UI 设置面板「飞书账号」扫码（lark-cli Device Flow，token 由 CLI 自管零落盘）；user token 后台自动续约（refresh 轮换，授权长期有效）
- **凭据**：画布 ⚙ 设置弹窗管理多套自建应用凭据（掩码/默认切换/输出节点可选）
- **技能**：feishu-cli 技能由 larkauth 种子到 dsh 原生技能根 `~/.dsh/skills`（官方聊天 agent 与画布 agent 共用）；agent 默认 `--as user`，失败降级 `--as bot`

## 插件形态（dsh-ccpg 系，七插件）

| 包 | 职责 |
|---|---|
| `dsh-ccpg-tools` | feishu_doc_read / feishu_doc_write 注册 `ctx.tools` |
| `dsh-ccpg-orchestrator` | DAG 调度 + 节点级 `ctx.agents` 进程内 agent + QuickJS 脚本节点 + `/wf1/api/*` HTTP/SSE |
| `dsh-ccpg-web` | 画布静态托管 `/wf1/`（SPA fallback） |
| `dsh-ccpg-canvasui` | 官方 dsh Web UI 画布视图（conversation.view tab）+ canvas_* 工具 + better-sidebar「对话记录」tab（软依赖） |
| `dsh-ccpg-document-preview` | 文档全屏预览（pdfjs / docx-preview / sheetjs / @file-viewer/pptx，inline workers、无第三方上传） |
| `dsh-ccpg-larkauth` | 飞书扫码登录（启动自举、token 续约、技能种子）；官方设置面板「飞书账号」section |
| `dsh-ccpg-brand` | 品牌定制（CCPG logo + 聊天 hero 标题） |

安装 / 打包 / 数据位置见 [dsh-plugins/README.md](dsh-plugins/README.md)。

## HTTP API（`/wf1/api/*`，挂在 dsh webServer）

| 分组 | 端点 |
|---|---|
| 图 | `GET/PUT /graph`、`POST /graph/reset`、`POST /graph/lint` |
| 工作流库 | `GET/POST /workflows`、`GET/PATCH/DELETE /workflows/detail`、`POST /workflows/transfer` |
| 运行 | `POST /run`、`POST /run/cancel`、`GET /runs`、`GET /runs/detail`、`GET /runs/export`、`POST /runs/replay`、`GET /run-results`、`GET /run-artifact` |
| 节点 | `POST /node/test`（试运行）、`GET /node-detail` |
| 产物 | `GET /artifact`（节点工作区文件，支持 preview/Range）、`GET/POST /attachments` |
| 触发 | `GET/POST/DELETE /hooks`（webhook，token 鉴权）、`GET/POST/DELETE /schedule`（cron） |
| 变量/模板 | `GET /variables/describe`、`GET/POST /global-variables`、`POST /template/render`、`POST /template/validate` |
| 配置 | `GET /tools`、`GET /skills`、`GET /llm-config`、`GET/POST /runtime-config`、`GET/POST/DELETE /feishu-credentials`、`GET/POST /lark-auth` |
| AI 助手 | `POST /assistant/bind` / `unbind`、`GET /assistant/canvas-state` |
| 实时 | `GET /events`（SSE）、`GET /state` |

## 环境变量

本仓库没有自己的配置文件，模型/渠道完全跟随 dsh profile 的配置（`apiKeyEnv` 声明 key 变量名），技能目录走 dsh 原生 `~/.dsh/skills` / `~/.agents/skills` 发现根。插件路径没有自创的环境变量。


## 架构

```text
web/                    前端（Vite + React 18 + @xyflow/react + CodeMirror）
  src/App.jsx           画布 + 工具栏 + SSE 订阅
  src/NodePanel.jsx     节点属性面板（脚本参数/Schema/模板编辑器）
  src/registry.jsx      节点注册表（icon/色/preset/summary/badges）
  src/result-adapter.js 运行结果适配（拓扑时间线/最终结果/产物分组）
dsh-plugins/
  dsh-ccpg-orchestrator/  引擎：NodeKind 注册表（execute/lint/edgeTaken/wantsSink）
                          + agent 进程内驱动 + QuickJS 脚本运行器 + HTTP/SSE
  shared/chat-pane.js     聊天记录栏源片段（构建期内联进各插件 client bundle）
```

双端节点注册表：引擎 NodeKind（调度/超时/重试）+ 前端 registry（图标/表单/徽标），新节点两处注册即得全部能力。agent 节点 = `ctx.agents.create` 进程内真实 dsh agent（followup → whenIdle → session events 聚合，同官方 headless 驱动）。

## 已知 dsh 插件开发事实（踩坑记录）

- `defineTool` 必须带 `output: { schema, render }`（文本工具 schema `{type:'string'}`）
- `ctx.webServer.register` 路由形状 `{kind:'exact'|'prefix', path, handler}`，重复 path 抛错
- 给 `ctx` 挂自定义属性需 `provide` 声明；插件包里 `@deepseek-ai/*` 依赖需 file: 软链（`bootstrap-deps.sh`）
- dsh 浏览器端 module-loader 禁跨插件值导入——共享 UI 抽源片段构建期内联（见 `shared/chat-pane.js`）
- dsh 官方 UI 远程 403 = PRIVILEGED_METHODS 钉死 loopback（安全设计）；插件自有路由不受影响
- dsh 进程内 fetch 127.0.0.1 自请求 404，需换 LAN IP；官方 UI 首载慢，E2E 等待要放宽

## 测试

```sh
cd dsh-plugins/dsh-ccpg-orchestrator && for t in test/*.test.mjs; do node "$t"; done  # 10 套
node dsh-plugins/shared/chat-pane.test.mjs                                             # 7/7
node dsh-plugins/dsh-ccpg-document-preview/test/index.test.mjs                        # 4/4
cd web && npm test                                                                    # 9 套
```

## 已知限制

- 飞书写回为追加段落块，不保留富文本格式
- 存储 = 每实体一 JSON 文件（多人编辑需求出现再迁 SQLite）
