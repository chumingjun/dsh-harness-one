# agent 节点委派本地 runtime（codex / claude code / pi）设计

- 日期：2026-11-19
- 状态：已评审修订（评审方：Codex 架构评审子代理；方案 B 保留，发布门槛见 §10–12）
- 适用仓库：harness-one / Workflow One
- 选定方案：**B —— 直接驱动三个 CLI 的无头模式**

## 1. 意图与 why

Workflow One 的 agent 节点目前只能由 dsh 底座执行（`runAgentNode` 里 `ctx.get('agents').create(...)`）。用户希望把节点任务委派给本机已装好的 codex / claude code / pi，复用它们各自的订阅、原生工具与技能，而不是所有节点都走 dsh 的 provider/model。

为什么现在做：三个 CLI 本机都在（codex-cli 0.170.0、claude 2.1.327、pi 1.5.0），且都有可用的无头模式；dsh 侧的官方委派通道实测存在硬限制（见 §4），无法满足 agent 节点已有的能力面。

## 2. 目标 / 非目标 / 反目标

### 目标
1. agent 节点可按节点选择 runtime：`dsh`（默认，保持现状）/ `codex` / `claude` / `pi`。
2. 外部 runtime 接入现有轨迹、`agent-progress`、docTail、结构化输出、超时/取消/重试和产物收集。usage/turns 只报告 CLI 能观测的值，不冒充 dsh 模型调用次数；模型超时、修复与轮数能力差异见 §6–7。
3. 在支持的平台和经验证的 CLI 配置下，取消回收受跟踪的进程树，发布验收要求常规子孙零残留。`ps` 不能证明任意已脱离进程被收回；一旦发现清理不确定，不得判成功或启动重试（§7）。
4. 认证一律用本机 CLI 原生登录态；插件与仓库不存任何 key。
5. 前端区分尚未探测、缺失、被宿主禁用和可选；可选表示初步探测和当前准入通过，不代表认证成功。

### 非目标
- 不做外部 runtime 的审批交互 UI（无人值守）。
- 不做会话续跑 / resume / 多轮追问（结构化修复用重新 invocation，不依赖 session）。
- 不把 dsh 工具暴露给外部 runtime，也不把外部 runtime 注册成 dsh subagent provider。
- 不新增节点类型（扩展 `agent` 的 `data`，避开双端注册铁律的新类型流程）。
- 不动 `server/`（4020 Express 回退能力冻结）。
- 不做不可信租户隔离或外部副作用验收；原生 Windows 以及未验证清理能力的平台禁用外部 runtime。WSL 按 Linux 独立验收，Git Bash 不改变 Node 的 `win32` 平台。

### 反目标（做成这样即失败）
- **静默判绿**：仅凭 exit=0、CLI 自述或协议成功就抹掉已知错误、缺失结果或缺失的显式必需交付物。自由文本任务没有可机器验证的业务验收条件，不能承诺识别任意未履约（见 §9；A 的实测见 §4）。
- 把凭据写进源码、fixture、日志、工作流导入导出。
- 向外部 runtime 注入工作流调用工具、会话认证或可执行触发凭据；不把「未注入」表述成阻止受信 CLI 经原生工具或网络回调的安全边界（§6.4）。
- 为了接 runtime 把现有 dsh 路径改坏（`runtime` 缺省必须逐字保持今天的语义）。

## 3. 实测约束与评审补证

探针环境：`/tmp/wf1-runtime-probe`（隔离工作区）+ 一次性 dsh profile（已删）。dsh 全局已升到 **0.2.2-rc.5**，cordis 4.1.0。

### 3.1 三个 CLI 的无头模式

| runtime | 入口 | 事件流实测 | 结构化 | 无人值守权限 |
|---|---|---|---|---|
| codex | `codex exec --json` | `thread.started` / `turn.started` / `item.started` / `item.completed`（item.type = `agent_message`、`command_execution{command,aggregated_output,exit_code,status}`、`file_change{changes[{path,kind}],status}`、`error`）/ `turn.completed{usage}` | `--output-schema <file>` **原生支持**，实测产出合法 JSON | `-s workspace-write` 默认审批不拦，实测改文件成功 |
| claude | `claude -p --output-format stream-json --include-partial-messages --verbose` | `system:init{cwd,session_id,tools,model,permissionMode,apiKeySource}`、`system:hook_started/hook_response/status/thinking_tokens`、`stream_event`（实测 210 条增量）、`assistant{message.content[thinking\|tool_use\|text]}`、`user{tool_result}`、`result{subtype,is_error,result,usage,total_cost_usd,session_id,num_turns,permission_denials}` | **评审补证**：本机 `claude --help` 有 `--json-schema`；原录制未测该 flag 的结果帧与实际 provider 兼容性 | `--permission-mode acceptEdits` **能覆盖**全局 `bypassPermissions`；`--allowedTools Bash` 预放行实测有效，但不是发布默认值 |
| pi | `pi --mode json -p --no-session` | `session`(header) / `agent_start` / `turn_start` / `message_start` / `message_update`(增量，实测 199 条) / `message_end`(role = system/user/assistant/toolResult) / `tool_execution_start/update/end` / `turn_end{message,toolResults}` / `agent_end{messages,willRetry}` / `agent_settled{aborted}` / `auto_retry_start/end` | 无原生 flag，走提示词 | write/bash **默认全自动、无沙箱** |

### 3.2 必须写进实现的坑（都是实测踩到的）

1. **codex 有多条 `agent_message`**（前导语 + 最终答案）。终值必须取**最后一条非空** `agent_message`，不能拼接。
2. **codex 非 git 目录要 `--skip-git-repo-check`**；stdin 必须显式给（否则打印 "Reading additional input from stdin..." 并等待）。
3. **codex 把配置警告当 `item.completed{type:"error"}` 发**（实测两条 `mcp_servers.*.type is ignored`）。这类 item 不是致命错误，不能据此判失败。
4. **claude `--allowedTools` 是可变参数**，会把紧随其后的 prompt 吞掉（实测报 "was read as a value of --allowedTools, not as a prompt"）。prompt 必须走 **stdin** 或放在 `--` 之后。
5. **claude 的模型/权限/hooks 来自 `~/.claude/settings.json`**（该文件 `env` 段自带 `ANTHROPIC_*`，`permissions.defaultMode = bypassPermissions`）。实测 scrub 掉进程环境里的 `ANTHROPIC_*` 后仍能正常认证与执行 → 环境净化不会打断 claude。
6. **pi `exit=0` 不代表成功**：实测默认模型 401、`airouter/deepseek-v4-flash` 与 `gpt-5.5` 503，进程仍 exit 0，失败只体现在 `message_end.message.stopReason="error"` / `errorMessage`。**必须读事件判成败**。
7. **pi 会自动重试**（实测 `auto_retry_start/end` 3–4 次），503 时会白等；重试事件不是有效进展，不能刷新看门狗（§7）。
8. **pi 默认模型在本机是坏的**，必须显式 `--provider/--model`；实测可用：`airouter/glm-5.3-flash`、`airouter/kimi-k3`。
9. **pi 的 `role:"system"` 消息约 51KB**（含 sections/toolsAdded），且在 `message_start`/`message_end`/`agent_end` 各出现一次。必须跳过，不进轨迹、不进 preview。
10. **pi 官方文档明确：不能用 node `readline` 切 JSONL**（它把 Unicode 行/段分隔符也当边界）。必须按 **LF 字节**切分。
11. **三个 CLI 都继承用户全局配置**：codex 实测去读了 `~/.codex/plugins/cache/ponytail/.../SKILL.md`；claude 跑了用户的 SessionStart hooks。委派不是干净 room，提示词里不要假设无外部指令。
12. **成本不低**：codex 读一个文件 + 结构化 = 42004 input tokens；claude 只回 "OK" = $0.105 / 16551 cache-creation tokens。

### 3.3 取消与进程树（最硬的一条）

让 codex 跑 `sleep 45`，三种取消方式实测：

| 方式 | 结果 |
|---|---|
| `child.kill('SIGTERM')` | **孤儿 `sleep 45`，ppid=1** |
| `detached:true` + `process.kill(-pid,'SIGTERM')` | **仍然孤儿**（codex 把 shell 命令放进自己的进程组） |
| **ps 收集整棵树 → 自底向上 SIGTERM** | codex 6 进程含 sleep、pi 5 进程含 sleep、claude 13 进程树，**三个都零残留** |
| `ctx.subprocess.terminate()`（dsh 0.2.2-rc.5，macOS） | **漏孤儿**，且 `waitForExit()` 仍 **resolved**（假称已静默） |

结论：
- **不能只用进程组 kill，也不能把 `ctx.subprocess` 的退出承诺当成树已空**。`dsh-subprocess-local` README 明写 macOS 走 detached 进程组回退，实测印证。
- 在发信号前收集后代，自底向上 SIGTERM 是探针有效的起点，不是无竞态的隔离机制。`dsh-ccpg-larkauth/lib/lark-auth.js:85` 只做单次同步快照和 SIGTERM，失败只杀根；可以参考遍历，不复制它的退出语义或跨插件依赖（§7）。
- 因为 `ctx.subprocess` 不暴露 pid（"target and managed-range identities remain provider-private"），spawn 用 node `child_process` 自己拿 pid。

### 3.4 现成扩展点（不用新造）

