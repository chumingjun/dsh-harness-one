# System One 轻判断节点 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `systemone` 节点 kind：调本地 Ollama 判断模型（pplx-decider-flash）做是否/分类/评分三种轻判断，节点自带三路分流，判决卡展示完整概率分布。

**Architecture:** 客户端核心逻辑放 `lib/systemone.js`（纯函数 + fetch，可 mock 测试）；engine.js 注册薄 kind（execute/lint/edgeTaken 委托）；endpoint/model 只走部署级 Config 注入（`engine.systemone`），节点 data 不含地址。前端复用现有 Section/TemplateEditor/chips 交互，新增判决卡组件与纯逻辑 helper。

**Tech Stack:** Node ≥22.15 内置 fetch；零依赖 node:assert 测试；React 18 + @xyflow/react（现有画布栈）。

**Spec:** 本文档「设计契约（修订版）」一节即规格——源自 2026-11-19 会话的设计轮 + 审核轮，审核修复 #1–#11 已全部并入。实测事实：本地 endpoint `POST http://localhost:11434/v1/systemone`，noul 回 `{noul:0.99}`，choice 回 `{choice,probabilities,confidence}`，score 回 `{score,legend,probabilities,confidence}`，usage 为 snake_case，热调用 ~0.5s、冷启动 ~5s。

## Global Constraints

- 测试全部零依赖 node:assert 脚本，`node <file>` 直跑；不新增任何 npm 依赖
- 注释、UI 文案、提交信息用简体中文；Conventional Commits，scope 用 `orchestrator` / `web`
- 双端注册铁律：engine `registerKind` + `web/src/registry.jsx` + `assistant.js`（NODE_TYPES + persona）+ `variable-schema.js`，外加 `output-contract.js` fields——五处一个不能少
- endpoint/model 只做部署级 Config 字段，**绝不进节点 data**（画布/导入图/助手补丁无 SSRF 面）
- 构建产物不入库；前端构建必须 `sh dsh-plugins/build-web.sh`（双 base）
- 本机 git 被 Rosetta/xcrun 卡死：所有 git 命令用 `arch -arm64 /usr/bin/git` 前缀
- 工作目录：`/Users/goku/code/harness-one-systemone-node`（feat/systemone-node，基于 main 7f291a9）；主工作区的 agent-local-runtimes 未提交改动与本任务无关，不得混入

## 设计契约（修订版）

### 节点 data 字段（三模式共享 state，切模式不清空任何字段）

```
mode: 'noul'|'choice'|'score'（默认 noul）
state: string          // 判断依据模板，空 = '{{$upstream}}'
statement: string      // noul 判断语句
trueCriteria / falseCriteria: string   // noul 可选真例/假例
yesThreshold / noThreshold: number     // 默认 0.7 / 0.3，undefined 时用默认
instructions: string   // choice 问题 / score 维度（共享字段）
options: [{name, description}]         // choice，2–255 个
levels: [string]                       // score，2–10 档，低→高
```

### 输出 data 契约（修复 #1：唯一版本，五处消费方都按这个写）

- noul: `{mode:'noul', verdict:'yes'|'no'|'unsettled', value:<0–1>, unsettled:<bool>}`
  ——API 只回概率，**不发明** probabilities/confidence
- choice: `{mode:'choice', verdict:<选项名>, probabilities:{名:概率}, confidence:<num>}`
- score: `{mode:'score', value:<连续分>, probabilities:{档索引:概率}, legend:{档索引:描述}, confidence:<num>}`
- state 截断时追加 `stateTruncated:true`
- 阈值语义：`value > yesThreshold` → yes；`value < noThreshold` → no；**压线（恰好等于）= unsettled**
- 文本输出首行稳定 token（condition 关键词匹配可兜底）：`是 0.99` / `否 0.12` / `待定 0.50` / `refund 0.82` / `评分 0.95/2`；后续行给语句/逐选项/逐档概率
- 边 branch key = verdict 原值（'yes'/'no'/'unsettled'/选项名）；UI 标签中文（是/否/待定）

### 分流语义（修复 #2/#3/#7）

