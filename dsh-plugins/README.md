# Workflow One — dsh 插件包（本地分发）

7 个默认 Cordis 插件把物业智能体编排（拖拽画布 + 节点级真实 agent）装进任何 DeepSeek Harness (dsh)；brand 保留为独立可选插件：

| 包 | 安装方式 | 职责 |
|---|---|---|
| `dsh-ccpg-tools` | 默认 | feishu_doc_read / feishu_doc_write 注册 `ctx.tools` |
| `dsh-ccpg-orchestrator` | 默认 | DAG 编排 + 节点级 `ctx.agents` 进程内 agent + QuickJS 脚本节点 + `/wf1/api/*` HTTP/SSE |
| `dsh-ccpg-web` | 默认 | 画布静态托管 `/wf1/` |
| `dsh-ccpg-canvasui` | 默认 | 官方 dsh Web UI 输入框工作流按钮 + better-sidebar「工作流」画布（iframe 载 /wf1/，软依赖） |
| `dsh-ccpg-document-preview` | 默认 | PDF/DOCX/XLS(X)/PPTX 本地全屏预览（pdfjs/docx-preview/sheetjs/@file-viewer/pptx，inline workers、无第三方上传）；旧 DOC/PPT 走下载 |
| `dsh-ccpg-larkauth` | 默认 | 飞书账号扫码登录（lark-cli Device Flow）；启动自举安装 lark-cli、user token 后台续约、feishu-cli 技能种子 |
| `dsh-ccpg-llm-guard` | 默认 | 拦截模型返回的空 id/name/arguments 工具调用，自动重试且不污染会话 |
| `dsh-ccpg-brand` | 独立可选 | 品牌定制（CCPG logo + 聊天 hero 标题）；默认安装与聚合包均不包含 |

## 安装与使用

普通 dsh 有 release/源码两种路径，前提是 **Node ≥ 24.15**、`npm i -g @deepseek-ai/dsh`。Harness Desktop 自带运行时，走下面的原生插件命令。

### Harness Desktop

从 Desktop 托盘打开 **Open DSH Terminal**；该终端已绑定当前 profile：

```sh
dsh plugin add dsh-ccpg-one@0.3.0
```

安装后重启 Desktop，让新 bundle 进入 Loader 组合。compatibility 与 advanced 模式都继续使用普通 DSH Web Client；画布、同源 `/wf1/api/*`、侧栏和预览无需 Desktop 专用注册。飞书账号页首次点击「自动安装」时，插件通过公开 `desktopPnpm` service 把固定版本 lark-cli 安装到当前 profile，并在 profile 切换或退出时取消仍在运行的操作。

Desktop 不要运行 `setup.sh`：它用于普通 dsh，会创建/修改 profile、依赖系统全局 dsh/npm 并写固定 Web 端口；Desktop 自己管理这些内容，默认随机 loopback 端口应保留。

安装细节、环境差异表、常见问题（扫码无反应 / 找不到 better-sidebar / 页面空白）与开发兼容契约，见 **[DESKTOP.md](DESKTOP.md)**。

### A. 普通用户 · release 包（推荐，无需本仓库源码）

```sh
# 1. 下载 release 包（GitHub Releases 页拿最新 tag 的 asset）
curl -LO https://github.com/chumingjun/harness-one/releases/download/<tag>/dsh-ccpg-plugins-<tag>.tar.gz
tar -xzf dsh-ccpg-plugins-<tag>.tar.gz   # 解出 dsh-plugins/ 目录（自带全部构建产物 + vendor 件）

# 2. 一键安装（聚合模式：一个包装齐 7 插件 + better-sidebar，并建好独立 profile）
cd dsh-plugins
sh setup.sh --one wf1 4021              # profile 名/端口可自定义

# 3. 启动
sh start.sh wf1
```

