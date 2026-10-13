# DSH 原生扩展与飞书 CLI 接入证据

日期：2026-10-09。仅做本地官方包声明/说明与集成仓库代码调查，未加载新插件、执行登录、读取云端材料或发布。查到的 `dsh-agent`、`dsh-tools`、`dsh-agent-preset` 均为本机 npm 安装的 `0.2.0-rc.2`；不代表 Desktop 当前实际部署版本。

## 原生能力已经存在

| 需求 | 查到的原生机制 | 接入边界 |
| --- | --- | --- |
| 插件装配 | Cordis Host/Client 插件、bundle patch | 在方案作用域注册并负责卸载清理，不修改 Runtime |
| 限制工具 | `ctx.tools.restrict()` | 过滤全局工具；作用域工具和保留传输有例外，不能当作全文件系统隔离 |
| 调用前拒绝 | `ctx.tools.guard()` | 同步且只能拒绝，其他监听器不能再把拒绝改为允许 |
| 异步校验/用户审批 | `tools/pre-execute` | waterfall；遵守 `exec.signal`；缺原生审批支持时 ask 会拒绝，不应自动放行 |
| 执行结果观察 | `tools/result` | 只观察冻结的最终结果；不能在事后事件里撤销已发生的业务副作用 |
| 生命周期与取消 | `agent/created`、`agent/disposed`、`agent/pre-step`、`cancel`、AbortSignal | 核对目标 scope 与时序；提交前仍检查 attempt、版本和 signal |
| 会话复用 | create/resume、followup、原生会话日志 | 不新建章节上下文，不以 whenIdle 判业务成功 |
| 成果界面 | React slot、Host 操作入口 | 官方说明推荐原生 slot；不默认沿用旧 canvasui 的 iframe |

来源为本机官方文件（调查证据路径，不写入交付包）：

- [工具类型与事件](/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts)：pre-execute 47 行、result 92 行、guard 定义 515 行、restrict/guard 注册 644/655 行。
- [Agent 生命周期和取消](/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts)：cancel 157 行、whenIdle 164 行、followup 192 行，以及 213 行之后的事件声明。
- [官方插件实践](/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md)：优先最弱够用的扩展点、按作用域注册、原生日志重建、事件观察、React slot 与主题。
- [用户操作与 Agent 工具](/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/user-actions.md)：同一 Host 方法、用户授权类操作不向 Agent 开放。

结论：撤回“DSH 是否有 hook/插件尚不确定”的笼统表述。插件机制足以作为本方案的接入基础；尚未验证的是目标 Desktop/profile 的同名接口、插件挂载范围、版本兼容、取消竞态以及通用工具的绕过路径。钩子提供拦截点，不会自动理解章节业务，也不是 OS 沙箱。应在真实宿主上检查 Service/Event/Slot，而不是因为未实测便另建运行系统。

## 飞书已有可复用基础

集成仓库 `dsh-ccpg-larkauth` 已包含 CLI 探测、当前 profile 安装、登录及用户信息查询；Desktop 的 CLI 可能不在 GUI PATH，不能只用 which 判断。优先复用该能力，不假定存在尚未注册的公共 service，也不复制凭据管理。

- [登录插件入口](../../dsh-ccpg-larkauth/lib/index.js)
- [CLI 执行与授权实现](../../dsh-ccpg-larkauth/lib/lark-auth.js)：Desktop/profile runtime 与本地执行路径。
- [Desktop 接入说明](../../DESKTOP.md)
- [现有技能](../../dsh-ccpg-larkauth/skills/feishu-cli.md)：53 行存在 user 失败降级 bot 的旧条款。
- [原 orchestrator](../../dsh-ccpg-orchestrator/lib/index.js)：1443 行也注入上述 bot 降级提示。

后两处与新方案“必须是当前用户身份”冲突，列为实施修复任务，本轮未修改已有插件。标准命令采用 `lark-cli`；新方案必须显式选择 user，不能依赖旧技能的自动降级。实际命令和输出信封依目标 CLI 的 help/schema 及已安装技能核验，不直接照抄可能过时的示例。

读取路径：用户指定飞书材料 -> 复用用户授权 -> 按文档/表格/附件类型调用 CLI -> 保存来源快照、范围、可获得版本和缺口 -> 现有解析/notes/章节链路。

发布路径：用户确认目标及固定成果版本 -> 同一 user 身份调用 CLI -> 记录回执 -> 回读核对；账号切换、权限缺失、结果不明、部分上传均明确处理。登录本身不授予所有资源权限；读取失败不改用 bot，发布超时不盲目再建文档。

## 尚需目标环境验证

安装组合与作用域、用户审批来源、取消传播和迟到提交、双窗口冲突、文件外部修改检测、视觉输入、原生 slot/成果引用、CLI 登录及实际资源权限。外部网页搜索本轮无可用结果，未据此宣称最新版本；本页依据是上述已读取本地文件。