- `edgeTaken`：边无 branch → 放行；structuredOutputs 里**拿不到 verdict → 全部放行**（continueOnFail 容错收尾是文本 envelope，不能把下游断流）；有 verdict → `String(verdict) === String(branch)`
- score 模式无 verdict → 天然全放行（不分流）
- lint 交叉校验：有带 branch 的出边时，branch 必须 ∈ 当前判决集（noul: yes/no/unsettled；choice: 当前选项名），否则 **error**（选项改名 = 静默断流的防线）
- lint warn：某判决（含 unsettled、每个选项）没有出边且节点已有分流意图（存在带 branch 出边）→「判决 X 没有出边，命中时下游将跳过」；score 节点带 branch 出边 → warn「评分节点不分流」

### 信任边界（修复 #4/#9）

- 选项名禁 `__proto__`/`prototype`/`constructor`、空名、重名（lint error）；criteria 用 `Object.fromEntries` 构造，绝不 `obj[name]=` 赋值
- 渲染后 state 上限 32000 字符，超出截断 + 输出标记（`shortcut:` 注释注明上限待实测校准）

### 宿主接线（修复 #5/#8）

- `Config` 加 `systemoneUrl`（默认 `http://localhost:11434/v1/systemone`）、`systemoneModel`（默认 `pplx-decider-flash`）
- `orch.systemone = {url, model}` 注入（照 scriptRunner 的样子）；**orchLike 镜像同一引用**（试运行校准循环的命门）
- `node/test` 响应补 `usage` + `durationMs`（execute 前后 Date.now 差）
- usage 映射 camelCase：`{inputTokens, outputTokens, cacheReadTokens?}`（源 `input_tokens/output_tokens/prompt_eval_cached_count`），UsageMeta 直接可渲染

### 错误文案（修复 #10：引擎只认 kind 级 retryable，不做 per-error 重试承诺）

| 情况 | 文案要点 |
|---|---|
| 连接失败 | System One 不可用：无法连接 <url>。先确认 Ollama 已启动（ollama serve） |
| HTTP 404 / model not found | 模型 <model> 未安装：ollama pull <model> |
| 其他 HTTP 错误 | System One 返回 HTTP <status>：<body 前 120 字> |
| 畸形响应 | System One 响应缺少判决 / choice 不在选项集内 |
| 超时/取消 | 走引擎现有分类，不新写 |

### 状态探针（修复 #11）

- `GET /wf1/api/systemone/status` → 用 `new URL(url).origin + '/api/tags'` 查模型列表（**不 POST 判断**，避免触发模型加载），2s 超时
- 返回 `{ok:true, available, model?, reason?}`；前端 NodePanel 打开时 one-shot 探测，绿点「就绪」/灰点 + reason 指路

### 画布 UX（修复 #6）

- 边标签按源节点类型映射（condition: true/false→是/否；systemone noul: yes/no/unsettled→是/否/待定；choice: 选项名原样）——替换 App.jsx 硬编码三元
- 连线面板 chips：systemone 源 → 判决集 + 「不限」（清除 branch）；自动分配：noul 按 yes→no→unsettled 补未用分支，choice 按选项顺序
- 虚线样式：branch ∈ {false, no, unsettled}
- **EdgeLine.jsx 零改动**（泛型渲染 label）
- 节点形象：label「轻判断」，仪表盘 SVG 图标（stroke 1.8），玫红 `--type-systemone`（暗 #EC4899 / 亮 #DB2777）

### 本期不做

gate/verify/screen 否决类（本地 wrapper 没有这三个工具，另接 jev-local 是下期）；双峰检测算法（分布摆出来人自己看）；状态条轮询（one-shot 足够）；per-error retryable。

## Review Focus

1. **Ollama 挂 + continueOnFail**：下游必须照常执行（edgeTaken 缺 verdict 全放行）→ Task 1 测试
2. **选项改名后旧 branch 边**：lint 必须 error，绝不静默 skipped → Task 1 测试
3. **恶意导入图**：`__proto__` 选项名 / 300KB state / NaN 阈值 → lint error + 截断，Object.prototype 零污染 → Task 1 测试
4. **压线概率 0.7/0.3**：必须 unsettled，不是 yes/no → Task 1 测试
5. **同图两个 systemone 节点并发**：判决按节点隔离，mock fetch 按请求体分发验证不串 → Task 1 引擎集成测试
6. **试运行路径**：orchLike 拿得到 endpoint、响应带 usage/durationMs → 单测覆盖不到 apply() 接线，Task 6 真 dsh 试跑验证

## File Structure

