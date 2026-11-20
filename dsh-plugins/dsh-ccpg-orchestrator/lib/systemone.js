// System One 轻判断客户端核心：请求构造 / 响应整形 / 错误映射 / lint / 分流 / 探针。
// endpoint 与 model 由宿主部署级注入（engine.systemone），节点 data 不含地址——
// 画布、导入图、助手补丁都没有把请求指向任意地址的面（无 SSRF）。
// 判断语义对齐 systemone-browser skill：noul >0.7 是 / <0.3 否 / 中间待定，压线算待定。

export const SYSTEMONE_MODES = ['noul', 'choice', 'score'];
// shortcut: 32k 是拍的安全值，模型实际上下文上限未实测；live 探针阶段实测后校准。
export const MAX_STATE_CHARS = 32000;

const DEFAULT_YES_THRESHOLD = 0.7;
const DEFAULT_NO_THRESHOLD = 0.3;
const FORBIDDEN_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finiteOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 构造单问题请求体。criteria 一律 Object.fromEntries——选项名来自不可信图，绝不 obj[name]= 赋值。 */
export function buildSystemOneQuestion(mode, rendered) {
  if (mode === 'noul') {
    const question = { type: 'noul', instructions: rendered.statement || '' };
    const criteria = {
      ...(rendered.trueCriteria ? { true: rendered.trueCriteria } : {}),
      ...(rendered.falseCriteria ? { false: rendered.falseCriteria } : {}),
    };
    if (Object.keys(criteria).length) question.criteria = criteria;
    return question;
  }
  if (mode === 'choice') {
    return {
      type: 'choice',
      instructions: rendered.instructions || '',
      criteria: Object.fromEntries((rendered.options || []).map((o) => [o.name, o.description ?? ''])),
    };
  }
  return { type: 'score', instructions: rendered.instructions || '', criteria: [...(rendered.levels || [])] };
}

