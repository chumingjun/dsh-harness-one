# AGENTS.md — 给 AI 编码代理的仓库指南

本仓库（harness-one）是 **dsh（DeepSeek Harness）插件开发工作区**：开发、构建、分发跑在 dsh 里的 Cordis 插件。当前主体是 Workflow One 物业编排套件（`dsh-plugins/dsh-ccpg-*` 七插件 + `web/` 画布），但仓库不限于它——未来任何新 dsh 插件都在这里开发，命名延续 `dsh-ccpg-*` 前缀（ccpg 系列）。

- 仓库通用规则（环境、dsh 插件事实、提交规范）见下方各节，**对所有插件适用**
- Workflow One 专属的架构铁律集中在「Workflow One」一节
- 产品功能文档：`README.md`（主）/ `dsh-plugins/README.md`（安装分发）

## 环境前提

- Node ≥ 20。系统自带 Node 版本不够时，用 `DSH_NODE` 环境变量指向任意 ≥ 20 的 node 可执行文件（setup/start/pack 脚本都认它）
- dsh 全局安装：`npm i -g @deepseek-ai/dsh`
- LLM key 一律经环境变量注入：变量名由 dsh profile 的 provider 配置（`cordis.patch.yml` 的 `apiKeyEnv`）声明，配什么 provider 就用什么变量，文档与代码里不要写死某个 key 名；插件与仓库**不存任何 key**
- 构建脚本为 POSIX sh：macOS / Linux 原生可用，Windows 走 WSL 或 Git Bash

## 提交规范

- Conventional Commits：`feat|fix|build|docs|ci(scope): 摘要`，中文正文说清 what/why，scope 用插件名或模块名（如 `feat(larkauth):`、`fix(web):`）
- 大改动拆多个逻辑提交（引擎 vs 前端 vs 构建 vs 文档分开）；同一文件混多主题时用 patch staging 拆 hunk
- 提交前跑对应面的最小测试；推送前确保 `git status` 干净

## dsh 插件开发事实（仓库级知识，违反即报错）

无论开发哪个插件都会碰到：

- `defineTool` 必须带 `output: { schema, render }`；文本工具 schema 为 `{type:'string'}`
- `ctx.webServer.register` 形状 `{kind:'exact'|'prefix', path, handler}`；重复 path 抛错
- 给 `ctx` 挂自定义属性必须先 `provide` 声明
- 插件里 `@deepseek-ai/*` 依赖不会从 dsh 主安装解析——`dsh-plugins/bootstrap-deps.sh` 软链解决，勿用 registry 版本
- 浏览器端 module-loader **禁跨插件值导入**（构建纯度门）；插件 client bundle 必须自包含。共享 UI 抽成 `dsh-plugins/shared/*.js` 源片段，经 `build-canvasui.sh` 的 `@include` 构建期内联进消费者
- dsh 进程内 `fetch 127.0.0.1` 自请求 404，用 LAN IP
- 官方 UI 特权页（settings/credentials 等）远程必 403（PRIVILEGED_METHODS 钉 loopback），属安全设计不是 bug；插件自有路由不受限
- dsh HMR 会缓存插件模块：改插件代码后必须彻底结束 dsh 进程再重启（macOS/Linux `pkill`，Windows/WSL 用任务管理器或 `taskkill`），半重启不生效
- 新插件上线清单：加进 `setup.sh` 与 `pack.sh` 的 `PLUGINS=` 清单（两处同步）、`setup.sh` 的 `cordis.patch.yml` 插件行；有前端产物则接入 `build-web.sh`；setup.sh 会校验 package name 与目录名一致

## Workflow One（当前主体）

七插件：tools / orchestrator（引擎+HTTP+SSE）/ web（静态托管）/ canvasui（官方 UI 视图）/ document-preview（文档预览）/ larkauth（飞书登录）/ brand。画布 `web/`（Vite + React 18 + @xyflow/react + CodeMirror）。

### 常用命令

```sh
sh dsh-plugins/build-web.sh                 # 画布双构建（/wf1/ base + 根 base），改前端后必跑
sh dsh-plugins/setup.sh [profile] [端口]    # 安装（默认 dsh-ccpg / 4021）
sh dsh-plugins/start.sh <profile>           # 启动
sh dsh-plugins/pack.sh <tag>                # 打包 release（CI 同源）

cd web && npm test                          # 前端 9 套
cd dsh-plugins/dsh-ccpg-orchestrator && for t in test/*.test.mjs; do node "$t"; done  # 引擎 10 套
node dsh-plugins/shared/chat-pane.test.mjs                       # 7 例
node dsh-plugins/dsh-ccpg-document-preview/test/index.test.mjs  # 4 例
```

### 架构铁律（Workflow One 专属）

1. **双端节点注册表**：新增节点类型必须两处注册——引擎 `orchestrator/lib/engine.js` 的 `registerKind({execute, lint, edgeTaken, wantsSink})` + 前端 `web/src/registry.jsx`（icon/色/preset/summary/badges）。AI 助手侧同步 `lib/assistant.js`（NODE_TYPES + persona 契约）与 `lib/variable-schema.js`（变量树）。两处注册即得调度/审批/超时/重试/UI 全部能力，不要另起旁路。
2. **canvasui bundle 是构建产物**：`lib/client.js` 由 `src/client.js` 内联 `shared/` 片段生成，直接改会被覆盖；改后重跑 `build-canvasui.sh`（`--check` 逐字比对防漂移）。
3. **4020 Express 回退能力冻结**：新功能只做插件路径（`/wf1/api/*`）；`server/` 仅修 bug。同语义端点双入口实现时以插件端为准。
4. **存储 = 每实体一 JSON 文件**（`data/workflows|runs|attachments|workspaces`）；运行时产物（runs/run-artifacts/workspaces/credentials）全部 gitignore，**绝不提交**。
5. **web-dist 是构建产物但入库**（release「拿到即装」约定）：改前端后必须 `build-web.sh` 再提交，否则分发包与源码漂移。

### 前端坑

- JSX 文本里裸 `{{变量}}` 会白屏——必须包字符串（`{'{{x}}'}`）
- React Flow 节点是独立堆叠上下文：节点内弹出菜单的 z-index 只在本节点生效，宿主节点需 `:has(.add-open)` 提层级
- CDP/headless 下 React Flow `n.selected` 不可靠，E2E 断言用 `.toolbar .btn` 精确匹配（图标已 SVG 化，textContent 不含类型字）
- 前端构建**必须**走 `build-web.sh`（双 base），不要直接 `npm run build`

### 测试与验证

- 单测全部是零依赖 node 断言脚本（`node:assert` + 自写 runner），直接 `node <file>` 运行；新插件照此约定写测试
- 改引擎跑 orchestrator 10 套；改前端跑 web 9 套；改 shared 跑 chat-pane 7 例；改预览跑 document-preview 4 例
- E2E 用 CDP（chrome-devtools）跑真实浏览器验证；dsh 官方 UI 首载慢，等待时间放宽（画布就绪 3.5s→6s），wait text 偶超时先多等几秒再判失败