| 文件 | 责任 |
|---|---|
| Create `dsh-plugins/dsh-ccpg-orchestrator/lib/systemone.js` | 请求构造/响应整形/错误映射/lint/edgeTaken/探针（纯逻辑+fetch） |
| Modify `.../lib/engine.js` | constructor 加 `this.systemone=null`；http kind 后注册 systemone 薄 kind |
| Create `.../test/systemone.test.mjs` | lib + kind + 契约注册全部断言 |
| Create `.../test/systemone.live.mjs` | 真实 Ollama 探针（不匹配 *.test.mjs，CI 不跑） |
| Modify `.../lib/index.js` | Config 两字段；orch 注入；orchLike 镜像；node/test 响应 meta；status 路由 |
| Modify `.../lib/assistant.js` | NODE_TYPES + persona 节点描述 + PATCH_HINTS |
| Modify `.../lib/variable-schema.js` | STATIC_DATA_SCHEMAS.systemone |
| Modify `.../lib/output-contract.js` | describeNodeOutput fields |
| Create `web/src/systemone-view.js` + `.test.mjs` | 边标签/chips/自动分配/概率排序纯逻辑 |
| Create `web/src/SystemOneVerdict.jsx` | 判决卡（noul 刻度条/choice 条形/score 分布） |
| Modify `web/src/registry.jsx` + `styles.css` | 节点条目 + 图标 + 玫红变量 + 判决卡样式 |
| Modify `web/src/NodePanel.jsx` | 三模式表单 + 状态条 + sec-result 判决卡 |
| Modify `web/src/TestRunModal.jsx` | 结果区判决卡 |
| Modify `web/src/App.jsx` | 边标签映射/chips/自动分配/虚线/updateEdgeBranch 清除 |

---

### Task 1: 客户端核心 + 引擎 kind

**Files:**
- Create: `dsh-plugins/dsh-ccpg-orchestrator/lib/systemone.js`
- Modify: `dsh-plugins/dsh-ccpg-orchestrator/lib/engine.js`（constructor ~84-95；http kind 结束 ~730 后插入）
- Test: `dsh-plugins/dsh-ccpg-orchestrator/test/systemone.test.mjs`

**Interfaces:**
- Produces（Task 2/3/4/5 全部按此消费）:
  - `SYSTEMONE_MODES = ['noul','choice','score']`；`MAX_STATE_CHARS = 32000`
  - `buildSystemOneQuestion(mode, rendered)` → `{type, instructions, criteria?}`；rendered = `{statement, instructions, trueCriteria, falseCriteria, options:[{name,description}], levels:[string]}`（均已模板渲染）；noul 的 questions key 用 `judgment`，其余用 `answer`（与实测 wrapper 一致）
  - `callSystemOne({url, model, state, question, signal, fetchImpl=globalThis.fetch})` → `{answer, usage, cachedCount, model}`；失败按错误文案表抛 Error
  - `shapeSystemOneAnswer({mode, answer, d, rendered})` → `{data, output}`（契约形状 + 首行 token；畸形抛 Error）
  - `mapSystemOneUsage(usage, cachedCount)` → `{inputTokens, outputTokens, cacheReadTokens?}`
  - `lintSystemOneNode(node, lintCtx)` → issues[]（lintCtx.graph.edges 可用）
  - `systemOneEdgeTaken(s, node, edge)` → bool
  - `probeSystemOne({url, model, fetchImpl=globalThis.fetch, timeoutMs=2000})` → `{available, model?, reason?}`
  - engine kind `type:'systemone'`，execute 读 `engine.systemone = {url, model}`（Task 2 注入），返回 `{output, data, usage, model}`
- Consumes: engine 现有 `render(tpl, {implicitUpstream})`、`registerKind`、structuredOutputs envelope