浏览器打开 `http://127.0.0.1:4021/` 即用：
- 右下/设置进入**「模型」页**选模型、保存 key（dsh 官方配置面，存于 dsh 用户级 credentials）
- 点聊天输入框左侧**工作流图标** → 右侧栏展开画布；拖节点或直接在聊天里说"帮我建一个××工作流"
- 建图/运行过程在**消息流以卡片呈现**（操作摘要、完成度 x/y、点击卡片跳画布）
- 独立全屏画布：新标签页开 `http://127.0.0.1:4021/wf1/`

### 飞书消息通知节点

「消息通知」是运行级观察器，可接在线路中作为透传节点，也可不连线独立放置。当前内置飞书 provider，调度层使用渠道无关事件模型，后续接入钉钉或企业微信无需修改工作流运行逻辑。

配置步骤：

1. 在画布「设置」添加飞书自建应用 App ID / App Secret，并在飞书开发者后台开通机器人发消息权限。
2. 添加消息通知节点，选择飞书渠道及凭据。
3. 推送群聊时选择「群聊」并填写 `oc_` 开头的 `chat_id`，同时确保机器人已在群内。
4. 推送私聊时选择「私聊」并填写 `ou_` 开头的用户 `open_id`；应用可用范围需包含该用户，且机器人与用户需具备可发消息关系。
5. 选择「仅运行结束」或「每个节点完成」。后者会发送业务节点成功/失败进度，并在整次运行结束时再发送结果卡。

结束卡优先摘要输出节点结果；无输出节点时回退到最后一个成功业务节点。卡片还包含进度、节点状态统计、耗时、起止时间、失败详情或取消原因。通知节点会对摘要做长度限制和常见密钥脱敏；发送失败只写入该节点的 `notification.sent/failed/lastError`，不改变业务运行状态。

适合定时巡检群播报、长流程进度同步、异常值班告警，以及向流程负责人私聊发送结果。飞书扫码登录由 `dsh-ccpg-larkauth` / lark-cli 管理用户身份；消息通知节点使用的是画布中保存的自建应用凭据，两者不要混用。

release 包特性：**拿到即装**（画布/依赖/聚合壳全带）；better-sidebar 的钉版本 tgz 在 `vendor/`（断网/上游下架也能装）；装完的 `dsh-plugins/` 目录保留着，升级 = 下载新包重复上述步骤。

### B. 开发者 · 源码（本仓库）

```sh
git clone https://github.com/chumingjun/harness-one.git
cd harness-one/dsh-plugins

npm test                                # （可选）先跑全量单测
sh build-web.sh                         # 构建画布——产物不入库，源码安装必跑
sh setup.sh --one dev 4021              # 安装（或逐插件：sh setup.sh dev 4021）
sh start.sh dev
```

开发循环：
- 改画布前端（`web/`）→ `sh build-web.sh` → 刷新页面
- 改 canvasui 官方 UI 侧（`dsh-ccpg-canvasui/src/client.js`）→ `sh build-canvasui.sh` → **彻底重启 dsh**（HMR 缓存模块，`pkill dsh` 再起）
- 改引擎（`dsh-ccpg-orchestrator/lib/`）→ 对应面测试（`cd dsh-ccpg-orchestrator && for t in test/*.test.mjs; do node "$t"; done`）→ 重启
- 发版：`npm run publish:dry-run` 验证 npm 包；`sh dsh-plugins/publish-npm.sh` 按子包→聚合包顺序发布；Git tag 仍由 release.yml 生成 tarball + boot-smoke asset

### 可选件开关（`--one` 模式）

启动前 export（源码/`setup.sh --one` 渠道可写进工作区 `.env`；npm 渠道的 sidebar 开关在**安装时**生效，见下表注）：

| 开关 | 效果 | 生效位置 |
|---|---|---|
| `CCPG_NO_LARK=1` | 不加载 larkauth（飞书扫码登录） | 运行时（bundle patch） |
| `CCPG_NO_PREVIEW=1` | 不加载 document-preview（预览退化为下载） | 运行时（bundle patch） |
| `CCPG_NO_GUARD=1` | 不加载 llm-guard（不建议关） | 运行时（bundle patch） |
| `CCPG_NO_SIDEBAR=1` | 不装 better-sidebar（官方 UI 内工作流侧栏宿主不可用，独立 `/wf1/` 入口不受影响） | **安装时**（npm 渠道：`npx dsh-ccpg-one` 检测到即 `dsh plugin remove dsh-better-sidebar`；源码渠道：setup.sh 未装它即无） |
| `CCPG_ONLY_CORE=1` | 一键只留核心：tools/orchestrator/web/canvasui（+ 移除 sidebar） | 运行时 + 安装时 |

