// systemone 轻判断节点离线单测：mock fetch，不依赖 Ollama / dsh 运行时。
// 用法：node test/systemone.test.mjs
import assert from 'node:assert/strict';
import {
  SYSTEMONE_MODES, MAX_STATE_CHARS,
  buildSystemOneQuestion, callSystemOne, shapeSystemOneAnswer, mapSystemOneUsage,
  lintSystemOneNode, systemOneEdgeTaken, probeSystemOne,
} from '../lib/systemone.js';
import { Orchestrator, getKind, lintGraph } from '../lib/engine.js';
import { renderTemplate } from '../lib/template.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

// ---- mock 工具 ----
const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(obj),
});
const textRes = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const noulRes = (value, extra = {}) => jsonRes({
  model: 'pplx-decider-flash',
  answers: { judgment: { type: 'noul', noul: value } },
  usage: { input_tokens: 93, output_tokens: 0 },
  prompt_eval_cached_count: 0,
  ...extra,
});
const realFetch = globalThis.fetch;
const withFetch = async (impl, fn) => {
  globalThis.fetch = impl;
  try { await fn(); } finally { globalThis.fetch = realFetch; }
};
const captureFetch = (responder) => {
  const calls = [];
  const impl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null; // 探针是 GET，无 body
    calls.push({ url: String(url), init, body });
    return responder(body, calls.length);
  };
  impl.calls = calls;
  return impl;
};
const renderedNoul = { statement: '这次登录尝试失败了', instructions: '', trueCriteria: '', falseCriteria: '', options: [], levels: [] };
const renderedChoice = {
  statement: '', instructions: '这条消息属于哪类诉求', trueCriteria: '', falseCriteria: '',
  options: [{ name: 'refund', description: '退款相关' }, { name: 'shipping', description: '物流相关' }], levels: [],
};
const renderedScore = {
  statement: '', instructions: '报告质量', trueCriteria: '', falseCriteria: '',
  options: [], levels: ['缺少关键内容', '内容完整但有小瑕疵', '内容完整且论证严谨'],
};
const lintCtxOf = (node, edges = []) => ({ graph: { nodes: [node], edges }, nodes: new Map([[node.id, node]]), incomingIds: [] });
const soNode = (data, id = 'j1') => ({ id, type: 'systemone', data: { label: '轻判断', ...data } });

console.log('systemone tests:');

// ---- 请求构造 ----
await test('模式清单固定为 noul/choice/score', () => {
  assert.deepEqual(SYSTEMONE_MODES, ['noul', 'choice', 'score']);
});

await test('noul 问题构造：真/假例进 criteria，缺省省略', () => {
  const q = buildSystemOneQuestion('noul', { ...renderedNoul, trueCriteria: '出现错误横幅', falseCriteria: '进入工作台' });
  assert.deepEqual(q, { type: 'noul', instructions: '这次登录尝试失败了', criteria: { true: '出现错误横幅', false: '进入工作台' } });
  const bare = buildSystemOneQuestion('noul', renderedNoul);
  assert.deepEqual(bare, { type: 'noul', instructions: '这次登录尝试失败了' });
});

await test('choice 问题构造：Object.fromEntries，无原型污染', () => {
  const q = buildSystemOneQuestion('choice', renderedChoice);
  assert.deepEqual(q, { type: 'choice', instructions: '这条消息属于哪类诉求', criteria: { refund: '退款相关', shipping: '物流相关' } });
  assert.equal(Object.getPrototypeOf(q.criteria), Object.prototype);
  assert.equal({}.polluted, undefined);
});

await test('score 问题构造：criteria 为档位数组', () => {
  const q = buildSystemOneQuestion('score', renderedScore);
  assert.deepEqual(q, { type: 'score', instructions: '报告质量', criteria: renderedScore.levels });
});