- [ ] **Step 1: 写失败测试** `test/systemone.test.mjs`，用例（mock globalThis.fetch，按请求体分发）：
  - noul 契约：`data` 深等于 `{mode:'noul',verdict:'yes',value:0.9913…,unsettled:false}`；output 首行 `是 0.99`
  - 压线：value=0.7 → unsettled；0.3 → unsettled；0.71 → yes；0.29 → no；自定义阈值 0.9/0.1 生效
  - choice 契约：verdict='refund'、probabilities/confidence 透传；output 首行 `refund 0.82`；answer.choice 不在选项集 → 抛错
  - score 契约：value/probabilities/legend/confidence；output 首行 `评分 0.95/2`
  - usage 映射：`{input_tokens:93,output_tokens:0}` + cachedCount 7 → `{inputTokens:93,outputTokens:0,cacheReadTokens:7}`
  - state：默认取 `{{$upstream}}`；300KB 输入 → 截断 32000 + `data.stateTruncated===true` + 输出含截断标记
  - 错误：fetch reject（非 abort）→ 文案含 `ollama serve`；404 body 含 model not found → 文案含 `ollama pull`；500 → 文案含 `HTTP 500`；非 JSON / 无 answers → 抛错；AbortError 原样上抛
  - 污染：选项名 `__proto__` → lint error；合法 options 构造 criteria 后 `({}).polluted === undefined`
  - lint：statement 空 / options 1 个 / options 256 个 / levels 1 档 / levels 11 档 / 重名 / 空名 / 阈值倒置 / NaN → error；选项改名后旧 branch 边 → error；只接 yes/no 两边 → unsettled 缺路 warn；score 带 branch 边 → warn
  - edgeTaken：verdict=yes + branch=yes → true；branch=no → false；无 branch → true；structuredOutputs 缺失/文本 envelope → true；score → true
  - probe：tags 含 `pplx-decider-flash:latest` → available:true；不含 → reason 含 `ollama pull`；fetch reject → reason 含 `ollama serve`
  - 引擎集成：`new Orchestrator(null, {renderTemplate})` + `orch.systemone={url:'http://mock',model:'m'}`，图 input→systemone(noul)→[yes 边→outputA, no 边→outputB]，mock fetch 回 0.99 → outputA success、outputB skipped；同图第二个 systemone 节点回 0.1 → 各自判决不串
- [ ] **Step 2: 跑测试确认失败**：`node dsh-plugins/dsh-ccpg-orchestrator/test/systemone.test.mjs` → FAIL（模块不存在）
- [ ] **Step 3: 实现 `lib/systemone.js`**：按 Interfaces 签名；错误文案照契约表；criteria 一律 Object.fromEntries；32k 上限带 `shortcut:` 注释
- [ ] **Step 4: engine.js 注册薄 kind**：constructor 加 `this.systemone = null; // index.js 注入：{url, model}`；execute = 渲染各模板字段（implicitUpstream:false，state 空默认 '{{$upstream}}'）→ 截断 → buildQuestion → callSystemOne → shape → 返回 `{output, data, usage, model}`；`lint: lintSystemOneNode`、`edgeTaken: systemOneEdgeTaken`、`templateLintFields(node)` 返回 [state, statement, instructions, ...option descriptions, ...levels]
- [ ] **Step 5: 跑测试确认通过** + 回归 `node test/engine.test.mjs`、`node test/script-engine.test.mjs`
- [ ] **Step 6: Commit**：`feat(orchestrator): systemone 轻判断节点引擎 kind 与客户端核心`

### Task 2: 宿主接线 + 双端契约注册

**Files:**
- Modify: `.../lib/index.js`（Config 180-182；orch.scriptRunner 后 ~1204；orchLike 2181；node/test 2210-2229；status 路由加在 node/test 路由后）
- Modify: `.../lib/assistant.js`（NODE_TYPES 11；persona 节点描述 ~227 后；PATCH_HINTS）
- Modify: `.../lib/variable-schema.js`（STATIC_DATA_SCHEMAS ~7-22）
- Modify: `.../lib/output-contract.js`（describeNodeOutput ~141）
- Test: 追加进 `test/systemone.test.mjs`

**Interfaces:**
- Consumes: Task 1 全部导出 + `engine.systemone` 注入点
- Produces: `GET /wf1/api/systemone/status` → `{ok:true, available, model?, reason?}`；node/test 响应含 `usage`/`durationMs`；助手可 addNode type='systemone' 且 connect branch 透传；变量树 data 字段 = 契约六字段 + stateTruncated

