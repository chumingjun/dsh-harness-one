# System One 设置卡片 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dsh 设置 → Workflow One 增加 System One 卡片：用户级服务地址/模型配置（空=跟随部署默认）+ 两段式测试连接（探针+冒烟判断），保存后无需重启即生效。

**Architecture:** 存储/归一化照 agent-defaults.js 范式（dsh 用户级 state、原子写、损坏回退空）；`orch.systemone` 永远是合并后的 effective 值（启动读存储合并，PUT 原地更新），引擎 execute 与 orchLike 每请求读它——天然热生效。测试端点组合现有 probeSystemOne + callSystemOne。卡片照 AgentDefaultsCard 的 draft/saved/dirty/消息行范式。

**Tech Stack:** Node ≥22.15 内置 fetch/AbortSignal.timeout；零依赖 node:assert 测试；canvasui 是 plain JS React.createElement（无 JSX），bundle 由 build-canvasui.sh 生成。

**Spec:** 2026-11-20 会话批准的设计（System One 设置卡片 · UX 设计）：两字段空=跟随部署默认、placeholder 显示部署默认、模型 datalist 来自探针、测试测草稿不强制保存门禁、改字段清测试结果、测试通过未保存标「尚未保存」、保存后自动重探状态点、失败分段指路（ollama serve/pull/超时重试）、画布状态条 reason 追加设置入口提示。安全边界：URL 只存在于用户级设置管理面，节点 data/导入图/助手补丁依旧无地址字段。

## Global Constraints

- 测试零依赖 node:assert，`node <file>` 直跑；不新增 npm 依赖
- 注释/UI 文案/提交信息简体中文；Conventional Commits，scope `orchestrator`/`canvasui`/`web`
- canvasui `lib/client.js` 是构建产物不入库，改 src 后必跑 `sh dsh-plugins/build-canvasui.sh`
- 前端构建走 `sh dsh-plugins/build-web.sh`（双 base）
- git 用 `arch -arm64 /usr/bin/git`（或 PATH=/tmp/s1-bin:$PATH）；npm 安装/构建用 `env -u npm_config_allow_scripts npm_config_userconfig=/tmp/s1-npmrc npm_config_globalconfig=/tmp/s1-global-npmrc`
- 工作目录 `/Users/goku/code/harness-one-systemone-node`（feat/systemone-node，HEAD 6ea3bc2）；dsh HMR 铁律：改插件后彻底杀进程再重启
- 不做：认证头字段、节点级覆盖、保存强制测试门禁

## Review Focus

1. 设置文件损坏/手改坏 → read() 回退空默认，启动不崩 → Task 1 测试
2. PUT 只填 url、model 留空 → model 必须回退部署默认，绝不能变成空串发请求 → Task 1 resolve/PUT 测试
3. 测试端点草稿 url 非法（非 http(s)/javascript:/乱串）→ 400 且不发起 fetch → Task 1 测试
4. tags 可达但模型未装 → stage:'probe' + reason 含 ollama pull + models 列表仍返回（datalist 可用）→ Task 1 测试
5. 卡片「测试通过但未保存」标注与「改字段清结果」→ canvasui mock react 无法测交互，归 Task 3 真机 E2E 点验

## File Structure

| 文件 | 责任 |
|---|---|
| Create `dsh-plugins/dsh-ccpg-orchestrator/lib/systemone-settings.js` | 归一化/URL 校验/原子写存储/effective 合并（纯逻辑+fs） |
| Modify `.../lib/systemone.js` | probeSystemOne 返回 models+ms；新增 testSystemOne 两段式组合 |
| Modify `.../lib/index.js` | 注入改存储合并；settings GET/PUT + test POST 路由；status 改读 orch.systemone |
| Create `.../test/systemone-settings.test.mjs` | 纯函数 + 路由接线全部断言 |
| Modify `dsh-plugins/dsh-ccpg-canvasui/src/client.js` | SystemOneSettingsCard + 挂载 + API 常量 |
| Modify `dsh-plugins/dsh-ccpg-canvasui/test/client.test.mjs` | 卡片存在性/关键文案字符串断言（现有惯例） |
| Modify `web/src/NodePanel.jsx` | SystemOneStatus 未就绪文案追加设置入口提示 |

---

### Task 1: 引擎——设置存储 + 两段式测试 + 路由接线

**Files:**
- Create: `dsh-plugins/dsh-ccpg-orchestrator/lib/systemone-settings.js`
- Modify: `.../lib/systemone.js`（probeSystemOne 尾部；文件尾加 testSystemOne）
- Modify: `.../lib/index.js`（import 58；注入 1210-1211；status 路由 2255-2259；新路由加在 status 后）
- Test: `.../test/systemone-settings.test.mjs`