> better-sidebar 的挂载由它自己的 `dsh.bundle.patch` 提供（聚合层不再 insert——双 insert 会 duplicate route）。因此关闭 sidebar 无法在运行时做，npm 渠道由安装器移除依赖实现。

> `dsh-ccpg-brand` 不属于聚合包，需要时必须单独安装（`dsh plugin --profile <name> add <repo>/dsh-plugins/dsh-ccpg-brand`）。聚合模式不要再单独 add 其余 7 个子插件或手写 insert 行——双层挂载 = duplicate prefix route。`dsh plugin --profile <name> remove dsh-ccpg-one` 一次卸掉聚合包包含的默认插件。

> 模型完全交给 dsh 自带配置：agent 走 dsh 默认模型栈（`deepseek-official`），key 与选型在官方 UI「模型」页配置；setup.sh 的 patch 只写端口覆盖，不写任何 provider。要加自定义 provider，按 dsh 原生方式改 profile `cordis.patch.yml` 或 `~/.dsh/settings.yaml`。

> 远程访问（局域网/Tailscale）：把 profile `cordis.patch.yml` 里 webserver 的 `host` 改为 `0.0.0.0`。dsh agent 有 bash 能力，仅在可信网络开放。

画布：`http://127.0.0.1:4021/wf1/`

## setup.sh 做了什么

1. 校验 7 个默认插件的分发目录完整（package name 逐一核对 + `dsh.bundle.patch` 声明在场）+ 画布产物存在性（web-dist 缺失即提示先跑 build-web.sh）
2. 装 orchestrator 真依赖（ajv/cron-parser/QuickJS WASM）并跑 QuickJS smoke
3. canvasui bundle 校验（`build-canvasui.sh --check`，不一致则重建——`lib/client.js` 由 `src/client.js` 生成，不入库）
4. 装 lark-cli（飞书官方 CLI，`~/.local/npm-global`）并固定默认身份 user
5. 建 `~/.dsh/profiles/<name>`（dsh-base bundle）
6. `dsh plugin add` 7 个默认插件——**各插件自带 `dsh.bundle.patch`（包内 `cordis.patch.yml`），add 一步完成安装+进 bundles 层+挂载**（与 dsh-better-sidebar 的 npm 分发同一机制；失败即中止，不留半成品 profile）
7. 依赖引导：dsh SDK 是 dsh 包内层 bundled deps，registry 版本滞后且插件解析路径够不到——`bootstrap-deps.sh` 软链进插件源码目录（npm 安装渠道则无需此步：插件实体落在 profile 内，dsh 启动时的 `~/.dsh/profiles/node_modules` 扁平兜底自动接通运行实例的 SDK）
8. 写 `cordis.patch.yml`——**只写 webserver 端口覆盖**（模型 provider 走 dsh 自带体系，不在此写）
9. 装 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（npm 包，自带 bundle patch 一步挂载）：官方 UI 右侧工作台侧边栏——canvasui 往它注册「工作流」tab。版本由 `dsh-ccpg-one` 精确依赖统一；release 包携带同版本 vendor tgz

> 双挂载警告：插件挂载行已由各包 `dsh.bundle.patch` 提供，profile 的 `cordis.patch.yml` 里**不要再手写**同名 `- insert` 行——两层都生效会重复注册路由，boot 时 duplicate prefix route 报错。

### npm 直装

聚合包和 7 个默认插件均为带 `dsh.bundle.patch` 的自描述包。**pnpm 11 环境推荐**（见下）：

```sh
npx dsh-ccpg-one myprofile        # 预写 pnpm 11 放行（node-pty/koffi 构建许可）再一步装齐
```