- [ ] **Step 1: 追加失败测试**：validateGraphOps 接受 systemone addNode + connect branch='yes'；variable-schema 对 systemone 节点给出 mode/verdict/value/probabilities/confidence/unsettled 字段；describeNodeOutput fields 含契约字段
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 接线**：Config 加 `systemoneUrl: z.string().default('http://localhost:11434/v1/systemone')`、`systemoneModel: z.string().default('pplx-decider-flash')`；`orch.systemone = {url: config.systemoneUrl, model: config.systemoneModel}`；orchLike 加 `systemone: orch.systemone`；node/test 在 execute 前记 `testStartedAt`，成功响应加 `usage: r.usage, durationMs: Date.now()-testStartedAt`；status 路由调 probeSystemOne（GET only，方法守卫照现有路由）
- [ ] **Step 4: 契约注册**：assistant NODE_TYPES + persona 一段（三模式字段、阈值 0.7/0.3、三路分流范式：yes→业务、no→兜底、unsettled→agent 复核或 notify 人工）+ PATCH_HINTS（选项<2、档位<2、语句空、阈值倒置、分支不合法）；variable-schema systemone objectSchema；output-contract fields 行
- [ ] **Step 5: 跑测试通过** + 回归 `node test/assistant.test.mjs`、`node test/variable-system.test.mjs`（若存在）
- [ ] **Step 6: Commit**：`feat(orchestrator): systemone 宿主接线与助手/变量树契约注册`

### Task 3: 前端纯逻辑 + 节点注册 + 判决卡

**Files:**
- Create: `web/src/systemone-view.js`、`web/src/systemone-view.test.mjs`、`web/src/SystemOneVerdict.jsx`
- Modify: `web/src/registry.jsx`、`web/src/styles.css`

**Interfaces:**
- Consumes: Task 1 data 契约（verdict/value/probabilities/legend/confidence/unsettled）
- Produces（Task 4/5 消费）:
  - `edgeBranchLabel(nodeData, branch)` → string|undefined（condition/systemone/其他）
  - `systemOneBranchChips(nodeData)` → `[[value,label],…]`（noul: yes/no/unsettled→是/否/待定；choice: 选项名；score: []）
  - `nextSystemOneBranch(nodeData, existingBranches)` → value|undefined（按序补未用）
  - `sortedProbabilities(probabilities)` → `[[key,p],…]` 降序
  - `verdictTone(data)` → 'yes'|'no'|'unsettled'|'neutral'
  - `<SystemOneVerdict value usage durationMs model thresholds/>`（thresholds={yes,no}，默认 0.7/0.3）
  - registry 条目 type='systemone'，preset `{label:'轻判断', mode:'noul', state:'', statement:'', instructions:'', options:[], levels:[]}`

- [ ] **Step 1: 写失败测试** `systemone-view.test.mjs`：label 映射（condition true→是；systemone yes/no/unsettled→是/否/待定；choice 选项名原样；无 branch→undefined）；chips；自动分配（已有 yes/no → 下一条 unsettled；choice 按序；全用过 → undefined）；排序；tone（unsettled 优先于数值）
- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现 systemone-view.js** → **Step 4: 跑测试通过**
- [ ] **Step 5: registry 条目 + 仪表盘图标 + styles.css 玫红变量（暗/亮两套）+ 判决卡样式**；SystemOneVerdict.jsx：noul 大字判决 + 0–1 刻度条（阈值刻线 + 指针，是绿/否红/待定琥珀）；choice top 选项 + confidence + 降序条形列表（赢家高亮）；score 分值 + 逐档条形 + legend；meta 行复用 UsageMeta + durationMs + model；原始 JSON details 折叠
- [ ] **Step 6: 回归 web 全部测试**（`cd web && npm test`）
- [ ] **Step 7: Commit**：`feat(web): systemone 节点注册、分支纯逻辑与判决卡`

### Task 4: 配置面板 + 试运行集成

**Files:**
- Modify: `web/src/NodePanel.jsx`（http 段后加 systemone 段；sec-result ~888 区域）、`web/src/TestRunModal.jsx`（结果区 ~161-188）

**Interfaces:**
- Consumes: Task 3 SystemOneVerdict + registry preset；Task 2 status 路由 + node/test usage/durationMs
- Produces: 完整配置 UX（模式 select 切模式不清字段；state TemplateEditor 默认占位 {{$upstream}}；noul 语句 + 真/假例折叠 + 高级阈值；choice 选项行编辑器 name+description 增删；score 档位行 ↑↓ 增删；底部 SystemOneStatus one-shot 探针条）；试运行/最近运行两处判决卡