/** 单次判断调用。超时/取消由引擎 signal  govern，这里不自设超时；AbortError 原样上抛交引擎分类。 */
export async function callSystemOne({ url, model, state, question, signal, fetchImpl = globalThis.fetch }) {
  const key = question?.type === 'noul' ? 'judgment' : 'answer';
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions: { [key]: question } }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError' || signal?.aborted) throw e;
    throw new Error(`System One 不可用：无法连接 ${url}。先确认 Ollama 已启动（ollama serve）`);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404 && /not found/i.test(text)) {
      throw new Error(`System One 模型 ${model} 未安装：ollama pull ${model}`);
    }
    throw new Error(`System One 返回 HTTP ${res.status}：${text.slice(0, 120)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`System One 返回非 JSON 响应：${text.slice(0, 120)}`);
  }
  const answer = Object.values(data.answers || {})[0];
  if (!answer) throw new Error('System One 响应缺少判决（answers 为空）');
  return { answer, usage: data.usage || null, cachedCount: Number(data.prompt_eval_cached_count) || 0, model: data.model || model };
}

/** 响应 → data 契约 + 人读文本。首行稳定 token（是 0.99 / refund 0.82 / 评分 0.95/2），condition 关键词匹配可兜底。 */
export function shapeSystemOneAnswer({ mode, answer, d = {}, rendered = {} }) {
  if (mode === 'noul') {
    const value = answer?.noul;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('System One 响应缺少判决：noul 概率不是数值');
    }
    const yesT = finiteOr(d.yesThreshold, DEFAULT_YES_THRESHOLD);
    const noT = finiteOr(d.noThreshold, DEFAULT_NO_THRESHOLD);
    const verdict = value > yesT ? 'yes' : value < noT ? 'no' : 'unsettled';
    const label = verdict === 'yes' ? '是' : verdict === 'no' ? '否' : '待定';
    const lines = [`${label} ${value.toFixed(2)}`];
    if (rendered.statement) lines.push(`语句：${rendered.statement}`);
    return { data: { mode: 'noul', verdict, value, unsettled: verdict === 'unsettled' }, output: lines.join('\n') };
  }
  if (mode === 'choice') {
    const choice = answer?.choice;
    const names = (rendered.options || []).map((o) => o.name);
    if (typeof choice !== 'string' || !names.includes(choice)) {
      throw new Error(`System One 响应缺少判决：choice「${choice}」不在选项集内`);
    }
    if (!isObj(answer.probabilities)) throw new Error('System One 响应缺少判决：choice 缺 probabilities');
    const confidence = finiteOr(answer.confidence, 0);
    const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    const lines = [
      `${choice} ${finiteOr(answer.probabilities[choice], 0).toFixed(2)}`,
      `概率：${sorted.map(([k, p]) => `${k} ${Number(p).toFixed(2)}`).join(' · ')}`,
      `置信度 ${confidence.toFixed(2)}`,
    ];
    return { data: { mode: 'choice', verdict: choice, probabilities: answer.probabilities, confidence }, output: lines.join('\n') };
  }
  const value = answer?.score;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('System One 响应缺少判决：score 不是数值');
  }
  if (!isObj(answer.probabilities)) throw new Error('System One 响应缺少判决：score 缺 probabilities');
  const levels = rendered.levels || [];
  const legend = isObj(answer.legend) ? answer.legend : Object.fromEntries(levels.map((l, i) => [String(i), l]));
  const confidence = finiteOr(answer.confidence, 0);
  const lines = [`评分 ${value.toFixed(2)}/${Math.max(levels.length - 1, 1)}`];
  for (const [k, p] of Object.entries(answer.probabilities)) {
    lines.push(`${k} ${legend[k] ?? ''} ${Number(p).toFixed(2)}`.replace(/\s+/g, ' ').trim());
  }
  lines.push(`置信度 ${confidence.toFixed(2)}`);
  return { data: { mode: 'score', value, probabilities: answer.probabilities, legend, confidence }, output: lines.join('\n') };
}

/** API snake_case → UsageMeta 的 camelCase；缓存读 >0 才带字段（0 不渲染成 ⇦0）。 */
export function mapSystemOneUsage(usage, cachedCount = 0) {
  if (!isObj(usage)) return null;
  const out = { inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 };
  if (cachedCount > 0) out.cacheReadTokens = cachedCount;
  return out;
}

function thresholdsOf(d) {
  const yes = d.yesThreshold === undefined ? DEFAULT_YES_THRESHOLD : d.yesThreshold;
  const no = d.noThreshold === undefined ? DEFAULT_NO_THRESHOLD : d.noThreshold;
  for (const [name, v] of [['yesThreshold', yes], ['noThreshold', no]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      return { error: `阈值 ${name} 必须是 0–1 的数值` };
    }
  }
  if (no >= yes) return { error: '阈值倒置：否阈值必须小于是阈值' };
  return { yes, no };
}

/** 节点 lint：字段合法性 + 选项名信任边界 + 出边 branch 交叉校验（选项改名 = 静默断流的防线）。 */
export function lintSystemOneNode(node, lintCtx = {}) {
  const issues = [];
  const d = node.data || {};
  const label = d.label || node.id;
  const mode = d.mode || 'noul';
  const err = (message) => issues.push({ level: 'error', message: `轻判断「${label}」：${message}` });
  const warn = (message) => issues.push({ level: 'warn', message: `轻判断「${label}」：${message}` });
  if (!SYSTEMONE_MODES.includes(mode)) {
    err(`未知模式 ${mode}（可用：${SYSTEMONE_MODES.join('/')}）`);
    return issues;
  }
  const thresholds = thresholdsOf(d);
  if (thresholds.error) err(thresholds.error);

  let verdicts = null;
  if (mode === 'noul') {
    if (!String(d.statement || '').trim()) err('未配置判断语句');
    verdicts = ['yes', 'no', 'unsettled'];
  } else if (mode === 'choice') {
    if (!String(d.instructions || '').trim()) err('未配置分类问题');
    const options = Array.isArray(d.options) ? d.options : [];
    if (options.length < 2 || options.length > 255) err(`选项数必须 2–255（当前 ${options.length}）`);
    const seen = new Set();
    for (const o of options) {
      const name = String(o?.name ?? '').trim();
      if (!name) { err('选项名不能为空'); continue; }
      if (FORBIDDEN_NAMES.has(name)) { err(`选项名「${name}」不安全`); continue; }
      if (seen.has(name)) { err(`选项名「${name}」重复`); continue; }
      seen.add(name);
    }
    verdicts = [...seen];
  } else {
    if (!String(d.instructions || '').trim()) err('未配置评分维度');
    const levels = Array.isArray(d.levels) ? d.levels : [];
    if (levels.length < 2 || levels.length > 10) err(`档位数必须 2–10（当前 ${levels.length}）`);
    if (levels.some((l) => !String(l ?? '').trim())) err('档位描述不能为空');
  }

  const edges = (lintCtx.graph?.edges || []).filter((e) => e.source === node.id);
  const branched = edges.filter((e) => e.branch || e.data?.branch);
  if (mode === 'score') {
    if (branched.length) warn('评分节点不分流，连线分支标签无效（所有边放行）');
    return issues;
  }
  // 只在有分流意图（存在带 branch 出边）时校验/提醒；纯数据流直连不受影响
  if (branched.length && verdicts) {
    const valid = new Set(verdicts);
    const covered = new Set();
    for (const e of branched) {
      const b = String(e.branch || e.data?.branch);
      covered.add(b);
      if (!valid.has(b)) err(`分支「${b}」不是合法判决（可用：${verdicts.join('/')}）`);
    }
    for (const v of verdicts) {
      if (!covered.has(v)) warn(`判决「${v}」没有出边，命中时下游将跳过`);
    }
  }
  return issues;
}

/** 分流：无 branch 放行；缺 verdict（continueOnFail 容错收尾 / score 模式）全放行——不能把下游断流。 */
export function systemOneEdgeTaken(s, node, edge) {
  const want = edge?.branch || edge?.data?.branch;
  if (!want) return true;
  const verdict = s.run.structuredOutputs?.[node.id]?.value?.verdict;
  if (verdict === undefined || verdict === null) return true;
  return String(verdict) === String(want);
}

/** 就绪探针：GET origin/api/tags 查模型在不在，不 POST 判断（避免触发模型加载）。 */
export async function probeSystemOne({ url, model, fetchImpl = globalThis.fetch, timeoutMs = 2000 }) {
  let tagsUrl;
  try { tagsUrl = `${new URL(url).origin}/api/tags`; } catch {
    return { available: false, reason: `System One 地址无效：${url}` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetchImpl(tagsUrl, { method: 'GET', signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return { available: false, reason: `Ollama 返回 HTTP ${res.status}（GET ${tagsUrl}）` };
    const data = JSON.parse(text);
    // models 列表供设置卡片 datalist 候选；模型不在时也返回（候选仍可用）
    const models = (data.models || []).map((m) => String(m.name || m.model || '')).filter(Boolean);
    // 无 tag 配置匹配同名任意 tag；带 tag 配置精确匹配（datalist 候选是带 tag 名，
    // 旧逻辑剥 tag 后与全名比较会把已装的 :4b 误报成未安装）
    const found = models.some((name) => name === model || (!model.includes(':') && name.split(':')[0] === model));
    if (!found) return { available: false, reason: `模型 ${model} 未安装：ollama pull ${model}`, models };
    return { available: true, model, models, ms: Date.now() - t0 };
  } catch {
    return { available: false, reason: `无法连接 Ollama（${tagsUrl}）：先运行 ollama serve` };
  } finally {
    clearTimeout(timer);
  }
}

// 两段式测试连接：探针（tags，不触发模型加载）+ 冒烟判断（固定题）。
// 测可用性不测正确性：拿到合法概率即通过，不要求判决值。冷启动在测试时发生，
// 用户第一次跑工作流就是热的。
const SMOKE_STATE = '天空是蓝色的，草是绿色的。';
const SMOKE_STATEMENT = '天空是蓝色的';
export async function testSystemOne({ url, model, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  const probe = await probeSystemOne({ url, model, fetchImpl });
  const models = probe.models || [];
  if (!probe.available) return { ok: false, stage: 'probe', reason: probe.reason, models };
  const t0 = Date.now();
  try {
    const raw = await callSystemOne({
      url, model, state: SMOKE_STATE,
      question: { type: 'noul', instructions: SMOKE_STATEMENT },
      signal: AbortSignal.timeout(timeoutMs), fetchImpl,
    });
    const value = raw.answer?.noul;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, stage: 'judgment', reason: '模型响应缺少判决概率', models };
    }
    return { ok: true, probeMs: probe.ms, judgmentMs: Date.now() - t0, value, models };
  } catch (e) {
    const reason = e?.name === 'AbortError'
      ? `判断调用超时（${Math.round(timeoutMs / 1000)} 秒）；首次加载模型较慢，可重试`
      : String(e?.message || e);
    return { ok: false, stage: 'judgment', reason, models };
  }
}