**Interfaces:**
- Produces（Task 2/3 消费）:
  - `EMPTY_SYSTEMONE_SETTINGS = {url:'',model:''}`；`SystemOneSettingsError`（{code='invalid-systemone-settings', status=400}）
  - `systemoneUrlIssue(url)` → string|null（空→null；必须可解析且 http/https）
  - `normalizeSystemOneSettings(source)` → {url,model}（trim；拒非对象/未知键/非字符串；url≤500、model≤200；url issue 抛错）
  - `systemoneSettingsFile()` → `<DSH_HOME>/plugin-data/dsh-ccpg-orchestrator/state/systemone-settings.json`
  - `SystemOneSettingsStore(filePath=systemoneSettingsFile())`：read() 缺/损坏回退 EMPTY；write() 原子写（照 AgentDefaultsStore：tmp+fsync+rename+chmod 600）
  - `resolveSystemOneSettings(settings, config)` → `{url: settings.url||config.systemoneUrl, model: settings.model||config.systemoneModel}`
  - `probeSystemOne` 扩展：tags 成功后所有返回路径带 `models`（name/model 字符串数组）；成功带 `ms`
  - `testSystemOne({url, model, fetchImpl=globalThis.fetch, timeoutMs=30000})` →
    - probe 失败：`{ok:false, stage:'probe', reason, models}`
    - 冒烟成功：`{ok:true, probeMs, judgmentMs, value, models}`（value=合法 noul 概率即通过，不要求判决值）
    - 冒烟失败：`{ok:false, stage:'judgment', reason, models}`（AbortError→「判断调用超时（30 秒）；首次加载模型较慢，可重试」）
    - 冒烟固定题：state「天空是蓝色的，草是绿色的。」statement「天空是蓝色的」；signal=AbortSignal.timeout(timeoutMs)
  - `GET /wf1/api/systemone-settings` → `{ok:true, defaults, effective:{...orch.systemone}, deployment:{url,model}}`（scoped:false）
  - `PUT` 同路径：normalize→write→`orch.systemone=resolveSystemOneSettings(normalized,config)`→同 GET payload；SystemOneSettingsError→其 status，RequestBodyError→400，其余→500；其他方法 405
  - `POST /wf1/api/systemone/test` body {url?,model?}：url issue→400；空字段逐字段回退 orch.systemone；恒 200 回 testSystemOne 结果；其他方法 405
  - status 路由改 `probeSystemOne({url: orch.systemone.url, model: orch.systemone.model})`（models 随 spread 透传）
- Consumes: 现有 callSystemOne/probeSystemOne、readBody/json/RequestBodyError、agent-defaults 路由错误处理范式

- [ ] **Step 1: 写失败测试** `test/systemone-settings.test.mjs`（纯函数用 tmp 目录直测；路由用假 webServer apply 范式，照 systemone.test.mjs 的 responseCapture/request/s1Ctx，DSH_HOME 指新 tmp，config={systemoneUrl:'http://mock:11434/v1/systemone', systemoneModel:'m'}）：
  - normalize：{}→空；trim；未知键/非字符串/超长/ftp:///乱串 → 抛 SystemOneSettingsError
  - store：write/read 往返；损坏 JSON→空；缺文件→空
  - resolve：逐字段用户>部署；只填 url 时 model 回退部署（Review Focus 2）
  - probe：models 列表+ms 返回；模型不在→reason 含 ollama pull 且 models 仍返回（Review Focus 4）
  - testSystemOne（mock fetch 按 URL 分发 tags/judgment）：全绿→ok:true 含 probeMs/judgmentMs/value；tags 连不上→stage probe 含 ollama serve；模型不在→stage probe 含 pull；judgment 回非数值→stage judgment；judgment fetch reject→stage judgment；AbortError→超时文案
  - 路由：GET→defaults 空+effective=部署；PUT {url:'http://other:11434/v1/systemone',model:'m2'}→持久化+effective 更新，**随后 node/test 的 mock fetch 捕获 URL=other**（热生效+orchLike 镜像）；PUT 空对象→effective 回退部署；PUT 非法 url/未知键→400；POST test 草稿{}→用 effective 且 ok:true；POST test {url:'javascript:alert(1)'}→400 且零 fetch（Review Focus 3）；PUT 后 GET status→探针 origin=other；settings POST/test GET→405
- [ ] **Step 2: 跑测试确认失败**：`node dsh-plugins/dsh-ccpg-orchestrator/test/systemone-settings.test.mjs` → FAIL（模块不存在）
- [ ] **Step 3: 实现 systemone-settings.js**（照 agent-defaults.js 范式）+ systemone.js 扩展 + index.js 接线
- [ ] **Step 4: 跑测试通过** + 回归 `node test/systemone.test.mjs`（45 例，status 路由改读 orch.systemone 后必须仍绿）、`node test/agent-defaults-api.integration.test.mjs`
- [ ] **Step 5: Commit**：`feat(orchestrator): systemone 用户级设置存储、两段式测试端点与热生效接线`

