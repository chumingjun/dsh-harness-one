# Workflow One 示例模板

这些文件是标准 Workflow One v3 导出文件，不包含凭据、附件或运行数据。

| 文件 | 用途 | 节点 |
|---|---|---:|
| `repair-order.workflow-one.json` | 把自然语言报修信息整理为规范工单 | 3 |
| `urgency-routing.workflow-one.json` | 按关键词分流紧急与常规工单 | 5 |
| `parallel-review.workflow-one.json` | 两个智能体并行评审后汇总结论 | 5 |

使用方式：打开 Workflow One 的「工作流」列表，点击「导入」，选择其中一个 `.workflow-one.json` 文件。导入后可以直接修改输入、提示词、模型和工具。

模板使用当前 dsh profile 配置的默认模型，不包含任何 API Key 或飞书凭据。
