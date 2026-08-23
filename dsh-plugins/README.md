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

## 安装（3 步）

```sh
# 前提：node>=20、npm i -g @deepseek-ai/dsh
cd dsh-plugins

sh build-web.sh                                    # 1. 构建画布——产物不入库，源码安装必跑（分发包已带成品，可跳过）
sh setup.sh [profile名] [端口]                     # 2. 一条龙安装（默认 dsh-ccpg / 4021）
sh start.sh [profile名]                            # 3. 启动
```

### 聚合安装（一个包 + 可选件开关）

```sh
sh setup.sh --one [profile名] [端口]               # dsh plugin add 只装 dsh-ccpg-one 一个包
```

聚合壳 `dsh-ccpg-one` 的 bundle patch 一次性挂载 7 个默认插件 + better-sidebar；可选件按环境变量门控（启动前 export，可写进工作区 `.env`）：

| 开关 | 效果 |
|---|---|
| `CCPG_NO_LARK=1` | 不加载 larkauth（飞书扫码登录） |
| `CCPG_NO_PREVIEW=1` | 不加载 document-preview（预览退化为下载） |
| `CCPG_NO_SIDEBAR=1` | 不加载 better-sidebar（官方 UI 内工作流侧栏不可用，独立 `/wf1/` 入口仍可用） |
| `CCPG_NO_GUARD=1` | 不加载 llm-guard（不建议关） |
| `CCPG_ONLY_CORE=1` | 一键只留核心：tools/orchestrator/web/canvasui |

> `dsh-ccpg-brand` 不属于聚合包，需要时必须单独安装。聚合模式不要再单独 add 其余 7 个子插件或手写 insert 行——双层挂载 = duplicate prefix route。`dsh plugin --profile <name> remove dsh-ccpg-one` 一次卸掉聚合包包含的默认插件。

> 模型不归插件配置：agent 全部走 dsh 自己的模型配置（profile 的 `cordis.patch.yml`）。setup.sh 写的 GLM provider 示例声明了 `apiKeyEnv: GLM_API_KEY`，此时启动前 `export GLM_API_KEY=你的key` 即可；换 provider 后变量名以对应 `apiKeyEnv` 为准。

画布：`http://127.0.0.1:4021/wf1/`

## setup.sh 做了什么

1. 校验 7 个默认插件的分发目录完整（package name 逐一核对 + `dsh.bundle.patch` 声明在场）+ 画布产物存在性（web-dist 缺失即提示先跑 build-web.sh）
2. 装 orchestrator 真依赖（ajv/cron-parser/QuickJS WASM）并跑 QuickJS smoke
3. canvasui bundle 校验（`build-canvasui.sh --check`，不一致则重建——`lib/client.js` 由 `src/client.js` 生成，不入库）
4. 装 lark-cli（飞书官方 CLI，`~/.local/npm-global`）并固定默认身份 user
5. 建 `~/.dsh/profiles/<name>`（dsh-base bundle）
6. `dsh plugin add` 7 个默认插件——**各插件自带 `dsh.bundle.patch`（包内 `cordis.patch.yml`），add 一步完成安装+进 bundles 层+挂载**（与 dsh-better-sidebar 的 npm 分发同一机制；失败即中止，不留半成品 profile）
7. 依赖引导：dsh SDK 是 dsh 包内层 bundled deps，registry 版本滞后且插件解析路径够不到——`bootstrap-deps.sh` 软链进插件源码目录（npm 安装渠道则无需此步：插件实体落在 profile 内，dsh 启动时的 `~/.dsh/profiles/node_modules` 扁平兜底自动接通运行实例的 SDK）
8. 写 `cordis.patch.yml`——**只写用户配置**（GLM provider 示例 + webserver 端口），不再手写插件挂载行
9. 装 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（npm 包，自带 bundle patch 一步挂载）：官方 UI 右侧工作台侧边栏——canvasui 往它注册「工作流」tab（+ 菜单第一位），点击对话输入框旁按钮展开。软依赖：装不上时官方 UI 内无法打开工作流侧栏，独立 `/wf1/` 入口仍可用。**版本随 pack 当次 npm latest**：release 包内 `vendor/dsh-better-sidebar-<ver>.tgz` 优先（断网/下架也能装），源码安装无 vendor 件则从 npm 拉 latest

> 双挂载警告：插件挂载行已由各包 `dsh.bundle.patch` 提供，profile 的 `cordis.patch.yml` 里**不要再手写**同名 `- insert` 行——两层都生效会重复注册路由，boot 时 duplicate prefix route 报错。

### 发布到 npm 后的直装形态（预留）

7 个默认插件已是「自带 bundle patch」的自描述包。发布后（`npm publish` 各包）用户可绕过 tarball/setup 直接：

```sh
dsh plugin --profile myprofile add dsh-ccpg-tools dsh-ccpg-orchestrator dsh-ccpg-web dsh-ccpg-canvasui dsh-ccpg-document-preview dsh-ccpg-larkauth dsh-ccpg-llm-guard
# 再贴一段 provider+webserver 的 cordis.patch.yml（同 setup.sh 第 8 步的模板），npm 渠道连 bootstrap-deps 都不需要
```

需要 CCPG 品牌外观时，再显式安装独立插件：

```sh
dsh plugin --profile myprofile add dsh-ccpg-brand
```

换模型：改 patch 里 `llm-pi-ai.providers`（openai-completions / anthropic-messages 均可），key 环境变量名由 provider 的 `apiKeyEnv` 声明——示例为 `GLM_API_KEY`，换 provider 后以新的 `apiKeyEnv` 为准。插件自身不存任何 key。

## 数据位置

- 技能目录：dsh 原生 `~/.dsh/skills` / `~/.agents/skills`（`ctx.skills` 发现；feishu-cli 技能由 larkauth 启动时自动种子到 `~/.dsh/skills`）
- Workflow One 数据：当前 dsh 会话工作目录下的 `.workflow-one/`（state/workflows/attachments/runs/runtime，gitignore）
- 节点执行：agent 以真实工作区根为 cwd，可读取项目文件；交付物写入 `.workflow-one/runtime/<workflow>/<run>/nodes/<node>/workspace/`，成果快照只扫描该节点目录
- 旧版 `~/.dsh/plugin-data/dsh-ccpg-orchestrator` 与插件包 `data/`：首次进入工作区时只导入一次，之后不再写入
- agent 会话：`~/.dsh/sessions/`（dsh 持久化，zstd JSONL）
- 飞书 token：由 lark-cli 自管（`~/.larkcli/`），插件零落盘

## 打包发布

`pack.sh <tag>`：7 个默认插件 + 独立可选 brand 清单校验 → 画布双构建 → orchestrator 依赖 → canvasui bundle 重建并 `--check` → rsync 组装（清运行时数据）→ `dist-release/dsh-ccpg-plugins-<tag>.tar.gz`。通用发布归档仍携带 brand 源包供显式安装，但 `setup.sh` 和 `dsh-ccpg-one` 都不会自动安装它。CI（release.yml）同源执行并作为 release asset 上传。

## 已知边界

- SDK 软链指向本机 dsh 安装——换机器重跑 `setup.sh` 自动重链
- npm 发包待 registry 的 `@deepseek-ai/*` 版本同步