- `details.runtime` 字段已存在：agent 写死 `'dsh-plugin'`（`orchestrator/lib/index.js:1730`），script 是 `'quickjs'`（`engine.js:752`）。
- `runtime` 已在 `output-contract.js:118` 的 `NODE_META_ALLOWLIST`、`run-scope.js:112` 的 `STATE_SUMMARY_KEYS` 和 `typed-expression.js:26` 的 meta 白名单中。复用规范引用 `{{node["source"].meta.runtime}}`，不新增配置字段到输出契约。
- `/wf1/api/runtime-config`（`index.js:3594`）已是前端徽标数据源，目前写死返回 `{available:true, runtime:'dsh-plugin', reasons:[]}`；`web/src/App.jsx:1745` 消费它渲染 `⚡ dsh 底座`。
- 轨迹折叠：`foldTraceEvent`（`index.js:3798`）/ `buildTrace`（`index.js:3784`），entry kinds = `input` / `inject` / `assistant{text,usage}` / `tool{name,args,turn,step,result{ok,text,error}}`。
- 流式进度：`emit('agent-progress', {runId,nodeId,turns,preview,docTail,structured,maxRounds})`。
- **`docTail` 与产物收集不依赖事件流**：复用 2KB 尾读及 `safeWsList(ws)` 限额语义；`scanDocTail()` 当前只做词法路径检查且 `statSync` 跟随符号链接，外部路径不能原样复用（§6）。
- 结构化：`getAgentOutputConfig(d)`（`agent-schema.js:23`，`d.outputMode==='structured'`）+ `validateStructuredOutputWithRepair` + `createStructuredEnvelope`。
- 超时：`resolveAgentTimeouts({node,defaults})` → `nodeTimeoutSec` / `modelTimeoutSec`；引擎另有 `timeoutSec` 与 `signal`。
- 工作区：`workspaceFor(node,{workflowId,runId})`（`index.js:3902`）；今天 dsh agent 的 cwd 是 `store.workspaceRoot`，交付物写进 `outputDir`（相对路径写进 persona）。

## 4. 方案对比与选择

### A：走 dsh 官方 subagent provider（已实测，不选）

装 `@deepseek-ai/dsh-subagent-codex` / `-claude-code` / `-acp`，造一个空转父 agent，调 `ctx.subagents.startActivation({provider, delivery:'caller', parent, cwd, prompt, signal})`。

0.2.2-rc.5 实测：

| 通道 | stopReason | 耗时 | 文件真改? | 返回 |
|---|---|---|---|---|
| codex | completed | 19.8s | ✅ | 39 字干净答案，`resultKeys` 只有 `['output','stopReason']` |
| claude-code（默认 `permissionMode:"dontAsk"`） | completed | 27.0s | ❌ **原文未动** | 128 字"权限被拒"自述 → **静默判绿** |
| claude-code（配 `acceptEdits`） | completed | 44.2s | ✅ | 96 字答案 |
| pi 经 `dsh-subagent-acp` + `pi-acp` | completed | 15.7s | ✅ | **5660 字，其中 5.4KB 是启动横幅**（skills/extensions/版本/MCP 警告），真答案只在末尾 200 字 |
| 带 `outputSchema` | — | — | — | **`UNSUPPORTED_CAPABILITY` 明确拒绝** |

A 的硬伤（升级后一个都没修掉）：
1. `SubagentCapabilities` 只有 `{agentOptions, agentPreset, outputSchema, depthLimit}`，外部 provider 一律 `NO_START_CAPABILITIES` → **结构化输出被硬拒**，已配该模式的节点必失败。
2. 无进度流、无 usage、无 turns → 实时轨迹 / 流式预览 / 用量徽标全废。
3. claude 默认配置静默判绿（反目标）。
4. pi 输出被启动横幅污染，要么改用户 pi 设置 `quietStartup`，要么在 glue 里切尾。
5. 装 provider 包会自动往**全局工具表**插 `subagent_codex` / `subagent_claude_code`（dump-config 805/814 行证实），节点 agent 会看到它们。
6. **版本精确门**：provider 版本必须与启动 runtime 精确同版本（`@next` 当时解析到 rc.4，与 dsh rc.5 不匹配被拒装；provider 的 `latest` tag 是 `0.0.1-rc.1` 占位）。
7. **API 已破坏性变更过一次**：0.2.1 是 `spec.request.{parent,cwd,prompt}`，0.2.2 扁平成 `spec.{parent,cwd,prompt}`（`SubagentActivationSpec extends Omit<SubagentStartRequest,...>`）。按旧契约写的代码在新版直接 `TypeError: reading 'id'`（`dsh-subagent/lib/index.js:3024`）。
8. `dsh-subagent-acp` 没有 `dsh.bundle`，装完不自动挂载，新增行必须用 `- insert:` 形式。
9. 没有 pi 官方 provider（npm 404）。

A 的唯一优势：glue 极少（约 100 行），codex 通道确实干净好用。**但代价是把已有功能做坏，不是少做一点。**

### C：混合（codex/claude 走 A、pi 走 B）——不选
两套语义、能力不一致（pi 有流式另两个没有），以后每加一个 runtime 都要选边。

### B：直接驱动 CLI 无头模式 —— **选定**
CLI 基本执行与已知协议形状有实测证据（§3）。集成后的授权、终态、清理和可靠交付不能由探针外推，按 §10–12 逐个 runtime 放行。

## 5. 架构与落地面

### 5.1 节点 data 新增字段（`agent` 类型）

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `runtime` | `'dsh'\|'codex'\|'claude'\|'pi'` | 缺省/空 = `'dsh'` | 执行底座。**缺省必须逐字保持今天的行为** |
| `externalModel` | string | 空 | 外部 runtime 的原生模型 id。codex/claude 空值跟随 CLI，pi 必填 `provider/model`（§6.3）。 |
| `requireArtifact` | boolean | `false` | 仅外部 runtime：至少产出一个新的、非空、可收集的节点文件（§9）。文本节点不默认要求文件。 |

不复用 `data.channel` / `data.model`；**`runtimeModel` 仍是瞬态结果字段**，现有 App/SSE 会回填它，保存、重开和试运行都会剔除它。`externalModel` 只用于配置，`nodeState.model` → `data.runtimeModel` 只用于结果展示。空或缺省 `runtime` 才兼容为 dsh；未知 runtime、非法字段类型或不支持的组合显式报错，不回退到 dsh。缺省与显式 `dsh` 在运行指纹中等价；外部配置的实质变化须让旧断点失效。

### 5.2 引擎分派

`orchestrator/lib/index.js` 的 `runAgentNode`：
- 在 `runAgentNode` 前段校验显式外部 runtime 并分派；dsh 保持原来的模型、提示词、工具与技能路径。外部路径复用模板上下文、附件复制、通用提示词、结构化契约，但不拼 dsh `skill` 工具索引、lark-cli 用户续期说明或名为 `read` 的 dsh 专用指令。用 CLI 自己的工具读取实际复制成功的附件。
- 正式运行与 `/wf1/api/node/test` 仍走 `agent` kind；宿主准入、执行期校验和取消处理在共同执行边界，不依赖前端或某个 start 入口。现有试运行用毫秒时间生成 ID，`TestRunModal` 又只匹配 `test_` 前缀；改用唯一 `test_` runId 与请求关联，不能只看前缀。验证 HTTP 响应断开确实触发 abort，而不只监听请求体 `aborted`，超时后也不能回 `{ok:true}`。
- 外部路径复用 `createStructuredEnvelope`、有界产物清单和结果形状。实时轨迹放入现有 `liveTracesByRun.get(runId).get(nodeId)`，失败也通过 `err.nodeDetails` 保留受限快照；不把 CLI session id 填入 dsh `sessionId`（会触发 `replayTrace`）。一律按 `runId` + `nodeId` + attempt 管理进程、计时器、trace 与迟到事件；SSE 使用现有形状与节流，不广播原始 CLI 帧。
- 现有 dsh 路径的 `details.runtime` 从 `'dsh-plugin'` 保持不变（不要改成 `'dsh'`，避免破坏已有运行记录与前端判断）。

### 5.3 新增文件

```
orchestrator/lib/runtime-cli.js        共享层：spawn / LF 分帧 / ps 树 kill / 超时 / stall 看门狗 / env 净化 / 轨迹折叠驱动
orchestrator/lib/runtime-codex.js      codex 适配器：argv、事件→trace、终值、usage、turns、--output-schema
orchestrator/lib/runtime-claude.js     claude 适配器
orchestrator/lib/runtime-pi.js         pi 适配器
orchestrator/test/runtime-cli.test.mjs 共享层单测
orchestrator/test/runtime-adapters.test.mjs  三适配器单测（用真实录制 fixture）
```

适配器统一接口（供共享层调用，纯函数 + 一个 spawn 描述）：

```js
export const codexRuntime = {
  id: 'codex',
  bin: 'codex',
  probeArgs: ['--version'],
  buildSpawn({ persona, userPrompt, cwd, model, schemaFile, scratchDir }) -> { argv, stdin },
  onEvent(ev, acc) -> void,        // 已知事件投影：轨迹、预览、有效进展、用量与终态
  finalize(acc, exit) -> { text, usage, turns, error },
};
```

`acc` 按 invocation 创建；适配器识别有效进展与必要终态，共享层管理生命周期和上限。修复 invocation 的调用 ID 不与主执行合并配对。

### 5.4 前端

- `web/src/NodePanel.jsx`：agent 配置区加 runtime 下拉。dsh 保留渠道/模型/思考档位/工具白名单与技能；外部 runtime 隐藏这些 dsh 专属选项，但保存其值供切回 dsh，后端必须忽略，lint 提示不生效。切换 runtime 清除 `externalModel`（不把 pi 模型交给 codex，反之亦然）；保留输出模式、节点总超时和 `requireArtifact`（后者仅对外部路径生效）。明确静默超时与轮数能力差异（§7）。外部模型只做自由输入及格式提示，不伪造当前账号可用的模型列表。
- `web/src/registry.jsx`：`agent.badges` 增加 runtime 徽标（`runtime && runtime!=='dsh'` 时显示 `codex`/`claude`/`pi`）。
- `web/src/App.jsx:1745` 的工具栏保留旧宿主徽标；新增 `runtimes` 只供节点选择器。未知、禁用或未安装的已选 runtime 保留显示并给出原因，可切回 dsh；不自动重写图。`NodePanel.jsx:823` 当前显示瞬态模型而不是 runtime，节点详情从被查看运行的 `state.runtime` 读实际底座，不取当前画布配置。保存/重开/导入导出、试运行、撤销与历史/SSE 回填都验证配置和结果互不覆盖。
- **JSX 里裸 `{{变量}}` 会白屏**，提示文案必须包字符串。

### 5.5 后端路由

