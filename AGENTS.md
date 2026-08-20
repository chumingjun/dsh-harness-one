# AGENTS.md — 给 AI 编码代理的项目指南

Workflow One（`mvp-canvas`）：物业智能体工作流编排，七个 dsh-ccpg-* Cordis 插件 + Vite/React 画布 + 旧 Express 兼容入口。产品与架构详见 `README.md` 与 `dsh-plugins/README.md`，本文件只写**动手改代码前必须知道的事**。

## 环境前提

- Node ≥ 20（macOS 系统 Node 不够时用 `DSH_NODE` 指向便携版，如 `/tmp/node-v22.20.0-darwin-arm64/bin/node`）
- dsh 全局安装：`npm i -g --prefix ~/.local/npm-global @deepseek-ai/dsh`
- LLM key 走环境变量（`GLM_API_KEY` 优先）；插件自身**不存任何模型 key**（架构定稿：模型/渠道恒用 dsh 数据源）

## 常用命令

```sh
# 构建（改了 web/ 或 document-preview 后必跑；产物进 dsh-ccpg-web/web-dist）
sh dsh-plugins/build-web.sh            # 双构建：/wf1/ base + 根 base（Express 用）

# 安装/启动（本地 profile）
sh dsh-plugins/setup.sh [profile] [端口]   # 默认 dsh-ccpg / 4021
sh dsh-plugins/start.sh <profile>

# 前端单测（9 套，纯 node 断言无框架）
cd web && npm test

# 引擎/插件单测（10 套）
cd dsh-plugins/dsh-ccpg-orchestrator && for t in test/*.test.mjs; do node "$t"; done

# 其余
node dsh-plugins/shared/chat-pane.test.mjs
node dsh-plugins/dsh-ccpg-document-preview/test/index.test.mjs

# 打包 release（CI 与本地同源）
sh dsh-plugins/pack.sh <tag>
```

## 提交规范

- Conventional Commits：`feat|fix|build|docs|ci(scope): 摘要`，中文正文说清 what/why
- 大改动拆多个逻辑提交（引擎 vs 前端 vs 构建 vs 文档分开）；同一文件混多主题时用 patch staging 拆 hunk
- 提交前跑对应面的最小测试；推送前确保 `git status` 干净

## 架构铁律

1. **双端节点注册表**：新增节点类型必须两处注册——引擎 `dsh-ccpg-orchestrator/lib/engine.js` 的 `registerKind({execute, lint, edgeTaken, wantsSink})` + 前端 `web/src/registry.jsx`（icon/色/preset/summary/badges）。AI 助手侧还要同步 `lib/assistant.js` 的 NODE_TYPES 与 persona 契约、`lib/variable-schema.js`（变量树）。两处注册即自动获得调度/审批/超时/重试/UI 全部能力，不要另起旁路。
2. **浏览器端禁跨插件导入**：dsh module-loader 的构建纯度门禁止跨插件值导入。共享 UI（如聊天记录栏）抽成 `dsh-plugins/shared/*.js` 源片段，经 `build-canvasui.sh` 的 `@include` 在构建期内联进消费者 bundle——**直接改 `dsh-ccpg-canvasui/lib/client.js` 会被覆盖**，改 `src/client.js` 或 shared 后必须重跑 `build-canvasui.sh`（`--check` 逐字比对防漂移）。
3. **4020 Express 回退能力冻结**：新功能只做插件路径（`/wf1/api/*`）；server/ 仅修 bug。同语义端点双入口实现时以插件端为准。
4. **存储 = 每实体一 JSON 文件**（`data/workflows|runs|attachments|workspaces`）；运行时产物（runs/run-artifacts/workspaces/credentials）全部 gitignore，**绝不提交**。
5. **web-dist 是构建产物但入库**（release「拿到即装」约定）：改前端后必须 `build-web.sh` 再提交，否则分发包与源码漂移。

## dsh 插件开发事实（违反即报错，别再踩）

- `defineTool` 必须带 `output: { schema, render }`；文本工具 schema 为 `{type:'string'}`
- `ctx.webServer.register` 形状 `{kind:'exact'|'prefix', path, handler}`；重复 path 抛错
- 给 `ctx` 挂自定义属性必须先 `provide` 声明
- 插件里 `@deepseek-ai/*` 依赖不会从 dsh 主安装解析——`bootstrap-deps.sh` 软链解决，勿用 registry 版本
- dsh 进程内 `fetch 127.0.0.1` 自请求 404，用 LAN IP
- 官方 UI 特权页（settings/credentials 等）远程必 403（PRIVILEGED_METHODS 钉 loopback），属安全设计不是 bug；插件自有路由不受限
- dsh HMR 会缓存插件模块：改插件代码后 `pkill` 全杀再重启，半重启不生效

## 前端坑

- JSX 文本里裸 `{{变量}}` 会白屏——必须包字符串（`{'{{x}}'}`）
- React Flow 节点是独立堆叠上下文：节点内弹出菜单的 z-index 只在本节点生效，宿主节点需 `:has(.add-open)` 提层级
- CDP/headless 下 React Flow `n.selected` 不可靠，E2E 断言用 `.toolbar .btn` 精确匹配（图标已 SVG 化，textContent 不含类型字）
- 前端构建**必须**走 `build-web.sh`（双 base），不要直接 `npm run build`

## 测试与验证

- 单测全部是零依赖 node 断言脚本（`node:assert` + 自写 runner），直接 `node <file>` 运行
- 改引擎跑 orchestrator 10 套；改前端跑 web 9 套；改 shared 跑 chat-pane 7 例；改预览跑 document-preview 4 例
- E2E 用 CDP（chrome-devtools）跑真实浏览器验证；dsh 官方 UI 首载慢，等待时间放宽（画布就绪 3.5s→6s），wait text 偶超时先多等几秒再判失败
