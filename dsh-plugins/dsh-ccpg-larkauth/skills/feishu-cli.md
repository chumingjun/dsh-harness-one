---
name: feishu-cli
description: "用 lark-cli 命令行操作飞书：读/写云文档、发消息、多维表格、日历、任务、审批。适合需要落飞书、查飞书数据、或精细操作（搜索/评论/上传）的场景。输出为 JSON，判 ok 字段。"
---

<!-- managed-by: dsh-ccpg-larkauth v2 -->

# lark-cli 飞书 CLI

本机已安装 `lark-cli`（飞书官方 CLI）并完成应用配置。
命令在 PATH 里：`~/.local/npm-global/bin/lark-cli`（若找不到则用全路径）。

## 何时用 lark-cli vs 内置工具

- `feishu_doc_read` / `feishu_doc_write` 工具：简单读写单个文档时优先用（更快）
- `lark-cli`：需要搜索文档、发消息、多维表格、日历、任务、审批、批量操作时用

## 常用命令（bash 执行，注意 JSON 引号转义）

### 文档
```bash
lark-cli docs +search --query "关键词" --format json   # 搜索文档/wiki
lark-cli docs +fetch --url "<文档链接>" --format json    # 读文档内容（支持 md 输出）
lark-cli docs +create --title "标题" --doc-format markdown --content "# 内容" --format json
```

### 消息
```bash
lark-cli im +messages-send --chat-id "oc_xxx" --text "你好" --format json
lark-cli im +messages-send --user-id "ou_xxx" --markdown "**报告**见附件" --format json
```

### 多维表格 / 表格
```bash
lark-cli base records list --app-token "<base token>" --table-id "tblxxx" --format json
lark-cli base records create --app-token "<token>" --table-id "tblxxx" --fields '{"字段名":"值"}' --format json
```

### 日历 / 任务 / 审批
```bash
lark-cli calendar +agenda --format json                 # 今日日程
lark-cli tasks list --format json                       # 任务列表
lark-cli approvals list --format json                   # 审批任务
```

## 重要约定

1. **输出契约**：`--format json`（默认）。成功 `{"ok": true, "data": ...}` 在 stdout、退出码 0；
   失败 `{"ok": false, "error": {...}}` 在 stderr、退出码非 0。
   **判断成功看 `ok == true` 或退出码，绝不要看 `code == 0`**（成功信封没有 code 字段）。
2. **身份**：默认身份已在 CLI 级配置为 `user`（`config default-as user`），执行时仍建议显式加 `--as user`。
   仅当 user 身份报错或 token 失效时降级 `--as bot`（能力有限：公开文档、群消息），并在结果注明"需要用户重新扫码授权"。
   查身份：`lark-cli auth status --json`（看 `defaultAs` 与 `identities.user.tokenStatus`）。
3. **授权续约**：user token 由宿主后台自动续约（无需干预）；若 `tokenStatus` 变为 `needs_refresh`
   且自动续约失败（refresh 窗口过期），提示用户到 dsh 设置「飞书账号」重新扫码。
4. **写操作预览**：有副作用的命令先 `--dry-run` 确认参数，再实际执行。
5. **探索**：不知道命令时 `lark-cli <domain> --help`（domain: docs/im/base/sheets/calendar/tasks/mail/contact/drive/approvals）；
   看参数结构 `lark-cli schema <api.method>`；通用 API 直调 `lark-cli api GET /open-apis/<path>`。
6. **分页**：加 `--page-all` 自动翻页。
7. 交付要求：把关键结果（文档链接、消息发送确认、表格写入条数）写进工作区产物文件（如 feishu-result.md）。