- `/wf1/api/runtime-config` 改为返回：
  ```json
  { "runtime": { "available": true, "runtime": "dsh-plugin", "reasons": [] },
    "runtimes": [
      {"id":"dsh","available":true},
      {"id":"codex","available":true,"version":"codex-cli 0.170.0"},
      {"id":"claude","available":false,"reason":"not-installed"}
    ] }
  ```
  原 `runtime` 保持原值与形状，旧 App 仍只读取这个字段。探测按宿主固定的可信可执行文件与环境执行 `--version`，异步、有超时/输出上限、共享正在进行的探测并做短 TTL 缓存；不用 `spawnSync` 阻塞 dsh/SSE。只返回枚举原因和经解析的版本，不返回绝对路径、原始 stdout/stderr、环境或账户信息。始终校验真实 spawn 失败，缓存不是授权或兼容证明。
- **保持 `scoped:true`**：`register` 的 `scoped:false` 会同时绕过 `requestStore` 的会话/工作区解析、`ensureTriggers()` 与其异常包装；它不是纯粹取消 409。当前选择器只在有工作区的画布使用，且结果需结合该 workspace 的准入，不值得扩大宿主信息暴露面。仅对已准入的 runtime 做宿主探测并缓存，工作区授权每次派生；未注入 session 或收到 409 时显示探测未就绪，在 session 到达后重取，不改其他路由。`requestStore` 解析不等同于授权；运行仍单独做 §6.4 检查。

### 5.6 助手侧同步（铁律 1 的延伸）

在 `lib/assistant.js` 的 `agent` 配置契约里同步 `runtime` / `externalModel` / `requireArtifact` 和无效组合，供 `canvas_*`、`workflow_*` 改图；两家族的绑定和工作区规则不变。`lib/variable-schema.js` 的变量树描述输出与运行元数据，已有 `meta.runtime`、`meta.model`，无需把配置塞进变量树，也不改 `NODE_TYPES`。

### 5.7 仓库铁律核对

| 铁律 | 实施约束 |
|---|---|
| 1. 双端节点注册表 | 扩展现有 `agent` kind 的执行/lint 与前端 `agent` preset/summary/badges；助手配置同步，变量树保留已有 meta 输出。没有新 kind 或调度旁路。 |
| 2. canvasui bundle | 不直接改 `lib/client.js`；若改宿主 `src/client.js`，重新构建并 `--check`。画布实现留在 `web/`。 |
| 3. 4020 冻结 | 新逻辑只在 `/wf1/api/*` 插件路径，不改 `server/`。 |
| 4. 工作区本地存储 | SQLite 与文件目录保持原位置；cwd 继续工作区根，产物仍由现有 `workspaceFor` / 成果 API 管理。不迁飞书凭据，不提交 `.workflow-one/`。 |
| 5. 构建产物不入库 | 按 §10 跑双 base 构建，分发由 `pack.sh` 现场生成；所有构建产物和原始探针不提交。 |
| 6. 通知渠道抽象 | 生命周期只由现有 `notifications.js` 消费，渠道、中立事件、摘要、去重、失败隔离按 §9；不新建监听器。 |
| 7. 并发与定时任务 | 以 `runId` 隔离进程、产物和事件，UI 查看态仍用 `inspectedRunId`；仅本画布发起运行会自动跟随。`schedule.js`、`state/triggers.json` 与 misfire/catch-up 语义不改。 |
| 8. 两家族助手工具 | `canvas_*` 按会话绑定、`workflow_*` 按 session cwd 管工作流库，失败不回退默认工作区。保留共享 `startWorkflowRun`、`runProgressOf`/`resumableRun`、`assistant-patch` 与 `assistant-open-workflow`、`/trigger` 行为；不注入这些工具给节点 CLI。 |

## 6. 每个 runtime 的契约

三个 runtime 继续用规范化的 `workspaceRoot` 作 cwd，保持项目上下文与已有文件的读取方式。交付物写 `workspaceFor(node, { workflowId, runId })` 下的输出目录。目录位于 `.workflow-one/runtime`，不能从词法子路径推断物理归属或可写性：创建时检查父链和真实路径仍在宿主运行根内；CLI 以其实际工具向真实的隐藏子目录写文件做验收。目录不可写时报清楚，不改 cwd 或放宽沙箱作为回退。读取 docTail 时跳过符号链接、核验物理根及普通文件，并在打开时拒绝跟随链接；不把已有附件和内部文件显示为产物。整个 cwd（包括其他节点目录、状态与 SQLite）不是写入隔离边界；不能承载不可信输入或工作区之间的安全隔离承诺。

区分任务约定、渲染后的节点 persona 与业务输入；只有静态约定可直接用于 `--append-system-prompt`。渲染后的内容可能含业务输入，不放进进程列表可见的 argv；走 stdin，或使用已验证的 CLI 文件参数和本次私有临时文件。规约冲突时不得承诺 persona 优先；通过权限与交付物验收约束可观察结果。

### 6.1 codex

```text
argv: codex -a never exec --json --skip-git-repo-check -s workspace-write -C <workspaceRoot>
      --output-last-message <resultFile> [--output-schema <schemaFile>] [-m <externalModel>]
stdin: persona + "\n\n" + userPrompt      （codex 无 --system-prompt，persona 是普通任务文本）
cwd:   workspaceRoot
```
- `-s workspace-write` 的可写边界由 CLI 沙箱和本机配置决定，不是 `outputDir`；`-a never` 固定无交互审批，不关闭沙箱。本机帮助/参数解析已核对，组合后的 workspace 写入及边界需要 P1 真实验证。若产品要求严格只写 `outputDir`，必须另有经验证的 OS 约束，本方案不宣称做到了。
- 事件映射：`item.completed{type:agent_message}` → `assistant` entry、预览和候选终值；`command_execution` → 有界 `tool` entry；`file_change` → `tool` entry。已知的 `item.type:error` 配置警告只作为诊断，不判失败；未知事件记录一次类型/CLI 版本告警，不写原始帧。工具非零可以被 agent 恢复，不单独判节点失败。
- 成功要求进程 exit code 为 0、收到 `turn.completed`、无已知致命协议错误（如 `turn.failed`），且本次新建的 `--output-last-message` 文件有非空最终答案。探针中最后一条非空 `agent_message` 是正确的，但条目形状未区分前导/最终，故让原生终值文件作事实源；缺文件不回退到预览。该 flag 已见本机帮助，P1 验证其与 `--json` 同用时确实写最终答案。没有 `file_change` 本身不判失败；文件任务看实际产物，不看事件名。
- usage：`turn.completed.usage` → `{inputTokens:input_tokens, outputTokens:output_tokens}`（累加多 turn）。
- turns：`turn.started` 计数。
- 结构化：schema 和终值文件用独立于 artifact 扫描目录的本 invocation 临时目录，文件仅本用户访问，退出清理后删除。`--output-schema` 原生约束后仍走 `validateStructuredOutput` 和 `createStructuredEnvelope`；本地拒绝即失败，不再 spawn 一个有写工具的 codex 重跑。schema 被 CLI/provider 拒绝时报告不兼容，不暗中删 schema 或降级为文本。
- codex 从普通 stdin 收到的 persona 低于 CLI 自身规则；项目 `AGENTS.md`、用户规则/skills/hooks 可叠加或优先，不能保证 persona 覆盖它们。提示词不能用来隔离不可信仓库指令。

### 6.2 claude

```text
argv: claude -p --output-format stream-json --include-partial-messages --verbose
      --permission-mode acceptEdits --no-session-persistence [--model <externalModel>]
      [--append-system-prompt <staticContract>] [--json-schema <schema>]
stdin: persona + "\n\n" + userPrompt      （--allowedTools 可变参数会吞 argv prompt）
cwd:   workspaceRoot
```
- **本机补证**：当前 `claude --help` 确有 `--json-schema <schema>`；原探针没有用该 flag，不能再断言 Claude 没有原生结构化输出。P2 先验证 `stream-json` 的最终结果帧和 schema 约束是否可用；可用则传 schema，不可用仍用提示词，二者最终都本地校验。
- 事件映射：`assistant.message.content[]` 的 `text` → 有界 `assistant` entry；`tool_use` → 有界 `tool` entry；`user.message.content[].tool_result` 按 `tool_use_id` 配对。`stream_event` 的文本增量只用于当前预览/进展，不逐 delta 持久化；`system:hook_*`、`thinking_tokens`、`status` 不进 trace。由于当前默认保留 Claude 用户 settings 与 hooks，prompt 不能覆盖它们；`--append-system-prompt` 是追加而非隔离。
- 不默认追加 `--allowedTools Bash`：它会自动授权 Bash，不是“沿用用户 allow 规则”的无风险等价物。`acceptEdits` 只自动接受编辑；未经预授权的 Bash 在无交互 `-p` 下若被拒，必须由 `permission_denials` 或对应错误帧判失败，不能读模型自述判成功。若未来放开 Bash，需有命令级边界或宿主显式授权，并重新验证工作区外写入。
- 成功要求进程 exit code 为 0、收到该 invocation 的最终 `result`、`subtype==='success'`、`is_error===false`、`permission_denials` 为空，并有非空文本或明确的原生结构化值。缺少终态/字段按协议失败，不以文本自述替代。
- usage：`result.usage` + `total_cost_usd`；turns：`result.num_turns`。
- **失败判定**：成功条件任一缺失或有明确权限拒绝均失败，denials 仅保留脱敏、有界摘要。普通工具错误可能由 agent 恢复，保留轨迹且按实际验收条件判定，不假定能够推断哪个工具调用是业务必需的。
- 结构化：P2 以 `--json-schema` 的真实终值帧为首选，本地校验失败不再次执行任务。若目标 provider 不支持原生结构化，提示词模式须明确标注，且只在能够彻底关闭修复工具与副作用入口时启用 §6.5；否则单次校验失败即报错。

### 6.3 pi

