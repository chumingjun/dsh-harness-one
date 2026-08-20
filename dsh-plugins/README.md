# Workflow One — dsh 插件包（本地分发）

三个 Cordis 插件，把物业智能体编排（拖拽画布 + 节点级真实 agent）装进任何 DeepSeek Harness (dsh)：

| 包 | 职责 |
|---|---|
| `dsh-ccpg-tools` | feishu_doc_read / feishu_doc_write / load_skill 注册 `ctx.tools` |
| `dsh-ccpg-orchestrator` | DAG 编排 + 节点级 `ctx.agents` 进程内 agent + `/wf1/api/*` HTTP/SSE |
| `dsh-ccpg-web` | 画布静态托管 `/wf1/` |

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

1. 建 `~/.dsh/profiles/<name>`（dsh-base bundle）
2. `dsh plugin add` 本地三插件
3. 依赖引导：dsh SDK 是 dsh 包内层 bundled deps，registry 版本滞后且插件解析路径够不到——`bootstrap-deps.sh` 软链进插件源码目录
4. 写 `cordis.patch.yml`（GLM provider 示例 + 三插件行 + webserver 端口）

换模型：改 patch 里 `llm-pi-ai.providers`（openai-completions / anthropic-messages 均可），key 用对应环境变量。

## 数据位置

- 技能目录：`~/.dsh/workflow-one-skills/*.md`（`WF1_SKILLS_DIR` 可覆盖）
- 附件：`<orchestrator 包>/data/attachments/`（运行时复制进节点工作区）
- 节点工作区/产物：`<orchestrator 包>/data/workspaces/<节点名>/`
- agent 会话：`~/.dsh/sessions/`（dsh 持久化，zstd JSONL）

## 已知边界

- SDK 软链指向本机 dsh 安装——换机器重跑 `setup.sh` 自动重链
- npm 发包待 registry 的 `@deepseek-ai/*` 版本同步