### Task 2: canvasui 设置卡片 + 画布状态条提示

**Files:**
- Modify: `dsh-plugins/dsh-ccpg-canvasui/src/client.js`（API 常量 1367 后；AgentDefaultsCard 结束后加 SystemOneSettingsCard；WorkflowOneSection 1809 挂载点后插入）
- Modify: `dsh-plugins/dsh-ccpg-canvasui/test/client.test.mjs`（尾部加字符串断言）
- Modify: `web/src/NodePanel.jsx`（SystemOneStatus 未就绪分支）

**Interfaces:**
- Consumes: Task 1 全部路由 payload 形状；现有 systemGet/systemPost/selectStyle/defaultsField/s2
- Produces: 设置卡片完整交互（设计 Spec 逐条）；NodePanel 未就绪文案含「可在 dsh 设置 → Workflow One 配置与测试」

- [ ] **Step 1: 卡片实现**（plain JS createElement，照 AgentDefaultsCard 骨架）：
  - 常量 `SYSTEMONE_SETTINGS_API/TEST_API/STATUS_API`；state：saved/draft{url,model}/status/testing/testResult/saving/message
  - mount：systemGet(SETTINGS)→saved+draft；systemGet(STATUS)→status（含 models）
  - dirty=与 saved.defaults 逐字段比；patchDraft 清 testResult+message；保存钮 !dirty||saving 禁用
  - 字段：url input（placeholder=saved.deployment.url）；model input+datalist（id 唯一，options=status.models∪testResult.models）
  - 测试连接：inline systemoneUrlIssue 等价校验（非法→message err 不发请求）→POST TEST {url:draft.url,model:draft.model}→testResult；等待文案「正在测试…首次调用需加载模型（约 5–10 秒）」；ok 时同步 status 点为就绪
  - 结果行：ok→「✓ 连接 {probeMs}ms · ✓ 模型在位 · ✓ 判断可用 {judgmentMs}ms」+dirty 时「· 尚未保存」；probe 失败→「✗ {reason}」；judgment 失败→「✗ 判断调用失败：{reason}」
  - 保存：PUT→成功 setSaved+message「已保存，新发起的运行立即生效」+重 GET STATUS；失败 message err
  - 状态点：绿「就绪 · {model}」/灰 reason；卡片标题「System One 轻判断模型」+说明「轻判断节点用的本地判断模型。留空 = 跟随部署默认。」
  - WorkflowOneSection 在 AgentDefaultsCard 后挂载
- [ ] **Step 2: NodePanel SystemOneStatus**：未就绪文案追加「 · 可在 dsh 设置 → Workflow One 配置与测试」
- [ ] **Step 3: canvasui 测试加断言**：bundle 含 SystemOneSettingsCard/三个 API 常量/「尚未保存」/「正在测试…首次调用需加载模型」/挂载顺序（AgentDefaultsCard 后）；`node test/client.test.mjs` 全绿
- [ ] **Step 4: 重建 bundle**：`sh dsh-plugins/build-canvasui.sh`；`sh dsh-plugins/build-web.sh`（NodePanel 改动）；web 测试回归
- [ ] **Step 5: Commit**：`feat(canvasui): systemone 设置卡片（两段式测试连接）` + `feat(web): 轻判断状态条追加设置入口提示`（两提交）

### Task 3: 全量验证 + 真实环境

- [ ] **Step 1: 全量回归** `npm test` 全绿；双构建通过
- [ ] **Step 2: 重启 dsh-s1**（按端口找 PID 确认身份再杀，nohup 重启）；curl GET/PUT/POST test 三路由真机验证（真 Ollama：test 应 ok:true 含 judgmentMs；PUT 改 model 再 GET 验证持久化；**验完 PUT 空对象还原**，不污染用户设置）
- [ ] **Step 3: 浏览器 E2E**（playwright + systemone-browser skill 微判断）：官方 UI 设置 → Workflow One → 卡片可见、placeholder=部署默认；点测试连接→分段结果行；改字段→结果清空；测试通过不保存→「尚未保存」；保存→消息+状态点；画布轻判断节点状态条反映 effective；非法 url inline 拦截
- [ ] **Step 4: Commit + 汇报**：验证数字、截图；等用户拍板 push/PR

## Self-Review 记录

- Spec 覆盖：两字段/placeholder/datalist/测草稿/不强制门禁/清结果/尚未保存/保存重探/分段指路/状态条提示/热生效/安全边界 → Task 1/2/3 全映射
- 类型一致：payload 三键 defaults/effective/deployment、testSystemOne 返回形状、路由路径在 Interfaces 钉死，Task 2 按名消费
- Review Focus 五条各有归属（第 5 条诚实归真机，canvasui mock react 测不了交互）
- 比例：计划 ~120 行 vs 预估实现 ~330 行