```text
argv: pi --mode json -p --no-session --provider <p> --model <m>
      [--append-system-prompt <staticContract>]
stdin: persona + "\n\n" + userPrompt
cwd:   workspaceRoot
```
- `externalModel` 约定写成 `provider/model`（如 `airouter/glm-5.3-flash`），适配器拆成 `--provider`/`--model`；必须校验分隔符和两段非空，并以 argv 值传递，禁止拼 shell 命令或接受额外 CLI flags。
- 事件映射：`message_end{role:assistant}` 的 `content[]`：`text` → `assistant` entry；`toolCall{name,arguments}` → `tool` entry；`message_end{role:toolResult}` → 按 `toolCallId` 配对回填；`message_update.assistantMessageEvent{type:text_delta}` → 只更新 preview；**`role:"system"` 一律跳过**（51KB）。
- 成功要求进程 exit code 为 0、收到最终 `agent_end{willRetry:false}` 与 `agent_settled{aborted:false}`，且最终 assistant 消息非空、stop reason 为已验证的正常终止，最终 assistant/turn 没有 `stopReason==='error'` 或 `errorMessage`。早期错误只有观测到明确 retry 及随后完整正常终态才可恢复；不允许先前非空文本掩盖最终错误。缺必需帧按协议失败。**exit=0 只作必要条件，不代表成功**。
- turns：`turn_start` 计数；usage：assistant message 的 `usage`（`{input,output,cacheRead,cacheWrite,cost}`）累加。
- 自动重试：`auto_retry_start/end` 可折叠成一条脱敏、有界诊断；不能刷新模型 stall 看门狗。PI 的 persona/用户 settings 仍可含本地规则、扩展和工具，`--append-system-prompt` 不提供隔离。

### 6.4 权限与宿主准入（评审结论）

| runtime | 默认 | 理由 |
|---|---|---|
| codex | `-s workspace-write` + `-a never` | 保留沙箱，不继承审批默认；实际可写目录以 P1 验证为准 |
| claude | `--permission-mode acceptEdits`，不传 `--allowedTools Bash`，禁用手动绕过模式 | 已实测覆盖全局 `bypassPermissions`。`acceptEdits` 是工具授权策略，不是文件沙箱；用户 settings/原生 hooks 仍可能扩展能力 |
| pi | **默认宿主禁用**；只有部署级显式启用后才可运行（CLI 本身无沙箱） | UI/lint 警告不能保护 webhook、schedule、catch-up、助手工具和导入工作流；运行入口必须服务端拒绝未启用的 pi 图 |

- **不提供 `bypassPermissions` / `danger-full-access` 开关**（本期）。CLI 用户 settings 仍是信任面，宿主准入不能宣称覆盖它。
- 首期只面向宿主操作者信任的本机工作区、工作流和输入。宿主本地配置按规范化 workspace 与 runtime 白名单显式准入，默认关闭外部执行；不能由画布、导入 JSON、助手补丁或 HTTP 参数自我授权。准入共同边界覆盖正式运行、试运行及所有触发来源；未启用时保存/查看可以，执行明确拒绝。不向不受信方开放可触发这些节点的入口；无法建立该部署边界时保持禁用。pi 即使启用也保留 UI/lint 无沙箱警告，不承诺隔离。
- 节点 `data.tools` 白名单和 `data.skills` 仅用于 dsh；外部路径不做假映射，界面按 §5.4 提示。
- `canvas_*`/`workflow_*` 不作为 CLI 工具注册；但继承的 MCP/extensions、Bash、网络访问可能另行触发工作流，不把“未注入 dsh 工具”当作阻止递归运行的安全保证。

### 6.5 仅格式修复

对提示词模式的结构化输出，先按 `agent-schema.js` 现有提取与校验处理（可恢复的代码块等无需再调用模型）。仅当主 invocation 已协议成功并清理、唯一失败是格式/schema，且总超时仍有余量时，才允许最多一次无会话、无工具的文本修复；输入为原始候选、schema 和校验错误，不附原任务/附件，也不接受新的文件产物。关闭工具之外还须核实 hooks、扩展和 MCP 不会执行；不能验证就不启用修复，直接报告校验失败。计入同一次节点尝试的 usage、时限、取消与轨迹，最终再校验。不会恢复丢失的语义上下文，也不会补做业务任务。

## 7. 取消、超时、进程树

共享层统一负责，适配器不碰进程：

1. `spawn(bin, argv, { cwd, stdio:['pipe','pipe','pipe'], env: scrubbedEnv })`，无 shell、默认不 `detached`。spawn 前检查 signal 并处理 `error`/`close`、提前 abort 和 `stdin` EPIPE；取消、超时与自然退出共用一个幂等收尾，不在自然退出回调中盲杀旧 PID。是否 `detached` 不是探针失败的根因，进程组 kill 仅不能覆盖 CLI 自建进程组。
2. stdout 按 **LF 字节**切分（不用 `readline`）；分帧剩余缓存、单帧、累计 trace/终值、stdout 处理速率和 stderr 尾部都有上限。畸形/截断帧不参与终态；超限走失败清理，不能只裁掉终值后判绿。
3. **取消/超时清理**：异步、有界 `ps`，在父链仍可观测时采样并记录 PID + 启动身份（防 PID 复用），发信号前再核对；取消先快照，后代先于父代 SIGTERM；宽限内重复扫描仍活根/已知子树，宽限后对身份仍匹配的存活进程 SIGKILL。自然退出也核对已跟踪后代；`exit` 说明直接子进程退出，`close` 再说明 stdio 关闭，二者都不等于树空。只由 Node/libuv 回收直接子进程，孙辈 zombie 无法 `waitpid` 或再 kill，不当作仍能写文件的进程。扫描失败、残留或管道不关闭按有界清理失败收口，不无限等、不成功 settle、不重试。
4. **限制保证**：`ps` 快照不是原子操作；子进程可在快照后 fork，daemonize/改变父链后可逃过追踪。故“整棵树绝不留孤儿”在此设计下不可证明。若零孤儿是硬要求，须先引入并验证 OS 级进程监管；本期承诺限定为已跟踪的存活后代并显式暴露清理失败。不得以单次 `larkProcessTree` 快照声称已完全解决竞态。
5. Node `process.platform==='win32'` 时在 spawn 前拒绝外部 runtime；不降级成只杀 root。WSL 内 `process.platform==='linux'`，仍需独立验证。
6. **节点总超时**：沿用引擎/试运行 timer 和 `timeoutSec` / `resolveAgentTimeouts`，不创建独立、会被修复重置的总计时器。到点撤销并进入有界清理，由调用方按超时分类，不伪装成用户取消；清理可在任务时限后结束。已触发 abort 不得产出成功或启动修复。
7. **stall 看门狗**：绝不以 stdout 行、stderr 字节或任意事件作为模型进展。仅 adapter 判定的模型内容增量/请求完成重置；`auto_retry_*`、503、hook/status、心跳和未知事件不重置。工具调用期间暂停模型请求计时；只在该 runtime 能稳定界定模型等待区间并通过故障注入验证后启用。否则该 runtime 首期仅由节点总超时兜底，不能声称完整支持 `modelTimeoutSec`。
8. **maxRounds**：pi 可在经验证的 `turn_start` 粒度超限失败；Codex 探针的多个工具调用仍在单次 `turn.started` 内，Claude 只有最终 `result.num_turns` 可确定总轮数。Codex/Claude 首期不承诺在线轮数限制，相应字段隐藏并提示不生效；用量及轮数展示分别注明口径，不合成不存在的模型步数。

## 8. 认证与环境