也可直接用官方命令：

```sh
dsh plugin --profile myprofile add dsh-ccpg-one@0.3.0
```

> **pnpm 11 注意（issue #24）**：`dsh plugin add` 是 profile 目录里裸跑 pnpm，聚合依赖链里的 `node-pty`（dsh-better-sidebar 传递依赖，原生模块）会被 strict-dep-builds 拦下：安装非零退出、且 pnpm 往 profile 的 `pnpm-workspace.yaml` 写非法占位符 `node-pty: set this to true or false`，把 `pnpm approve-builds` 与重跑 install 一起堵死——**重试无效**。0.2.2 起用 `npx dsh-ccpg-one` 安装即可（它先把放行写对再装，幂等，可反复重跑）；已中招的 profile 也能用它自愈。

需要 CCPG 品牌外观时，再显式安装独立插件：

```sh
dsh plugin --profile myprofile add dsh-ccpg-brand
```

模型：dsh 默认模型栈（`deepseek-official`）开箱即用，key 在官方 UI「模型」页保存；自定义 provider 走 dsh 原生配置（profile `cordis.patch.yml` 的 `llm-pi-ai.providers`，key 由 `apiKeyEnv` 声明走环境变量）。插件自身不存任何 key。

## 数据位置

- 技能目录：dsh 原生 `~/.dsh/skills` / `~/.agents/skills`（`ctx.skills` 发现；feishu-cli 技能由 larkauth 启动时自动种子到 `~/.dsh/skills`）
- Workflow One 数据：当前 dsh 会话工作目录下的 `.workflow-one/`；工作流与运行记录存于 `workflow-one.sqlite`，state/attachments/runtime 继续使用文件系统（整体 gitignore）
- 节点执行：agent 以真实工作区根为 cwd，可读取项目文件；交付物写入 `.workflow-one/runtime/<workflow>/<run>/nodes/<node>/workspace/`，成果快照只扫描该节点目录
- 旧版 `~/.dsh/plugin-data/dsh-ccpg-orchestrator` 与插件包 `data/`：首次进入工作区时只导入一次，之后不再写入
- agent 会话：`~/.dsh/sessions/`（dsh 持久化，zstd JSONL）
- 飞书 token：由 lark-cli 自管（`~/.larkcli/`），插件零落盘

## 打包发布

`pack.sh <tag>`：7 个默认插件 + 独立可选 brand 清单校验 → 画布双构建 → orchestrator 依赖 → canvasui bundle 重建并 `--check` → rsync 组装（清运行时数据）→ `dist-release/dsh-ccpg-plugins-<tag>.tar.gz`。通用发布归档仍携带 brand 源包供显式安装，但 `setup.sh` 和 `dsh-ccpg-one` 都不会自动安装它。CI（release.yml）同源执行并作为 release asset 上传。

`sh publish-npm.sh --dry-run` 会构建并验证 8 个 npm 包：7 个默认插件**独立发布为公共包**（loader 与 client-modules 都从 profile 根按包名解析 entry，嵌套 bundle 布局两处都解析不到），`dsh-ccpg-one` 作为聚合壳以普通依赖引用它们——用户一条 `dsh plugin add dsh-ccpg-one` 装齐全部。brand 不单独发布。安装冒烟会校验「无 @deepseek-ai SDK 泄漏」（peer 自动安装会遮蔽 dsh 全局版本导致官方 UI 400）。去掉 `--dry-run` 才上传官方 npm registry；tag 必须与聚合包版本一致。GitHub `release.yml` 先上传 release 资产，再使用仓库 Actions Secret `NPM_TOKEN` 按子包→聚合包顺序发布，失败后可安全重跑（已存在版本会自动跳过）。

## 已知边界

- SDK 软链指向本机 dsh 安装——换机器重跑 `setup.sh` 自动重链
- npm 首次发布需要仓库所有者配置具备 `dsh-ccpg-one` 发布权限的 granular token 为 Actions Secret `NPM_TOKEN`；代码与包内容不保存 token