// ---- 调用与错误映射 ----
await test('callSystemOne：noul 用 judgment key，请求体形状正确', async () => {
  const impl = captureFetch(() => noulRes(0.99));
  const r = await callSystemOne({ url: 'http://mock/v1/systemone', model: 'm', state: 's', question: buildSystemOneQuestion('noul', renderedNoul), fetchImpl: impl });
  assert.equal(impl.calls[0].url, 'http://mock/v1/systemone');
  assert.equal(impl.calls[0].init.method, 'POST');
  assert.deepEqual(impl.calls[0].body.questions.judgment, { type: 'noul', instructions: '这次登录尝试失败了' });
  assert.equal(impl.calls[0].body.model, 'm');
  assert.equal(impl.calls[0].body.state, 's');
  assert.equal(r.answer.noul, 0.99);
  assert.deepEqual(r.usage, { input_tokens: 93, output_tokens: 0 });
  assert.equal(r.model, 'pplx-decider-flash');
});

await test('callSystemOne：choice/score 用 answer key', async () => {
  const impl = captureFetch(() => jsonRes({ answers: { answer: { type: 'choice', choice: 'refund', probabilities: { refund: 1 }, confidence: 1 } } }));
  await callSystemOne({ url: 'http://mock', model: 'm', state: 's', question: buildSystemOneQuestion('choice', renderedChoice), fetchImpl: impl });
  assert.ok(impl.calls[0].body.questions.answer);
  assert.equal(impl.calls[0].body.questions.judgment, undefined);
});

await test('连接失败 → 文案指路 ollama serve', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(
    callSystemOne({ url: 'http://localhost:11434/v1/systemone', model: 'm', state: 's', question: { type: 'noul' }, fetchImpl: impl }),
    /ollama serve/,
  );
});

await test('AbortError 原样上抛（交引擎分类超时/取消）', async () => {
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const impl = async () => { throw abort; };
  await assert.rejects(
    callSystemOne({ url: 'http://mock', model: 'm', state: 's', question: { type: 'noul' }, fetchImpl: impl }),
    (e) => e.name === 'AbortError',
  );
});

await test('404 model not found → 文案指路 ollama pull', async () => {
  const impl = async () => textRes('{"error":"model \\"m\\" not found, try pulling it first"}', 404);
  await assert.rejects(
    callSystemOne({ url: 'http://mock', model: 'm', state: 's', question: { type: 'noul' }, fetchImpl: impl }),
    /ollama pull m/,
  );
});

await test('其他 HTTP 错误 → 状态码 + body 片段', async () => {
  const impl = async () => textRes('boom', 500);
  await assert.rejects(
    callSystemOne({ url: 'http://mock', model: 'm', state: 's', question: { type: 'noul' }, fetchImpl: impl }),
    /HTTP 500[\s\S]*boom/,
  );
});

await test('非 JSON / 无 answers → 畸形响应错误', async () => {
  await assert.rejects(
    callSystemOne({ url: 'http://mock', model: 'm', state: 's', question: { type: 'noul' }, fetchImpl: async () => textRes('<html>') }),
    /JSON/,
  );
  await assert.rejects(
    callSystemOne({ url: 'http://mock', model: 'm', state: 's', question: { type: 'noul' }, fetchImpl: async () => jsonRes({ answers: {} }) }),
    /缺少判决/,
  );
});

// ---- 响应整形（data 契约）----
await test('noul 契约：verdict/value/unsettled，首行稳定 token', () => {
  const { data, output } = shapeSystemOneAnswer({ mode: 'noul', answer: { type: 'noul', noul: 0.991389240473643 }, d: {}, rendered: renderedNoul });
  assert.deepEqual(data, { mode: 'noul', verdict: 'yes', value: 0.991389240473643, unsettled: false });
  assert.equal(output.split('\n')[0], '是 0.99');
  assert.ok(output.includes('这次登录尝试失败了'));
});