- 一律用本机 CLI 原生登录态：codex `~/.codex/config.toml`（本机是 `model_provider="custom"`）、claude `~/.claude/settings.json`（`env` 段自带 `ANTHROPIC_*`）、pi `~/.pi/agent/auth.json`。**插件不存 key、不读 key、不写 key**。
- **采用第三条路：最小正向环境白名单**。从空 env 构造，只传可信宿主的 `PATH`、`HOME`、必要的 locale 和临时目录；原生 CLI home 路径变量仅在真实兼容性测试需要时逐项加入。不继承动态加载器、shell 启动、通用运行时注入或任意 provider env；不按变量名猜测凭据。固定解析可信绝对二进制，不从工作区相对/空 PATH 段或图配置寻找可执行文件；探测和执行同口径。只靠父进程环境密钥认证的安装首期不支持，提示配置 CLI 自己的登录态。
- **取舍依据**：已查本机 `scrubbedParentEnv` 的导出和实现，匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*`；它是通用过滤，不识别任意命名的 `apiKeyEnv`，也不自动移除注入变量（如 `NODE_OPTIONS`）。本地复制 denylist 有同类缺口。按正向白名单无需引入 SDK；`bootstrap-deps.sh`、`setup.sh`、`pack.sh`、`assemble-one.sh` 与包依赖清单均不为此改。未来若改正式 SDK import，必须同时核对这些入口和聚合包/registry 的解析，不将绝对软链装进 tarball。
- 环境净化只减少父 dsh 环境变量传递，不隔离 `HOME` 下的 CLI 登录、配置、hooks、skills、MCP 或文件访问。错误和持久化 trace 不记录 env、原始 argv、完整 stdout/stderr；必要诊断须截断并脱敏。通知用的 `summarizeNotificationText` 只在通知摘要路径调用，不是通用 trace sanitizer。
- 允许节点级 env 覆盖？**本期不做**（没有需求，且是凭据泄漏面）。

## 9. 错误语义与重试 / 通知

- 失败判定只承诺协议可观测条件：非零退出、缺终态、事件明确错误、权限拒绝、空终值、结构化校验失败，以及 `requireArtifact=true` 时缺少非空新产物都失败。`turn.completed` / `result.subtype==='success'` 仍不能证明自由文本任务语义完成；普通文本节点应配置结构化 schema 或 `requireArtifact` 才能做更强机器验收。
- `retryCount` 仍由引擎处理，不在 runner 私自重试。启动前配置/授权错误、协议不兼容和清理未确认不重试；引擎当前只看 `kind.retryable`，需给外部节点错误显式的不重试标记。总超时会 abort 本 attempt，当前退避若仍消费已 abort 的 attempt signal 不会进入下一次；外部可重试超时的退避用运行级取消信号，且只在清理确认后开始。用户取消不重试；不改变 dsh 分支既有行为。
- `continueOnFail` 当前会把失败写成 `success+toleratedError`。外部节点的已知任务失败可按显式容错配置继续，但必须标明容错，不当作真实履约；宿主准入与清理失败不得被容错吞掉或覆盖诊断。用户取消同时发生清理失败时仍保留取消与清理告警，不报清理成功。
- 外部 CLI 的副作用不回滚；`retryCount>0` 明示整段任务会重执行。每次尝试重新准备独立、干净的输出目录（成功且收尾后才将文件发布到现有节点工作区），不得让前一次失败留下的文件或本次输入/临时文件满足 `requireArtifact`。合并收尾仍走现有成果 API/限额，继续供历史、预览与续跑读取。文件存在只证明有成果，不证明正确性或外部操作成功。
- 错误摘要只包含 runtime id、退出码/信号、已解析 CLI 版本、脱敏/截断错误码或尾部；不回显绝对 bin 路径、原始 JSONL、完整命令参数、env 或未过滤 stderr。
- **不得泄漏凭据**：通知摘要继续用 `summarizeNotificationText`；trace、assistant 预览、工具参数/结果、docTail 和错误有各自的持久化/SSE 边界，先投影必要字段、脱敏、限长，不落原始帧。工具参数/结果不能安全投影就省略正文。写失败用例覆盖 Bearer、`api_key`、shell export、URL query。诊断过滤不是 DLP，也不悄悄改写结构化业务值；工作流原文与交付文件仍限受信使用，不允许把凭据作为业务输出。
- 通知层零改动：失败仍由 engine 的普通节点终态触发；`notify` 透传上游输出且不连线也观察，通知进度排除 `notify` / `note`。`terminal` 在成功/失败/取消时发送一次；`each_node` 只发最终业务节点成功/失败并追加运行通知，不为 CLI 修复/重试或恢复节点重复发送。沿用渠道中立事件、摘要优先输出节点/回退最后成功业务节点、现有飞书 `chat_id` / `open_id`（兼容旧 `chat_id`）和独立应用凭据；不复制飞书渲染或监听器。通知失败只写 `notification`，不改节点/运行状态；导入导出不带凭据。
- 并发按 `runId` 隔离 trace/进程/临时目录/SSE；并发同一 workflow+node 不能共用 artifact 或回填互相状态。断点续跑沿用 `nodeStates`：已完成 runtime 节点不重跑、不重复通知；runtime 配置变化通过现有图指纹触发兼容的 resume diff。

## 10. 测试与真实验证计划

### 10.1 单测（零依赖 node assert，照仓库约定）
- `runtime-cli.test.mjs`：LF 分帧（含跨 chunk 半行、CRLF、**Unicode 行分隔符不得当边界**）、畸形/截断帧与输出上限；ps 解析与身份检查、自底向上排序、重复扫描/退出条件；正向 env 白名单（任意命名凭据、注入环境不透传）；语义 stall 计时（未知事件/503 不刷新）；取消/超时/退出竞态。另做 POSIX 子孙进程集成测试：根先退出、取消中继续派生、忽略 SIGTERM、管道未关闭和两个并发进程只取消一个；不以通过这些用例推导 daemonized 后代不存在。
- `runtime-adapters.test.mjs`：用**真实录制的 fixture**（来自本次探针，脱敏后）断言：
  - codex：多条 assistant 取末条；`turn.completed`/非零 exit/空结果组合；配置警告不误判；usage 和 tool 项；schema 临时文件清理；缺少成功终态失败。
  - claude：tool_use/tool_result 配对和工具错误；denials/错误 subtype/缺 result/空文本失败；`--json-schema` 的实际版本和 stream-json 最终帧；acceptEdits 下允许与拒绝 Bash 各一例。
  - pi：**exit 0 但 `stopReason=error` 必须失败**；`agent_end`/`agent_settled` 缺失和 aborted；system 消息跳过；toolCall/toolResult 配对；503 重试事件不能刷新 watchdog。
  - 三者都测未知新增事件只告警、丢弃原始帧；缺少必需 terminal event 必须失败。固定 fixture 仅钉住录制版本，不会自动发现用户安装 CLI 的协议漂移。
- 补 workflow-serialization / resume fingerprint 测试：`externalModel`、`runtime`、`requireArtifact` 保存/导出/重开不丢；瞬态 `runtimeModel` 继续剔除且不会覆盖节点配置；切回 dsh 时旧渠道/模型恢复。集成验证清理失败不重试、超时退避可中断、同节点上次失败文件不能充当本次成果、符号链接和预复制附件不入 docTail/成果。
- 按 AGENTS.md 跑全量 `npm test`、`sh dsh-plugins/build-web.sh` 双构建、`sh dsh-plugins/build-canvasui.sh --check`、CI；不是仅挑 orchestrator/web 套件。

### 10.2 本机真实验证（合并门槛，不是单测绿就完）
1. 全量 `npm test`、`sh dsh-plugins/build-web.sh` 双构建、`sh dsh-plugins/build-canvasui.sh --check`；CI 同样全绿。
2. 起真 dsh（本机注意 `start.sh` 的 DSH_BIN 可能解析到桌面版 sh 包装脚本，必要时用 nvm 全局 `@deepseek-ai/dsh/lib/bin.js`）。每次改插件完整停止后重启。至少检查源码/聚合安装能加载，再由 `pack.sh` 打包并在独立 profile 装包 smoke；不提交产物。
3. 画布上分阶段建 agent 节点真跑：
   - 断言产物落进各节点 runtime 输出目录、`details.runtime` 正确、trace 有 tool/assistant entries、usage/turns 非空。
   - 结构化输出：codex `--output-schema`、Claude `--json-schema` 如实测可用、pi 提示词；三者本地 schema 校验。故意破坏 schema 结果验证原生模式直接失败，提示词模式如启用修复也不会重放原任务。
   - 改写与读取边界：验证 CLI 可读工作区输入、产物写到本节点目录；另外尝试写 `outputDir` 以外路径，记录沙箱真实范围，不把 prompt 约束算作拦截。
4. **取消/超时**：用户取消和节点总超时各跑长工具任务；断言 run/node 终态正确、响应 abort，枚举已知 PID 树。验收只声称探针场景无后代残留，不用有限 `ps` 检查推导绝对零孤儿；若平台要求强保证，P1 阻断直到换成 OS 监管。
5. **失败/无工作**：pi 坏模型 exit=0、Claude Bash 权限拒绝、Codex exit=0 但无 `turn.completed`、空结果和 `requireArtifact` 无文件，均验证不能判绿；再验证普通文本问答无文件可合法成功。检查一次显式 `retryCount` 会重跑并告警。
6. **授权入口**：未获宿主准入时，UI、`/node/test`、manual、schedule、webhook/catch-up、`canvas_*`、`workflow_*` 和 `/trigger` 的执行不能 spawn；允许编辑、导入、查看但不能由它们开启权限。带/不带 session 验证 `runtime-config` 兼容旧 `runtime` 和 409，不返回路径或原始诊断。
7. **并发与续跑**：同工作流同节点并发两次，runId/SSE/trace/文件互不串；同工作区并行试运行分别收到自己的预览；schedule/webhook/catch-up 不抢占 `inspectedRunId`；完成节点恢复时不重复执行、不重复发通知。
8. 前端在真实浏览器里点到（CDP/playwright）：运行态字段和 `externalModel` 保存/重开/撤销，缺 CLI、禁用 pi、非法模型、切换 runtime、工具/思考/技能设置的显示和恢复、徽标/详情/流式预览/失败态。
9. 通知：用假渠道验证有/无线、两种通知模式、摘要脱敏及通知失败只进 `notification` 元数据；真实飞书发送仅在用户明确批准收件人与实发后执行。

## 11. 分阶段交付

| 阶段 | 内容 | 独立可验证 |
|---|---|---|
| P1 | 共享层 + codex + 可保存配置/UI/API + 服务端准入/终态/脱敏 | 真 dsh 下验证 codex、旧 dsh 路径、结构化、runId 并发、取消/超时和分发；未交付的 adapter 不开放 |
| P2 | Claude adapter、权限拒绝处理和 `--json-schema` 实证 | 真 CLI 下允许/拒绝 Bash 都不静默判绿，验证 hooks/session persistence 与实际结果协议 |
| P3 | pi adapter + **默认禁用的宿主 opt-in** + fixture | 各种触发入口都受 opt-in 控制；无沙箱警告只作补充提示，未实现服务端门禁不发布 pi |

每阶段一个逻辑提交（引擎 / 前端 / 构建 / 文档分开，按 AGENTS.md）。P1 前开特性分支；每个 PR 都需完整 diff 审核、真 dsh/浏览器相关验证、全量回归、双构建和 CI 绿。此设计审查不替代这些实现合并门槛。

## 12. 风险与未验证项

- **事件形状漂移**：未知附加事件可忽略并按 runtime/版本/事件类型限频告警；缺少成功必需终态/字段则 fail closed，报告稳定协议错误码。记录已验证的 CLI 版本和可用协议版本（如 pi `session.version`），未验证版本提示而不是按版本字符串盲目判绿；确认不兼容的协议拒绝。CI 不假定拥有订阅，只回放最小 fixture；新增支持版本先用真 CLI smoke，再更新兼容记录与样本。成功录制未覆盖的权限拒绝、断流、错误等帧应来自额外探针或明确标注为合成反例。
- **pi 无沙箱**：最大安全敞口，默认服务端禁用；显式部署启用仍允许该进程以 dsh 用户身份访问本机文件/网络，UI 提示不能降低 OS 权限。
- **运行语义成功不等于任务语义成功**：Codex `turn.completed`、Claude `result.success` 或 Pi `stop` 只能证明 CLI 的协议终态。普通文本任务仍可能误解目标、拒绝执行或声称做完；只有 schema 或显式文件验收可机器化。
- **进程树**：单次 `ps` 不是无竞态机制，daemonize/重挂父链的进程可能逃逸。实现不满足严格零孤儿时，不能用“清理成功”作产品承诺。
- **数据边界**：CLI 会加载 HOME 下的设置、rules、hooks、skills 和扩展；父 env scrub 不会使它成为干净容器。`scanDocTail` 必须跳过符号链接并对每个文件做 realpath containment 后才读，否则 agent 可在 outputDir 放指向外部文本的 symlink 并将外部内容送入 SSE。
- **成本**：外部 runtime 各自付独立上下文（实测 codex 42K input / claude $0.105 起），且继承用户全局配置，不是干净 room。
- **未验证**：Windows 进程树；claude/pi 的 `--resume` 续跑（本期不用）；三个 CLI 在 dsh 进程环境下的长期稳定性（探针都是短时跑）。
- **既有噪声**：`/wf1/api/assistant/canvas-state` 启动竞态 409（画布挂载早于宿主 postMessage 注入 sessionId），与本方案无关，不在本期修。

## 13. 实现约束（评审结论）

- fixture 仅提交脱敏最小事件：删除个人路径、用户名、token、authorization、shell 环境值和无关大段文本；保留协议字段与版本。原始本机探针文件留在 `/tmp`，不复制或提交。
- 外部模型用 `externalModel` 自由输入，不用未经 CLI/auth 校验的静态“可用模型”候选。pi 空值 lint error；codex/Claude 空值跟随 CLI。
- 复用 `resolveAgentTimeouts` 的现有默认值，不新增 timeout 旋钮。节点总超时是所有 runtime 的硬上限；model timeout 只有经各 adapter 语义验证后启用，pi 自动重试不延长它。
- 不抽 `defineRuntime` 工厂；三份 adapter 对象保持直白。共享层只处理 spawn、帧解码、终止、超时、隔离后的投影和 stderr 上限。
- `runtime-config` 的宿主探测可用性、节点选择、宿主准入是三件事；响应兼容旧 `runtime`，不泄露 `bin`。工作区 `runtime` 配置缺省保持 dsh；执行前重新检查授权与可执行文件。
- 结果详情的 `runtime` 存真实 runtime id；`runtimeModel` 继续只作瞬态模型展示字段，外部配置只读写 `externalModel`。不得把 CLI session id 写进 dsh `sessionId`。

## 14. 评审处置与 P1 真跑结果（实现方记录，2026-11-19）

### 14.1 对评审意见的处置

评审 12 条中，以下经实现方**独立取证确认成立**并已落入实现：
`externalModel` 改名（`workflow-serialization.js:53` 的 `stripCanvasRuntimeNodeData` 确实剔除 `runtimeModel`）、
claude 存在 `--json-schema`、`resolveInside` 仅词法检查导致 `scanDocTail` 跟随符号链接、
`scrubbedParentEnv` 实为 `/KEY|PASSWORD|SECRET|TOKEN/i` 名字过滤（漏 `NODE_OPTIONS`）、
`scoped:false` 会绕过 `requestStore`/`ensureTriggers`/异常包装、`continueOnFail` 投影为 success+toleratedError、
codex/claude 无法在线限轮、pi `aborted=false` 仍可伴随错误。
另真跑验证了评审标为待验的两条：`codex -a never exec …` 被接受；`--output-last-message` 与 `--json` 同用确实写最终答案。

以下三条**不采纳评审原文，按实现方决定执行**（理由已记，供后续复审）：

1. **§6.4 准入范围收窄为「仅 pi 需部署级 opt-in」**，codex/claude 装好即可用。
   理由：本仓库现有 dsh agent 路径本来就带 bash 能力（AGENTS.md 明示「仅在可信网络开放」），宿主已是受信输入模型；
   codex 有沙箱、claude 是 acceptEdits，相对已在跑的执行体不构成新信任边界。
   对三者一律默认关闭 + 新建 workspace×runtime 白名单并覆盖 8 个执行入口，会让单操作者本机工具装好也用不了，
   且 P1 需新建一整套授权子系统。**若将来把 trigger 入口开放给不受信方，再上完整白名单。**
   pi 的服务端门禁在其 adapter 交付（P3）时一并实现，未实现前 pi 不登记进 `EXTERNAL_RUNTIMES`，执行显式报错。
2. **§9 产物验收改用「跑前文件清单 + 只认本次新增非空文件」**，不做 staging-then-publish。
   理由：与铁律 4「存储布局不变」一致，且 docTail 运行中读取路径不变；验收强度相同（上次失败残留不算成果）。
   实现见 `runExternalAgentNode` 的 `before = new Set(safeWsList(ws))` 与 `requireArtifact` 分支。
3. **§7.4 / §10.2.4 不以「换成 OS 级进程监管」作为 P1 阻断条件**。
   理由：macOS 上 Node 插件拿不到可用的 OS 级进程监管（无 cgroup，launchd scope 不可及），该条件会永久阻断交付。
   采用评审自己给出的有限承诺：只保证**已跟踪后代**，清理不确定时显式报 `RUNTIME_CLEANUP_UNCONFIRMED`、不判成功、不重试。
   产品说明不得声称绝对零孤儿。

### 14.2 P1 真跑中发现并修掉的两个缺陷（单测未覆盖，真跑才暴露）

1. **codex 环境噪声被误判致命**：首次真跑 codex 因更新插件市场失败（`git ls-remote` / `SSL_ERROR_SYSCALL`）下发
   `item.completed{type:"error"}`，原实现按 fail-closed 判节点失败；但产物 `report.md` 已正确写出、`turn.completed` 已到。
   → 改为：**所有 `error` item 只作诊断**（进 `inject` 轨迹 + 有界 `diagnostics`），成败只由
   exit code / `turn.failed` / `turn.completed` / 终值文件决定。真致命错误必然伴随缺终态或非零退出，那里才 fail-closed。
   已加回归测试（噪声 + 完整终态 = 成功；噪声 + 缺终态 = 失败）。
2. **超时被误判为用户取消**：引擎只在 `kind.execute` **resolve** 后检查 `timedOut`（`engine.js:344`），
   而外部路径在 abort 时抛 `'运行已取消'`，被 `engine.js:374` 当成用户取消 → 终态 canceled 而非超时。
   → 改为：abort 时**返回部分结果交回引擎分类**（`if (result.canceled) return {output, ...details}`），
   由引擎按 `timedOut` / `run.canceled` 分别抛「节点超时（Ns）」或「运行已取消」。

### 14.3 P1 本机真跑验收结果（dsh 0.2.2-rc.5，隔离 profile 端口 4032）

| 验收项 | 结果 |
|---|---|
| codex 节点真跑 | success；`runtime:"codex"`、`model:"codex:(CLI 默认)"`、turns=1、usage `{inputTokens:43939,outputTokens:315}`、artifacts `["report.md"]`、下游 output 节点拿到答案 |
| 轨迹 | 6 entries：`input, inject, inject, assistant, tool:bash(带 result), assistant` |
| 结构化输出 | codex 原生 `--output-schema` → 合法信封（含 schema）、`structuredMeta:{repaired:false,validationErrors:[]}`、下游拿到 JSON |
| 用户取消 | 终态 canceled；`ps` 精确复核**零 sleep 残留** |
| 节点超时 | `timeoutSec:35` → durationMs 35527、error「节点超时（35s）」、**零残留** |
| requireArtifact 无产物 | codex 真跑但未写文件 → **error 不判绿**，文案「节点要求交付物（requireArtifact），但本次未产出新的非空文件」 |
| 非法 / 未交付 runtime | `pi` 缺模型、`bogus` 未知 id → lint **error 拒绝启动**，不回退 dsh |
| `/wf1/api/runtime-config` | 保留旧 `runtime` 字段；`runtimes` 给出 codex 可用+版本、claude/pi `not-delivered`；不回显 bin 路径 |
| 前端（官方 UI 内嵌画布） | 下拉四项：dsh / `codex · codex-cli 0.170.0`（可用）/ claude、pi（尚未交付，禁用）；externalModel 输入、requireArtifact 勾选、节点超时、能力差异提示齐全；dsh 专属「工具/技能/模型与轮次」分区正确隐藏；节点渲染 `codex` 徽标 |
| 配置持久化 | UI 保存后图 API 返回 `runtime:'codex'`、`externalModel:'gpt-6.2-sol'`，瞬态 `runtimeModel` 未写入 |
| 回归与构建 | `npm test` 全量通过（orchestrator 19 套，含新增 `runtime-cli` 21 例 / `runtime-adapters` 17 例）；`build-web.sh` 双构建 + `build-canvasui.sh --check` 通过 |

### 14.4 P1 未覆盖 / 遗留

- **claude（P2）与 pi（P3）adapter 未实现**，前端已列出但禁用；pi 服务端 opt-in 门禁随 P3 交付。
- 独立画布页 `/wf1/`（无宿主注入 session）所有 scoped 请求 409 → runtime 下拉只剩 dsh。这是既有设计（画布需宿主注入会话），
  不是本次回归；内嵌画布一切正常。评审建议的「409 后待 session 到达重取」对独立页无意义（永远拿不到 session），故未实现。
- stall 看门狗按 §7.7 未启用，外部 runtime 只有节点总超时兜底（已在 UI 与 lint 明示）。
- 真跑验证在会话工作区 `/Users/goku/code/简历` 留下 5 条测试运行记录与一个 codex 测试节点（该 `.workflow-one` 是用户 11-13 既有数据，未被破坏）；需按需清理。

### 14.5 用户真跑失败复盘（第三个真跑缺陷，已修）

用户在画布真跑报 `RUNTIME_EXIT_NONZERO`（24.2s、过程 0、成果 0），UI 只给错误码不给原因。
直接跑 codex 取证发现：**真失败原因是顶层 `{"type":"error","message":"Reconnecting... n/5 (503 No available channel …)"}` 事件**，
既不是 `item.completed{type:error}`，也不在 stderr（stderr 只有 "Reading prompt from stdin..."）。
原适配器把顶层 error 当未知事件静默丢弃 → 失败文案只剩退出码。

修复：
- 顶层 `type:"error"` 进 `inject` 轨迹 + 有界 `diagnostics` + `acc.lastProtocolError`；不单独判致命（codex 可重连恢复），
  但失败文案（EXIT_NONZERO / NO_TERMINAL / EMPTY_RESULT）带上它。
- 非 JSONL 的 stdout 行保留为 `stdoutPlainTail`（有界），stderr  likewise；两者经 `redactSecrets` 脱敏后
  进错误文案与运行记录 `details.stderrTail / stdoutPlainTail`（各限 1200 字）。
- 回归测试：503 顶层 error + 非零退出 → 文案含 503 与 No available channel；503 后重连恢复 + 完整终态 → 仍判成功；
  非 JSONL stdout 诊断；redactSecrets 抹掉 Bearer/api_key/sk-/export KEY。

复验：坏模型试运行现在返回
`codex 退出码 1：unexpected status 503 Service Unavailable: No available channel for model … | Reading prompt from stdin...`。
结论：用户那次是 provider 侧真实失败（503/无可用通道，重连耗尽后退出），节点判失败是**正确行为**；
缺陷在于此前不可诊断，现已可诊断。另：该图里「工单整理」为 dsh 底座节点，在验证实例上因 `platform` 渠道未配而失败
（`no adapter registered for provider "platform"`），属实例配置问题，与 runtime 功能无关。

## 15. P2/P3 交付状态与未决问题（2026-11-19 续）

### 15.1 已交付并验证
- **节点 runtime 图标**：`RUNTIME_ICONS`（codex=终端符 / claude=星芒 / pi=π）经 registry `headExtra` 挂到节点头部类型图标旁，徽标内也带图标；内嵌画布实测三者互不相同、切换 runtime 实时生效，dsh 节点不挂图标。
- **P2 claude 适配器**：stream-json 事件投影、tool_use/tool_result 配对、增量只进预览、`--json-schema` 原生结构化（实测 result.result 即 schema JSON）、permission_denials 非空判失败、缺终态/空结果/非零退出判失败。36 例适配器单测含 claude。
- **P3 pi 适配器 + 服务端门禁**：`Config.enablePiRuntime` 默认 false；未启用时 runtime-config 标 `disabled-by-host`、执行抛 `RUNTIME_NOT_AUTHORIZED`（单点覆盖所有执行入口）；启用后真跑产生 turns/产物。pi 终态以 agent_end+agent_settled+最终 stopReason 判定（exit=0 不可信）。
- **claude 无 tty hook 阻塞**：实测用户 SessionStart hook 在无控制终端时阻塞 claude（dsh 生产无 tty）；加 `--settings {"disableAllHooks":true}` 后无终端独立跑成功。无人值守委派默认关用户 hooks。
- **claude Bash 显式授权**（历史交付，已被 §17 runtimePermission 取代）：acceptEdits 不放行 Bash（实测模型反复试 Bash 被拒空转）；新增节点级 `claudeAllowBash`（默认关）→ `--allowedTools Bash`，lint/UI 警告无命令级边界。
- **node/test 超时误报 ok:true 修复**：试运行不走引擎 run 循环，外部 runtime abort 时 resolve 部分结果会走 success 分支；现拦截 testTimedOut/signal.aborted 返回 ok:false。

### 15.2 内嵌空转两项根因与复验（2026-11-19 晚，均已修复）
1. **claude 内嵌挂起/空转**：逐层取证定位到三个叠加原因，均已修复——
   - 启动拉用户全局 mcpServers（npm exec @playwright/mcp@latest、uvx minimax 等需联网安装/初始化），等就绪即停住 → `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` 不继承环境 MCP；
   - 共享 persona「可直接读取工作区已有文件」引导模型探索 .workflow-one 里别的节点产物（thinking 实测在推理其他节点、写工作流模板文件）→ 外部 runtime 的 cwdLine 收紧为「只处理本任务，不探索工作区/不读 .workflow-one 与其他节点输出目录」；
   - 最后一轮「空转」实为验证 fixture 问题：node/test body 漏传 upstreamOutputs，任务正文是未渲染的 `{{node["up"].data}}` 字面量，thinking 明确「任务定义缺失，不能编造任务」而 deliberating 到超时——非适配器缺陷（node/test 的上游输入本就靠手填假输入注入）。
   **复验**：自包含任务 node/test ok:true，20.3s / turns 2 / report.md 落盘内容正确 / result success / exit 0。
2. **pi 空转不产出**：pi 启动连用户 mcp.json 与 orca 等扩展，往生命周期注入干扰（多轮不产出）→ `--no-mcp --no-extensions`。**复验**：airouter/glm-5.3-flash node/test ok:true，11.3s / turns 2 / report.md 落盘内容正确 / agent_end+agent_settled / exit 0。
3. 调试插桩 `WF1_RUNTIME_DEBUG`（gated `[rt-debug]` spawn/frame/exit 日志）保留：本轮两次根因定位均靠它，默认关闭零开销，供后续现场诊断。
4. 教训：外部 runtime 的验证 fixture 必须自包含任务正文或显式注入 upstreamOutputs；未渲染占位符会被模型当成「任务缺失」而非指令。

## 16. 设置面板「本地执行底座」引导卡片（2026-11-19，用户选定：pi 页面一键开关）

### 16.1 意图
用户装好 codex/claude/pi 后不知道去哪启用、怎么用。在 dsh 设置面板「Workflow One」（canvasui `WorkflowOneSection`）加一张引导卡片：探测状态一目了然、未安装给安装命令、pi 给一键启用开关（带无沙箱警示），取代「改 YAML + 重启」的手工路径。

### 16.2 方案与取舍
- **选定**：pi 门禁双源 = 部署级 `config.enablePiRuntime`（YAML，保留兼容）OR 用户级 `runtime-settings.json` 开关；设置页开关即时生效（每次执行/探测现读存储，无需重启）。
- 否掉「只读引导 + YAML 片段」：启用仍是手工活，不符合「友好引导」。
- 否掉并入 `agent-defaults.json`：该 PUT 是整体替换且由 AgentDefaultsCard 独占写入，两卡片共写会互相覆盖。
- 不做：页面内试运行（需工作区上下文）、自动安装 CLI、代管各 CLI 登录。

### 16.3 后端
- 新存储 `~/.dsh/plugin-data/dsh-ccpg-orchestrator/state/runtime-settings.json`：`{version:1, enablePiRuntime:boolean}`，默认 false；原子写 + 0600 与 agent-defaults 同款；损坏回退默认。
- 门禁两处（执行入口 / runtime-config）改读有效值 = config OR 用户开关；错误文案指向设置面板。
- `/wf1/api/runtime-config` 改 `scoped:false`（handler 本就不碰工作区；设置面板无会话，与 system/info 先例一致）；支持 `?refresh=1` → `clearProbeCache()` 后重探；响应顶层加 `enablePiRuntime`（有效值）。
- 新路由 `PUT /wf1/api/runtime-settings`（scoped:false）：只收 `{enablePiRuntime:boolean}`，写入后返回与 runtime-config 同形 payload。

### 16.4 前端（canvasui，自包含不跨插件导入）
- `WorkflowOneSection` 在 AgentDefaultsCard 后插入 `RuntimesCard`：三行（codex/claude/pi），内联 SVG 图标与 web 注册表同款形状；状态徽标（已就绪 v… / 未安装 / 探测失败 / 未启用）。
- 未安装 → 可复制安装命令（本机核实：`npm i -g @openai/codex` / `npm i -g @anthropic-ai/claude-code` / `npm i -g @earendil-works/pi-coding-agent`）+ 「装完点刷新」。
- 已就绪 → 一句话引导「在节点面板『执行底座』选用」；claude 注明 Bash 默认不放行（节点级 claudeAllowBash）；pi 注明模型须 provider/model 且无沙箱。
- pi 开关：两步确认（复用升级按钮 confirming 模式）+ 警示文案「pi 无沙箱：将以你的用户权限全自动执行命令与读写文件」；关闭无需确认。
- 刷新按钮 → `?refresh=1`。首次使用提示：各 CLI 需先在终端完成自己的登录/鉴权。
- NodePanel `disabled-by-host` 文案改指「dsh 设置 → Workflow One → 本地执行底座」（reason code 不变，兼容既有测试）。

### 16.5 验证
- 单测：存储归一化/损坏回退、门禁双源四象限、runtime-config 无会话可达 + refresh、PUT 形状校验；canvasui client 测试加卡片渲染/开关流。
- 真跑：4032 实例设置页点到卡片（浏览器实测）；开关关→pi node/test 拒（RUNTIME_NOT_AUTHORIZED）→页面开→pi node/test 成功，全程不重启。
- 全量 npm test + build-web.sh + build-canvasui.sh --check。

### 16.6 风险
- runtime-config 放开无会话后暴露面 = CLI 安装状态（与 system/info 同级），不含工作区数据/凭据。
- 用户开关与 YAML 同权：部署方若需强制禁用 pi，不能只靠 YAML false（用户可自行开）——当前无此需求，YAML true 仍是强制开。

## 17. 节点级权限模式选择（2026-11-19，用户指令：到底是不是全权限，要给用户选择）

### 17.1 意图与决策
原设计钉死受限 posture、不提供全权限开关；用户明确要求把选择权交给使用者。改为：**默认受限不变，节点级显式可选全权限，UI 带警示**。与 dsh 会话「访问模式/完全权限」的产品先例一致。信任决策属于具体任务，故放节点级（与 externalModel/timeoutSec 同层），不做全局默认（避免第二事实源；需要时后加）。

### 17.2 各 runtime 的选项（本机 help 已核实 flag 值域）
- **codex** `runtimePermission`：`sandbox`（默认，`-s workspace-write`）| `full`（`-s danger-full-access`，警示：不限写范围/可联网/以用户权限执行）。read-only 不提供（写不了产物，requireArtifact 必失败，徒增困惑）。
- **claude** `runtimePermission`：`restricted`（默认，acceptEdits、Bash 拒）| `bash`（acceptEdits + `--allowedTools Bash`，警示：无命令级边界）| `full`（`--permission-mode bypassPermissions`，警示：全部工具全自动）。**替代未发布的 claudeAllowBash**（同分支未合并，直接重构无兼容负担）。bypassPermissions 已本机取证：headless 单独该 flag 即放行 Bash（/tmp/wf1-runtime-probe/ws-perm-test/out.jsonl：Bash tool_use 1 次、result.txt=hello-perm、result success、exit 0、14.8s），无需额外 flag；交付前仍按 §17.3 走 node/test 全链路复验。
- **pi**：无选项（无沙箱能力），恒全权限；准入仍由 enablePiRuntime 门禁（§16 开关）+ 卡片/节点警示。

### 17.3 改动面
- 适配器 buildSpawn 按 runtimePermission 映射 flag（默认值逐字保持现行为）；未知值 fail-closed 抛 RUNTIME_BAD_PERMISSION。
- NodePanel「执行底座」：claudeAllowBash  checkbox 换为 runtimePermission select（选项随 runtime 变）+ 对应警示文案；pi 显示「无沙箱·全权限」只读说明。
- engine lint：full/bash 警告（沿用 claudeAllowBash warn 位置）；assistant 契约行同步。
- 设置卡片（§16）每行标注 posture + 「节点级可选全权限」。
- 单测：三 runtime × 各模式 flag 映射 + 默认不变 + 非法值拒绝；lint 警告；web 面板测试同步。
- 真跑：codex full / claude bash / claude full 各一次 node/test 取证（claude full 验证 Bash 真放行）；受限默认回归一次。

### 17.4 风险（如实告知用户）
full 模式下模型以 dsh 用户权限全自动执行：可写工作区外、可联网、可删改用户文件，persona 软约束不构成边界。选择即承担；默认受限 + 显式警示 + 运行记录留痕（details 记 runtimePermission）。

## 18. codex 评审处置与授权机制（2026-11-19，覆盖 §16/§17 对应条款）

评审 9 项发现全部对代码取证属实，无驳回项。处置如下，本节为权威修订。

### 18.1 Blocker：高权限必须经执行者授权（新增授权机制）
问题：runtimePermission 存节点数据，lint warn 不阻断运行；导入图/助手图可携带 full/bash，由手动/助手/trigger/schedule 执行，执行者可能从未知情。节点数据本身不能充当授权证据。
机制（运行期单点授权，覆盖所有路径，不做导入/助手侧钩子——单一 choke point 更简且无绕过）：
- **elevated 定义**：codex full；claude bash|full。pi 另由实例级门禁管（开关警示文案明确：开启后所有工作流含定时/触发的 pi 节点均可全权限执行）。
- **grant 存储**：工作区级 `.workflow-one/state/runtime-grants.json`（与 triggers.json 同目录先例）：`{version:1, grants:{[workflowId]:{elevated:{[nodeId]:{runtime,permission}}, grantedAt}}}`。
- **服务端校验**：所有正式运行在 `startRun` 计算当前 elevated 集合，覆盖草稿、助手、定时、补跑、子工作流、webhook、回放和续跑。找不到逐节点精确匹配（nodeId→{runtime,permission}）的 grant 时，返回 `RUNTIME_PERMISSION_UNGRANTED`（附节点清单与 `grantRevision`）。高权限集合变更后需重新确认，其他编辑仍可沿用授权。
- **授权 API**：`POST /wf1/api/runtime-grant` 接受 `{workflowId, grantRevision}`（scoped，带 §18.5 Origin 防护）。服务端从已保存图重算 elevated 集合及摘要，摘要一致才写入授权，否则返回 409。
- **画布 UX**：startRunFlow 收到 RUNTIME_PERMISSION_UNGRANTED → 确认弹窗逐节点列 label/runtime/模式/风险 → 「授权并运行」= POST grant + 重试启动；取消则中止。助手/自动路径无 UI → 拒绝并提示「到画布运行一次以授权」。
- **node/test**：elevated 节点须 body.confirmPermission===true（试运行弹窗展示警示+勾选）；无持久 grant，每次试跑各自确认。
- 助手契约补充：elevated 节点运行前需用户授权，助手不得代为 grant。

### 18.2 Major 处置
- **跨底座切换**（NodePanel.jsx:604 取证：现仅清 externalModel）：切换 runtime 同时清 runtimePermission，新底座回默认；面板测试覆盖 full→codex、bash→codex、→pi→切回。
- **门禁三态响应**：runtime-config 返回 `enablePiRuntime`(有效) + `piUserEnabled` + `piDeploymentEnabled`；开关绑 user 值；deployment=true 时显示「部署级强制启用」说明。测试四象限 + YAML 开时关开关。
- **画布状态同步**：App.jsx window focus 时重取 runtime-config（服务端执行校验仍是最终兜底）；测试覆盖设置页开关后画布无需重载。
- **探测竞态**（runtime-cli.js:219 取证：clearProbeCache 不清 in-flight，旧 Promise 会回写缓存）：加 generation 计数；refresh=1 → gen++ 并清缓存；in-flight 去重按 (id,gen)；remember 仅在 gen 仍当前时写缓存。测试：可控延迟探测，旧请求晚于新请求结束不得覆盖。
- **留痕全覆盖**（index.js:1456/1535 取证：fail() 与 details 均无权限字段）：分派顶部解析**实际生效** permission（codex 默认 sandbox / claude 默认 restricted / pi 恒 full），贯穿 fail().nodeDetails、details、node/test 响应；非法值记原始值+拒绝原因，不记为已生效。每次运行快照，不以全局值事后推断。

### 18.3 Minor 处置
- **pi 安装态与准入态分离**：runtime-config 对 pi 始终探测安装态；条目加 `installed`/`version`，`available` 仍表示「现在可执行」（未启用=false+reason disabled-by-host），卡片用 installed 显示安装命令。修订原「不暴露未启用能力」注释：安装态非能力暴露，执行门禁不变。
- **写路由边界**（取证：register scoped:false 无统一异常兜底；dsh webserver/app-boot/remote-access 均无 handler 路由级 Origin/Sec-Fetch/CSRF 校验，无 token curl 得 409 非 401）：PUT runtime-settings 只收普通对象且恰含布尔 enablePiRuntime（拒数组/缺字段/额外字段/非布尔），非 PUT 405，handler 自带 try/catch（readBody/归一化/I/O 分别 400/500）。**新增写路由（runtime-settings PUT、runtime-grant POST）自带 Origin/Sec-Fetch 防护**：Origin 存在且不等于本服务 origin → 403；Sec-Fetch-Site=cross-site → 403；无 Origin 的 loopback 请求放行（本地 CLI）。其余既有写路由的同类暴露为**既有问题**，记为后续跟进，不在本次静默扩大改动面。
- **受限表述精确化**：UI/文档按 runtime 列实际 flag 与已验证行为，不宣称统一工作区隔离。验证计划补：claude acceptEdits 写 cwd 外是否被拒（真跑取证）；codex -a never + danger-full-access 端到端；claude full + --json-schema 共存。

### 18.4 替换完整性与一致性（C/D/F）
- runtimePermission 校验**单点在分派层**（runExternalAgentNode 顶部）：undefined/空串→默认；非字符串或未知非空值→RUNTIME_BAD_PERMISSION（fail-closed）；适配器保留防御性校验但非唯一门禁。pi 忽略携带值、留痕 full。
- claudeAllowBash 全引用替换：分派参数、claude 适配器、engine lint、NodePanel 控件/文案、适配器测试；§15.1 标注「已被 §17 取代」；§16.4 文案同步；assistant.js 契约补 runtimePermission 值域与授权语义。变量树/preset/徽标无引用（已 grep）。
- claude full 只替换 --permission-mode 值，不重复传 mode；--json-schema 位置不变；bash 模式 --allowedTools Bash 仍末尾。默认 argv 逐字不变。

### 18.5 验证计划（合并 §16.5/§17.3）
单测：grant 存储/精确匹配/失配重确认、startWorkflowRun 拒未授权、node/test confirmPermission、探测 generation 竞态、门禁三态四象限、PUT 形状/方法/Origin 防护、permission 单点校验全值域、留痕全路径、切换清字段。
真跑（4032）：设置卡片浏览器实测；pi 关→拒→开→成功不重启；codex full / claude bash / claude full（含结构化）/ claude acceptEdits 越界写 各一次 node/test；未授权图启动被拒→弹窗授权→运行成功→改 elevated→再拒。
全量 npm test + build-web.sh + build-canvasui.sh --check。

### 18.6 复验结果（2026-11-19 晚，4032 实例真跑 + 浏览器实测，全部通过）
- 设置卡片：三行状态/版本/posture/安装命令/刷新渲染正确；pi 两步确认（再点一次+无沙箱警示含定时触发）→「已开启」；三态响应（user/deployment/effective）正确。
- pi 门禁全链路：部署级关→node/test 拒（文案指设置面板）→页面开→node/test ok 10.6s **不重启**→API 关→再拒。PUT 非法形状 400 / GET 405 / Sec-Fetch-Site cross-site 403 / 异源 Origin 403。
- 权限真跑：codex full（argv 取证 -s danger-full-access，17.5s ok，响应带 permission:'full'）；claude bash（正式运行 trace 取证 Bash tool_use 实跑 echo $((6*7))，calc.txt=42，运行记录 permission:'bash'）；claude full+--json-schema 共存（结构化 {ok:true}）；claude restricted 越界写 /tmp 被 permission_denials 拒、文件未落盘（acceptEdits 写边界=cwd 实证，minor 9 闭环）。
- 授权流：未授权 /workflows/run 拒 RUNTIME_PERMISSION_UNGRANTED → 跨站 grant 403 → grant 落盘 → 启动 success → 升级 bash→full 再拒（grant 精确匹配失配）。画布弹窗渲染节点清单/风险/定时触发声明，「授权并运行」→ grant+手动运行 success。elevated 试运行无 confirmPermission 拒。
- 画布 focus 同步：API 开 pi 后 canvas window focus → pi 选项即时可选，无需重载。
- 失败留痕：node/test catch 分支补 permission 透传（复验：越界写超时失败响应带 permission:'restricted'）。
- 回归：npm test 全绿（含新增 runtime-settings-grants / runtime-permission / probe 竞态 / 适配器权限映射用例）+ build-web.sh 双构建 + build-canvasui.sh --check 无漂移。
- 测试脚本教训（非产品缺陷）：API 建图须带 position（否则画布 React Flow 崩）；POST /workflows 更新须带 id（否则新建）；runs/detail 参数是 id 非 runId。画布对无 position 图的崩溃为既有健壮性缺口，记后续跟进。