- [ ] **Step 1: NodePanel systemone 段**：照 condition/http 段的 Section/Field/TemplateEditor 用法；选项/档位行照 ScriptParameterRow 的行模式；阈值 input 占位 0.7/0.3（undefined 不写死进 data）；执行容错通用段自动获得（nodeType 不在排除名单）
- [ ] **Step 2: SystemOneStatus 内联组件**：mount 时 fetch apiUrl('/systemone/status')，绿点「本地模型就绪 · <model>」/灰点 + reason；请求失败静默灰点
- [ ] **Step 3: 判决卡接入**：TestRunModal result.ok && nodeType==='systemone' && structuredOutput.type==='json' → SystemOneVerdict（usage/durationMs/model 来自响应，thresholds 来自 node.data）；NodePanel sec-result 同条件用 d.runtimeStructuredOutput
- [ ] **Step 4: `sh dsh-plugins/build-web.sh` 双构建通过**（本任务无新纯逻辑，表单交互由 Task 6 CDP 实测覆盖）
- [ ] **Step 5: Commit**：`feat(web): systemone 配置面板、状态探针与试运行判决卡`

### Task 5: 画布分流 UX

**Files:**
- Modify: `web/src/App.jsx`（styledEdges label ~1672 + 虚线；chips 门 ~1910；自动分配 1193/1404；updateEdgeBranch ~2105 支持清除）

**Interfaces:**
- Consumes: Task 3 edgeBranchLabel/systemOneBranchChips/nextSystemOneBranch
- Produces: 三路拖线成型（第一条 yes、第二条 no、第三条 unsettled；choice 按选项序）；边标签中文；「不限」chip 清除 branch；无标签边全放行

- [ ] **Step 1: styledEdges**：源节点 Map 一次构建，label 走 edgeBranchLabel；strokeDasharray 条件扩为 ['false','no','unsettled']
- [ ] **Step 2: chips 门**：condition 保持原样；systemone → systemOneBranchChips + 「不限」（updateEdgeBranch(id, undefined) 清除 branch 并 markDirty）
- [ ] **Step 3: 两处自动分配**：condition 逻辑不动，systemone 源走 nextSystemOneBranch(源 data, 现有出边 branch 列表)
- [ ] **Step 4: web 测试回归 + build-web.sh**
- [ ] **Step 5: Commit**：`feat(web): systemone 三路分流画布交互`

### Task 6: 全量验证 + 真实环境

**Files:**
- Create: `dsh-plugins/dsh-ccpg-orchestrator/test/systemone.live.mjs`（真实 Ollama 三模式探针，文件名不匹配 *.test.mjs）

- [ ] **Step 1: 全量回归**：worktree 根 `npm test` 全绿（基线对照 Task 0 结果）
- [ ] **Step 2: 双构建**：`sh dsh-plugins/build-web.sh` 通过
- [ ] **Step 3: 真实探针**：`node test/systemone.live.mjs` 打真实 Ollama，三模式判决 + 耗时打印（冷启动首调 ~5s 属预期）
- [ ] **Step 4: 真 dsh 实测**：worktree 内 `sh dsh-plugins/setup.sh <独立 profile> <独立端口>`（不碰用户默认 dsh-ccpg/4021）→ start → CDP（playwright MCP + systemone-browser skill 做微判断）：添加轻判断节点 → 配 noul 语句 → 试运行出判决卡（验证 usage/durationMs 有值 = orchLike 接线成立）→ 拖三条出边验证自动 yes/no/unsettled + 中文标签 → 整图运行验证分流命中/跳过 → choice 选项改名验证 lint error  surfaced
- [ ] **Step 5: dsh 进程彻底 pkill 后再重启验证 HMR 不缓存**（仓库铁律）
- [ ] **Step 6: Commit**：`test(orchestrator): systemone 真实环境探针脚本`；汇报验证数字，等用户决定是否 push + PR

## Self-Review 记录

- 规格覆盖：设计轮 7 节（画布形象/配置面板/分流/试跑判决卡/错误态/可发现性/代码落点）→ Task 3/4/5/1/2 全映射；审核 #1–#11 → 契约节 + 对应 Task 测试
- 类型一致性：data 契约字段、lib 导出签名、view helper 签名在 Interfaces 钉死，跨 Task 引用同名
- Review Focus 六条各有归属测试（第 6 条明确归 Task 6 真机，不假装单测覆盖）
- 比例：计划 ~300 行 vs 预估实现 ~700 行，测试代码只写断言要点不写全文