await test('noul 压线概率 = 待定（严格 > / <）', () => {
  const verdictOf = (v, d = {}) => shapeSystemOneAnswer({ mode: 'noul', answer: { noul: v }, d, rendered: renderedNoul }).data.verdict;
  assert.equal(verdictOf(0.7), 'unsettled');
  assert.equal(verdictOf(0.3), 'unsettled');
  assert.equal(verdictOf(0.71), 'yes');
  assert.equal(verdictOf(0.29), 'no');
  assert.equal(verdictOf(0.5), 'unsettled');
});

await test('noul 自定义阈值生效', () => {
  const d = { yesThreshold: 0.9, noThreshold: 0.1 };
  const verdictOf = (v) => shapeSystemOneAnswer({ mode: 'noul', answer: { noul: v }, d, rendered: renderedNoul }).data.verdict;
  assert.equal(verdictOf(0.85), 'unsettled');
  assert.equal(verdictOf(0.95), 'yes');
  assert.equal(verdictOf(0.05), 'no');
});

await test('noul 畸形响应（无概率）→ 抛错', () => {
  assert.throws(() => shapeSystemOneAnswer({ mode: 'noul', answer: {}, d: {}, rendered: renderedNoul }), /判决/);
});

await test('choice 契约：verdict/probabilities/confidence 透传', () => {
  const answer = { type: 'choice', choice: 'refund', probabilities: { refund: 0.8216811450214572, shipping: 0.1783188549785428 }, confidence: 0.7325217175321858 };
  const { data, output } = shapeSystemOneAnswer({ mode: 'choice', answer, d: {}, rendered: renderedChoice });
  assert.deepEqual(data, { mode: 'choice', verdict: 'refund', probabilities: answer.probabilities, confidence: answer.confidence });
  assert.equal(output.split('\n')[0], 'refund 0.82');
  assert.ok(output.includes('shipping'));
});

await test('choice 不在选项集 / 缺 probabilities → 抛错', () => {
  const base = { choice: 'unknown', probabilities: { unknown: 1 }, confidence: 1 };
  assert.throws(() => shapeSystemOneAnswer({ mode: 'choice', answer: base, d: {}, rendered: renderedChoice }), /选项/);
  assert.throws(() => shapeSystemOneAnswer({ mode: 'choice', answer: { choice: 'refund' }, d: {}, rendered: renderedChoice }), /判决/);
});

await test('score 契约：value/probabilities/legend/confidence，首行 评分 x/档数-1', () => {
  const answer = { type: 'score', score: 0.9463915016251305, legend: { 0: '缺少关键内容', 1: '内容完整但有小瑕疵', 2: '内容完整且论证严谨' }, probabilities: { 0: 0.0627, 1: 0.9282, 2: 0.0091 }, confidence: 0.8922997643472192 };
  const { data, output } = shapeSystemOneAnswer({ mode: 'score', answer, d: {}, rendered: renderedScore });
  assert.deepEqual(data, { mode: 'score', value: answer.score, probabilities: answer.probabilities, legend: answer.legend, confidence: answer.confidence });
  assert.equal(output.split('\n')[0], '评分 0.95/2');
  assert.ok(output.includes('内容完整但有小瑕疵'));
});

await test('usage 映射 camelCase；cachedCount>0 才带 cacheReadTokens', () => {
  assert.deepEqual(mapSystemOneUsage({ input_tokens: 93, output_tokens: 0 }, 7), { inputTokens: 93, outputTokens: 0, cacheReadTokens: 7 });
  assert.deepEqual(mapSystemOneUsage({ input_tokens: 93, output_tokens: 0 }, 0), { inputTokens: 93, outputTokens: 0 });
  assert.equal(mapSystemOneUsage(null, 0), null);
});

// ---- lint ----
const lintIssues = (data, edges = []) => lintSystemOneNode(soNode(data), lintCtxOf(soNode(data), edges));
const hasError = (issues, re) => issues.some((i) => i.level === 'error' && re.test(i.message));

await test('lint：合法 noul 节点零 error', () => {
  const issues = lintIssues({ mode: 'noul', statement: '页面就绪' });
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
});

