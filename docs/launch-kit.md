# Workflow One 发布素材

以下内容可按渠道删减，但功能数字、安装命令和链接应保持一致。

## 中文发布帖

### 用 dsh 搭一个可恢复的多智能体可视化工作流

Workflow One 是运行在 DeepSeek Harness（dsh）里的可视化工作流编排器。它把输入、智能体、QuickJS 脚本、条件分支、HTTP 请求和输出节点连成 DAG，并在同一界面展示实时执行状态、节点输入输出、产物和错误。

这次发布重点解决三个实际问题：

- 多个智能体可以按 DAG 并行执行，而不是把所有任务塞进一段提示词；
- 运行中断后可以恢复，失败节点支持重试、继续和回放；
- 工作流与运行历史存放在当前工作区的 SQLite 数据库，项目之间互不混用。

安装：

```sh
dsh plugin --profile web add dsh-ccpg-one
dsh web
```

仓库：https://github.com/chumingjun/harness-one

欢迎分享实际工作流、安装问题和改进建议。仓库内已经提供报修工单整理、紧急度分流和多方并行评审三个可导入模板。

## English Launch Post

### Workflow One: visual, recoverable multi-agent DAGs for DeepSeek Harness

Workflow One is a visual workflow orchestrator that runs inside DeepSeek Harness (dsh). Connect input, agent, QuickJS script, condition, HTTP, output, and note nodes into a DAG; then inspect live status, real node inputs and outputs, artifacts, and failures from the same interface.

It supports parallel scheduling, retries, cancellation, replay, restart recovery, webhook and cron triggers, and optional Feishu writeback. Workflows and run history are stored in a workspace-local SQLite database.

```sh
dsh plugin --profile web add dsh-ccpg-one
dsh web
```

Repository: https://github.com/chumingjun/harness-one

Three importable examples are included for ticket normalization, urgency routing, and parallel review.

## Short Versions

**中文：** Workflow One 把 dsh 智能体、脚本、条件和 HTTP 节点连成可视化 DAG，支持并行执行、实时状态、失败恢复和工作区 SQLite 存储。安装：`dsh plugin --profile web add dsh-ccpg-one`。https://github.com/chumingjun/harness-one

**English:** Workflow One adds visual, recoverable multi-agent DAGs to DeepSeek Harness: parallel execution, live node details, replay, and workspace-local SQLite storage. Install with `dsh plugin --profile web add dsh-ccpg-one`. https://github.com/chumingjun/harness-one

## Suggested Media Order

1. `images/workflow-one-demo.gif`
2. `images/workflow01.png`
3. `images/workflow.png`
