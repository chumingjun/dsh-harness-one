---
name: workflow-one
description: "用 workflow_* 工具操作本工作区的节点式工作流：查列表/看详情/发起运行并跟踪进度/修改图/管理（新建、复制、改名、删除）。适合「帮我跑一下某工作流」「有哪些工作流」「现在在跑什么」「把某工作流的某节点改一下」这类诉求。"
---

<!-- managed-by: dsh-ccpg-orchestrator v1 -->

# Workflow One 工作流对话指南

本环境装有 Workflow One 编排工具族。用户口述需求，你按下面的映射调工具干活，
不要让用户去翻文档或点界面。

## 场景 → 工具

| 用户想要 | 工具 |
|---|---|
| 有哪些工作流 / 各自在跑几个 | `workflow_list` |
| 看某个工作流长什么样（节点/变量/输入） | `workflow_get`（默认概要省 token；`summary:false` 拿完整图） |
| 跑一个工作流 | `workflow_run`（id 或 name 二选一） |
| 现在在跑什么 / 跑得怎么样 | `workflow_runs`（`onlyLive:true` 只看运行中） |
| 某次运行的节点状态与输出 | `workflow_run_status`（runId 从 run/runs 获得） |
| 取消运行 | `workflow_run_cancel`（runId 单个 / workflowId 整个 / all 全部） |
| 改已保存工作流的图 | `workflow_patch`（批量 ops 原子生效，语义同 canvas_graph_patch） |
| 新建 / 复制工作流 | `workflow_create`（name 必填，可选 graph 或 copyFrom） |
| 删除工作流 | `workflow_delete`（必须 confirm:true；有关联运行/定时/webhook 会拒绝并列出） |
| 让用户屏幕切到某工作流 | `workflow_open`（仅绑定画布的会话） |

## 运行约定

1. **异步**：`workflow_run` 只返回 runId，用 `workflow_run_status` / `workflow_runs` 轮询到终态再汇报。
2. **结构化输入**：工作流声明了 inputSchema 时，先 `workflow_get` 看清字段，再构造 `runInputs`；
   纯文本触发的用 `triggerInput`。
3. **工作区**：工具按当前会话绑定的工作目录定工作区。若返回「无法定位工作区」，
   请用户在会话里绑定工作目录后重试；不同目录看到的工作流互不相通。

## 画布会话

绑定画布的会话（画布「工作流」标签页发起的对话）额外可用 `canvas_*` 家族
（`canvas_get_graph` / `canvas_graph_summary` / `canvas_graph_patch` / `canvas_lint_graph` /
`canvas_run_workflow` / `canvas_run_status`），作用于当前画布/草稿；
普通聊天会话没有它们，改图一律走 `workflow_patch`。改完图 `canvas_lint_graph`
或 patch 返回的 lint 有 error 必须修掉再回复用户。

## 典型话术

- 「帮我跑一下报修工单工作流」→ `workflow_list` 对名字 → `workflow_get` 看输入 →
  `workflow_run` → 轮询 → 汇总节点产出
- 「现在有什么在跑？」→ `workflow_runs`（onlyLive）→ 有异常的逐个 `workflow_run_status`
- 「给工单分流工作流加一个紧急度判断节点」→ `workflow_get` 拿图 →
  `workflow_patch`（addNode + connect 一批 ops）→ 看 lint 回执
- 「删掉那个测试工作流」→ 先确认 → `workflow_delete`（confirm:true）

## 回复风格

简洁说明做了什么（启动了哪个工作流的 run、改了哪些节点/连线），不复述 JSON；
运行失败的节点给出错误摘要和下一步建议（重跑 / 改图 / 取消）。