await test('lint：语句空 / 选项数越界 / 档数越界 → error', () => {
  assert.ok(hasError(lintIssues({ mode: 'noul', statement: '  ' }), /语句/));
  assert.ok(hasError(lintIssues({ mode: 'choice', instructions: 'q', options: [{ name: 'a', description: 'x' }] }), /选项/));
  const many = Array.from({ length: 256 }, (_, i) => ({ name: `o${i}`, description: 'x' }));
  assert.ok(hasError(lintIssues({ mode: 'choice', instructions: 'q', options: many }), /选项/));
  assert.ok(hasError(lintIssues({ mode: 'score', instructions: 'q', levels: ['只有一档'] }), /档/));
  assert.ok(hasError(lintIssues({ mode: 'score', instructions: 'q', levels: Array(11).fill('x') }), /档/));
  assert.ok(hasError(lintIssues({ mode: 'score', instructions: 'q', levels: ['a', '  '] }), /档/));
});

await test('lint：选项名信任边界（空名/重名/__proto__/constructor）→ error', () => {
  const opt = (names) => ({ mode: 'choice', instructions: 'q', options: names.map((name) => ({ name, description: 'x' })) });
  assert.ok(hasError(lintIssues(opt(['a', 'a'])), /重复/));
  assert.ok(hasError(lintIssues(opt(['a', ' '])), /空/));
  assert.ok(hasError(lintIssues(opt(['a', '__proto__'])), /不安全/));
  assert.ok(hasError(lintIssues(opt(['a', 'constructor'])), /不安全/));
  assert.ok(hasError(lintIssues(opt(['a', 'prototype'])), /不安全/));
});

await test('lint：阈值倒置 / NaN / 越界 → error', () => {
  assert.ok(hasError(lintIssues({ mode: 'noul', statement: 's', yesThreshold: 0.2, noThreshold: 0.8 }), /阈值/));
  assert.ok(hasError(lintIssues({ mode: 'noul', statement: 's', yesThreshold: NaN }), /阈值/));
  assert.ok(hasError(lintIssues({ mode: 'noul', statement: 's', noThreshold: 1.5 }), /阈值/));
});

await test('lint：选项改名后旧 branch 边 → error（静默断流防线）', () => {
  const data = { mode: 'choice', instructions: 'q', options: [{ name: 'refund_request', description: 'x' }, { name: 'shipping', description: 'y' }] };
  const edges = [{ source: 'j1', target: 'a', branch: 'refund' }, { source: 'j1', target: 'b', branch: 'shipping' }];
  assert.ok(hasError(lintIssues(data, edges), /分支/));
});

await test('lint：判决缺路 → warn；全接齐 / 无分流意图 → 不 warn', () => {
  const noul = { mode: 'noul', statement: 's' };
  const two = [{ source: 'j1', target: 'a', branch: 'yes' }, { source: 'j1', target: 'b', branch: 'no' }];
  assert.ok(lintIssues(noul, two).some((i) => i.level === 'warn' && /unsettled|待定/.test(i.message)));
  const three = [...two, { source: 'j1', target: 'c', branch: 'unsettled' }];
  assert.equal(lintIssues(noul, three).filter((i) => i.level === 'warn').length, 0);
  assert.equal(lintIssues(noul, [{ source: 'j1', target: 'a' }]).filter((i) => i.level === 'warn').length, 0);
  const choice = { mode: 'choice', instructions: 'q', options: [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }] };
  assert.ok(lintIssues(choice, [{ source: 'j1', target: 'x', branch: 'a' }]).some((i) => i.level === 'warn' && /b/.test(i.message)));
});

await test('lint：score 节点带 branch 边 → warn（评分不分流）', () => {
  const data = { mode: 'score', instructions: 'q', levels: ['a', 'b'] };
  assert.ok(lintIssues(data, [{ source: 'j1', target: 'x', branch: 'a' }]).some((i) => i.level === 'warn' && /不分流/.test(i.message)));
});

