# Workflow One — dsh 插件包（本地分发）

七个 Cordis 插件，把物业智能体编排（拖拽画布 + 节点级真实 agent）装进任何 DeepSeek Harness (dsh)：

| 包 | 职责 |
|---|---|
| `dsh-ccpg-tools` | feishu_doc_read / feishu_doc_write / load_skill 注册 `ctx.tools` |
| `dsh-ccpg-orchestrator` | DAG 编排 + 节点级 `ctx.agents` 进程内 agent + QuickJS 脚本节点 + `/wf1/api/*` HTTP/SSE |
| `dsh-ccpg-web` | 画布静态托管 `/wf1/` |
| `dsh-ccpg-canvasui` | 官方 dsh Web UI 的画布视图（conversation.view tab，iframe 载 /wf1/）+ better-sidebar「对话记录」tab（软依赖，`shared/chat-pane.js` 构建期内联） |
| `dsh-ccpg-document-preview` | PDF/DOCX/XLS(X)/PPTX 本地全屏预览（pdfjs/docx-preview/sheetjs/@file-viewer/pptx，inline workers、无第三方上传）；旧 DOC/PPT 走下载 |
| `dsh-ccpg-larkauth` | 飞书账号扫码登录（lark-cli Device Flow）；启动自举安装 lark-cli、user token 后台续约、feishu-cli 技能种子 |
| `dsh-ccpg-brand` | 品牌定制（CCPG logo + 聊天 hero 标题） |

## 安装（3 步）

```sh
# 前提：node>=20、npm i -g @deepseek-ai/dsh
cd mvp-canvas/dsh-plugins

sh build-web.sh                                    # 1. 构建画布
sh setup.sh [profile名] [端口]                     # 2. 一条龙安装（默认 dsh-ccpg / 4021）
GLM_API_KEY=xxx sh start.sh [profile名]            # 3. 启动
```

画布：`http://127.0.0.1:4021/wf1/`

## setup.sh 做了什么

1. 校验七插件分发目录完整（package name 逐一核对）
2. 装 orchestrator 真依赖（ajv/cron-parser/QuickJS WASM）并跑 QuickJS smoke
3. canvasui bundle 校验（`build-canvasui.sh --check`，不一致则重建——`lib/client.js` 是 `src/client.js` 内联 `shared/` 片段的构建产物）
4. 装 lark-cli（飞书官方 CLI，`~/.local/npm-global`）并固定默认身份 user
5. 建 `~/.dsh/profiles/<name>`（dsh-base bundle）
6. `dsh plugin add` 七插件（失败即中止，不再留半成品 profile）
7. 依赖引导：dsh SDK 是 dsh 包内层 bundled deps，registry 版本滞后且插件解析路径够不到——`bootstrap-deps.sh` 软链进插件源码目录
8. 写 `cordis.patch.yml`（GLM provider 示例 + 七插件行 + webserver 端口）
9. 装 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（npm 包，自带 bundle patch 一步挂载）：官方 UI 右侧工作台侧边栏——canvasui 往它注册「对话记录」tab（+ 菜单第一位，切工作流视图自动展开）。软依赖：装不上仅损失该 tab，画布不受影响；不打入分发包，装包机器从 npm 拉取

换模型：改 patch 里 `llm-pi-ai.providers`（openai-completions / anthropic-messages 均可），key 用对应环境变量。

## 数据位置

- 技能目录：`~/.dsh/workflow-one-skills/*.md`（`WF1_SKILLS_DIR` 可覆盖；feishu-cli 技能由 larkauth 启动时自动种子）
- 附件：`<orchestrator 包>/data/attachments/`（运行时复制进节点工作区）
- 节点工作区/产物：`<orchestrator 包>/data/workspaces/<节点名>/`
- 运行历史/快照产物：`<orchestrator 包>/data/runs/`、`data/run-artifacts/`（gitignore）
- agent 会话：`~/.dsh/sessions/`（dsh 持久化，zstd JSONL）
- 飞书 token：由 lark-cli 自管（`~/.larkcli/`），插件零落盘

## 打包发布

`pack.sh <tag>`：七插件清单校验 → 画布双构建 → orchestrator 依赖 → canvasui bundle 重建并 `--check` → rsync 组装（清运行时数据）→ `dist-release/dsh-ccpg-plugins-<tag>.tar.gz`。CI（release.yml）同源执行并作为 release asset 上传。

## 已知边界

- SDK 软链指向本机 dsh 安装——换机器重跑 `setup.sh` 自动重链
- npm 发包待 registry 的 `@deepseek-ai/*` 版本同步