// ---- edgeTaken ----
const sWith = (value) => ({ run: { structuredOutputs: value === undefined ? {} : { j1: { value } } } });
await test('edgeTaken：verdict 匹配 / 不匹配 / 无 branch', () => {
  const node = { id: 'j1' };
  assert.equal(systemOneEdgeTaken(sWith({ verdict: 'yes' }), node, { branch: 'yes' }), true);
  assert.equal(systemOneEdgeTaken(sWith({ verdict: 'yes' }), node, { branch: 'no' }), false);
  assert.equal(systemOneEdgeTaken(sWith({ verdict: 'yes' }), node, {}), true);
  assert.equal(systemOneEdgeTaken(sWith({ verdict: 'yes' }), node, { data: { branch: 'yes' } }), true);
});

await test('edgeTaken：缺 verdict（continueOnFail 文本 envelope / score）→ 全放行', () => {
  const node = { id: 'j1' };
  assert.equal(systemOneEdgeTaken(sWith(undefined), node, { branch: 'yes' }), true);
  assert.equal(systemOneEdgeTaken({ run: { structuredOutputs: { j1: { type: 'text', value: '(节点失败后继续：…)' } } } }, node, { branch: 'no' }), true);
  assert.equal(systemOneEdgeTaken(sWith({ mode: 'score', value: 1.5 }), node, { branch: 'yes' }), true);
});

// ---- 探针 ----
await test('probe：GET origin/api/tags，模型在 → available', async () => {
  const impl = captureFetch(() => jsonRes({ models: [{ name: 'pplx-decider-flash:latest' }] }));
  const r = await probeSystemOne({ url: 'http://localhost:11434/v1/systemone', model: 'pplx-decider-flash', fetchImpl: impl });
  assert.equal(impl.calls[0].url, 'http://localhost:11434/api/tags');
  assert.equal(impl.calls[0].init.method, 'GET');
  assert.equal(r.available, true);
});

await test('probe：模型不在 → ollama pull；连不上 → ollama serve', async () => {
  const empty = captureFetch(() => jsonRes({ models: [] }));
  const r1 = await probeSystemOne({ url: 'http://localhost:11434/v1/systemone', model: 'pplx-decider-flash', fetchImpl: empty });
  assert.equal(r1.available, false);
  assert.match(r1.reason, /ollama pull pplx-decider-flash/);
  const r2 = await probeSystemOne({ url: 'http://localhost:11434/v1/systemone', model: 'm', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(r2.available, false);
  assert.match(r2.reason, /ollama serve/);
});

// ---- 引擎集成 ----
const makeOrch = () => {
  const orch = new Orchestrator(null, { onEvent: () => {}, renderTemplate });
  orch.systemone = { url: 'http://mock/v1/systemone', model: 'm' };
  return orch;
};

await test('kind 已注册：execute/lint/edgeTaken 齐全', () => {
  const kind = getKind('systemone');
  assert.ok(kind);
  assert.equal(typeof kind.execute, 'function');
  assert.equal(typeof kind.lint, 'function');
  assert.equal(typeof kind.edgeTaken, 'function');
});

await test('集成：三路分流 yes 命中 / no 跳过，state 默认取上游', async () => {
  const impl = captureFetch(() => noulRes(0.99));
  await withFetch(impl, async () => {
    const orch = makeOrch();
    const run = await orch.run({
      nodes: [
        { id: 'in', type: 'input', data: { text: '登录横幅：密码错误' } },
        { id: 'j1', type: 'systemone', data: { mode: 'noul', statement: '这次登录尝试失败了' } },
        { id: 'outA', type: 'output', data: { label: '是路' } },
        { id: 'outB', type: 'output', data: { label: '否路' } },
      ],
      edges: [
        { source: 'in', target: 'j1' },
        { source: 'j1', target: 'outA', branch: 'yes' },
        { source: 'j1', target: 'outB', branch: 'no' },
      ],
    }, { runId: 'r_s1' });
    assert.equal(run.nodeStates.j1.status, 'success');
    assert.equal(run.nodeStates.outA.status, 'success');
    assert.equal(run.nodeStates.outB.status, 'skipped');
    assert.equal(run.structuredOutputs.j1.value.verdict, 'yes');
    assert.equal(run.outputs.j1.split('\n')[0], '是 0.99');
    assert.ok(impl.calls[0].body.state.includes('密码错误'));
    assert.equal(run.nodeStates.j1.model, 'pplx-decider-flash');
    assert.deepEqual(run.nodeStates.j1.usage, { inputTokens: 93, outputTokens: 0 });
  });
});

await test('集成：同图两个判断节点判决不串（按请求体分发）', async () => {
  const impl = captureFetch((body) => {
    const statement = body.questions.judgment.instructions;
    return noulRes(statement.includes('失败') ? 0.99 : 0.1);
  });
  await withFetch(impl, async () => {
    const orch = makeOrch();
    const run = await orch.run({
      nodes: [
        { id: 'in', type: 'input', data: { text: '页面材料' } },
        { id: 'j1', type: 'systemone', data: { mode: 'noul', statement: '这次登录尝试失败了' } },
        { id: 'j2', type: 'systemone', data: { mode: 'noul', statement: '页面已经就绪' } },
        { id: 'outA', type: 'output', data: {} },
        { id: 'outC', type: 'output', data: {} },
      ],
      edges: [
        { source: 'in', target: 'j1' }, { source: 'in', target: 'j2' },
        { source: 'j1', target: 'outA', branch: 'yes' },
        { source: 'j2', target: 'outC', branch: 'no' },
      ],
    }, { runId: 'r_s2' });
    assert.equal(run.structuredOutputs.j1.value.verdict, 'yes');
    assert.equal(run.structuredOutputs.j2.value.verdict, 'no');
    assert.equal(run.nodeStates.outA.status, 'success');
    assert.equal(run.nodeStates.outC.status, 'success');
  });
});

await test('集成：超长 state 截断 + 标记', async () => {
  const impl = captureFetch(() => noulRes(0.99));
  await withFetch(impl, async () => {
    const orch = makeOrch();
    const run = await orch.run({
      nodes: [
        { id: 'in', type: 'input', data: { text: 'x'.repeat(300000) } },
        { id: 'j1', type: 'systemone', data: { mode: 'noul', statement: 's' } },
      ],
      edges: [{ source: 'in', target: 'j1' }],
    }, { runId: 'r_s3' });
    assert.equal(impl.calls[0].body.state.length, MAX_STATE_CHARS);
    assert.equal(run.structuredOutputs.j1.value.stateTruncated, true);
    assert.ok(run.outputs.j1.includes('截断'));
  });
});

await test('集成：continueOnFail + Ollama 挂 → 下游照常执行（不断流）', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await withFetch(impl, async () => {
    const orch = makeOrch();
    const run = await orch.run({
      nodes: [
        { id: 'j1', type: 'systemone', data: { mode: 'noul', statement: 's', continueOnFail: true } },
        { id: 'outA', type: 'output', data: {} },
      ],
      edges: [{ source: 'j1', target: 'outA', branch: 'yes' }],
    }, { runId: 'r_s4' });
    assert.equal(run.nodeStates.j1.status, 'success');
    assert.ok(run.nodeStates.j1.toleratedError);
    assert.equal(run.nodeStates.outA.status, 'success');
  });
});

await test('集成：lintGraph 对改名选项的旧 branch 边报 error', () => {
  const graph = {
    nodes: [
      { id: 'j1', type: 'systemone', data: { mode: 'choice', instructions: 'q', options: [{ name: 'refund_request', description: 'x' }, { name: 'shipping', description: 'y' }] } },
      { id: 'a', type: 'output', data: {} },
    ],
    edges: [{ source: 'j1', target: 'a', branch: 'refund' }],
  };
  const r = lintGraph(graph);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.level === 'error' && /分支/.test(i.message)));
});

console.log(`\n${passed} passed${process.exitCode ? '（存在失败）' : ''}`);
