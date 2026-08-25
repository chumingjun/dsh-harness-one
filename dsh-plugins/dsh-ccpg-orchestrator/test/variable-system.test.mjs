import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OutputContractError, createOutputEnvelope, mergeExecutionResults, normalizeExecutionResult, toJsonSafe,
} from '../lib/output-contract.js';
import { renderTemplate, validateTemplate } from '../lib/template.js';
import { buildVariableSchema } from '../lib/variable-schema.js';
import { graphFingerprint, resumeDiff, runMatchesGraphScope, selectScopedRun, subgraphFingerprint, summarizeNodeStates, summarizeOutputs, summarizeStructuredOutputs, upstreamGraphFingerprint } from '../lib/run-scope.js';
import { resolveInside, safeFilename } from '../lib/safe-path.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack || error.message}`); process.exitCode = 1; }
}

console.log('variable system tests:');

await test('canonical text/data/meta 与 default/optional', () => {
  const ctx = {
    outputs: new Map([['n.1', 'human']]),
    structuredOutputs: new Map([['n.1', { version: 1, type: 'json', value: { customer: { name: 'Alice' }, empty: '' } }]]),
    labels: new Map([['n.1', 'N']]), incomingIds: ['n.1'], triggerInput: 'T',
    nodeStates: { 'n.1': { status: 'success', durationMs: 7, trace: { secret: true } } },
  };
  const rendered = renderTemplate('{{node["n.1"].text}} {{node["n.1"].data.customer.name}} {{node["n.1"].meta.durationMs}}', ctx);
  assert.equal(rendered.text, 'human Alice 7');
  assert.equal(renderTemplate('{{node["n.1"].data.missing | default("x")}}', ctx).text, 'x');
  assert.equal(renderTemplate('{{node["n.1"].data.empty | default("x")}}', ctx).text, '');
  assert.equal(renderTemplate('{{node["n.1"].data.missing | optional}}', ctx).text, '');
  assert.equal(renderTemplate('{{node["n.1"].meta.trace | default("hidden")}}', ctx).text, 'hidden');
});

await test('scoped namespaces preserve deep values, false/zero/empty, defaults, and safe paths', () => {
  const ctx = {
    globalVariables: { config: { nested: [{ 'x.y': 0 }] }, enabled: false },
    workflowVariables: { empty: '', payload: { ok: true } },
    runInputs: { ticket: { customer: { name: 'Alice' } } },
  };
  assert.equal(renderTemplate('{{vars.global["config"].nested[0]["x.y"]}}', ctx).text, '0');
  assert.equal(renderTemplate('{{vars.global["enabled"]}}', ctx).text, 'false');
  assert.equal(renderTemplate('{{vars.workflow["empty"] | default("fallback")}}', ctx).text, '');
  assert.equal(renderTemplate('{{inputs["ticket"].customer.name}}', ctx).text, 'Alice');
  assert.equal(renderTemplate('{{inputs["missing"] | default("fallback")}}', ctx).text, 'fallback');
  assert.match(renderTemplate('{{inputs["ticket"].__proto__.x}}', ctx).text, /\{\{/);
});

await test('scoped validation is declaration-aware and legacy callers remain permissive', () => {
  const template = '{{vars.global["missing"]}} {{vars.workflow["wf"]}} {{inputs["ticket"]}}';
  assert.equal(validateTemplate(template, {}).ok, true);
  const result = validateTemplate(template, {
    globalVariableDefinitions: [{ key: 'known' }],
    workflowVariableDefinitions: [],
    inputSchema: { fields: [{ key: 'other' }] },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
    'unknown-global-variable', 'unknown-run-input', 'unknown-workflow-variable',
  ]);
});

await test('legacy JSON path 优先读取结构化 HTTP json', () => {
  const result = renderTemplate('{{HTTP.json.data.resident.name}}', {
    outputs: new Map([['h', 'HTTP 200\n{"data":{"resident":{"name":"文本值"}}}']]),
    structuredOutputs: new Map([['h', { version: 1, type: 'json', value: { status: 200, json: { data: { resident: { name: '结构值' } } } } }]]),
    labels: new Map([['h', 'HTTP']]), incomingIds: ['h'], nodeStates: { h: { status: 'success' } },
  });
  assert.equal(result.text, '结构值');
});

await test('legacy optional 按失败状态删除段落', () => {
  const result = renderTemplate('keep\n\ndrop {{@N}}\n\nend', {
    outputs: new Map([['n', 'should-not-render']]), labels: new Map([['n', 'N']]), incomingIds: ['n'],
    structuredOutputs: new Map(), nodeStates: { n: { status: 'error' } },
  });
  assert.equal(result.text, 'keep\n\nend');
});

await test('$upstream 标签与输出保持同一 id 顺序', () => {
  const result = renderTemplate('{{$upstream}}', {
    outputs: new Map([['a', 'A-out'], ['b', 'B-out']]), labels: new Map([['a', 'Alpha'], ['b', 'Beta']]), incomingIds: ['a', 'b'],
  });
  assert.match(result.text, /Alpha[^]*A-out[^]*Beta[^]*B-out/);
});

await test('系统提示词禁用隐式上游，输入模板保留兼容注入', () => {
  const context = {
    outputs: new Map([['condition', '条件判定：true']]),
    labels: new Map([['condition', '紧急判断']]),
    incomingIds: ['condition'],
  };
  const prompt = '你是物业应急协调员。';
  assert.equal(renderTemplate(prompt, { ...context, implicitUpstream: false }).text, prompt);
  assert.match(renderTemplate(prompt, context).text, /紧急判断[^]*条件判定：true/);
});

await test('模板校验拒绝非直接上游和危险路径', () => {
  const nodes = [{ id: 'a', data: { label: 'A' } }, { id: 'b', data: { label: 'B' } }];
  const result = validateTemplate('{{node["a"].data.__proto__.x}} {{node["b"].text}}', { nodes, incomingIds: ['a'] });
  assert.equal(result.ok, false);
  assert.match(result.issues.map((item) => item.message).join('\n'), /不安全|直接上游/);
});

await test('canonical 未知节点是保存前错误', () => {
  const result = validateTemplate('{{node["missing"].data.value}}', { nodes: [{ id: 'a', data: {} }], incomingIds: ['a'] });
  assert.equal(result.ok, false);
  assert.equal(result.issues.find((issue) => issue.code === 'unknown-node')?.level, 'error');
});

await test('JSON envelope 拒绝不可持久化值并深克隆', () => {
  const source = { ok: true, nested: { n: 1 } };
  const envelope = createOutputEnvelope(source, { type: 'json', schema: { type: 'object' } });
  source.nested.n = 2;
  assert.equal(envelope.value.nested.n, 1);
  assert.throws(() => createOutputEnvelope({ bad: 1n }, { type: 'json' }), OutputContractError);
  assert.throws(() => createOutputEnvelope({ bad: Infinity }, { type: 'json' }), OutputContractError);
  const circular = {}; circular.self = circular;
  assert.throws(() => toJsonSafe(circular), /循环引用/);
});

await test('normalize 与 sink merge 保留机器值且过滤保留字段', () => {
  const base = normalizeExecutionResult({ output: 'text', data: { id: 1 }, status: 'evil', trace: ['ok'] });
  const merged = mergeExecutionResults(base, { output: 'text+sink', chars: 999, writeback: { ok: true } });
  assert.deepEqual(merged.structuredOutput.value, { id: 1 });
  assert.equal(merged.extra.status, undefined);
  assert.equal(merged.extra.chars, undefined);
  assert.deepEqual(merged.extra.writeback, { ok: true });
});

await test('变量树包含静态字段、特殊键和数组 canonical token', () => {
  const graph = {
    nodes: [{ id: 'http.1', type: 'http', data: { label: 'HTTP' } }, { id: 'target', type: 'agent', data: {} }],
    edges: [{ source: 'http.1', target: 'target' }],
  };
  const schema = buildVariableSchema({ graph, targetNodeId: 'target', run: {
    outputs: { 'http.1': 'HTTP 200' },
    structuredOutputs: { 'http.1': { version: 1, type: 'json', value: { status: 200, json: { 'x.y': [{ name: 'A' }] } } } },
    nodeStates: { 'http.1': { status: 'success', durationMs: 3, trace: { secret: true } } },
  } });
  const flat = [];
  const visit = (item) => { flat.push(item); for (const child of item.children || []) visit(child); };
  schema.items.forEach(visit);
  const tokens = flat.map((item) => item.token);
  assert.ok(tokens.includes('node["http.1"].data.status'));
  assert.ok(tokens.includes('node["http.1"].data.json["x.y"][0].name'));
  assert.ok(tokens.includes('node["http.1"].meta.durationMs'));
  assert.ok(!tokens.includes('node["http.1"].meta.trace'));
});

await test('变量树包含 canonical scoped groups and deep fields', () => {
  const schema = buildVariableSchema({
    graph: { nodes: [], edges: [] },
    globalVariableDefinitions: [{ key: 'config', type: 'json' }],
    workflowVariableDefinitions: [{ key: 'flags', type: 'json' }],
    inputSchema: { fields: [{ key: 'ticket', type: 'json' }] },
    globalVariables: { config: { nested: { value: 1 } } },
    workflowVariables: { flags: { enabled: false } },
    runInputs: { ticket: { items: [{ sku: 'A' }] } },
  });
  const flat = [];
  const visit = (value) => { flat.push(value); value.children?.forEach(visit); };
  schema.items.forEach(visit);
  const tokens = flat.map((value) => value.token);
  assert.ok(tokens.includes('vars.global["config"].nested.value'));
  assert.ok(tokens.includes('vars.workflow["flags"].enabled'));
  assert.ok(tokens.includes('inputs["ticket"].items[0].sku'));
  assert.ok(schema.nodes && schema.builtins && schema.groups);
});

await test('五层以上结构化字段可生成变量并完成渲染', () => {
  const deepValue = { level1: { level2: { level3: { level4: { level5: { level6: 'done' } } } } } };
  const graph = {
    nodes: [{ id: 'deep', type: 'agent', data: { label: 'Deep' } }, { id: 'target', type: 'output', data: {} }],
    edges: [{ source: 'deep', target: 'target' }],
  };
  const run = {
    outputs: { deep: JSON.stringify(deepValue) },
    structuredOutputs: { deep: { version: 1, type: 'json', value: deepValue } },
    nodeStates: { deep: { status: 'success' } },
  };
  const schema = buildVariableSchema({ graph, targetNodeId: 'target', run });
  const flat = [];
  const visit = (value) => { flat.push(value); value.children?.forEach(visit); };
  schema.items.forEach(visit);
  const token = 'node["deep"].data.level1.level2.level3.level4.level5.level6';
  assert.ok(flat.some((value) => value.token === token));
  assert.equal(renderTemplate(`{{${token}}}`, {
    outputs: new Map(Object.entries(run.outputs)),
    structuredOutputs: new Map(Object.entries(run.structuredOutputs)),
    labels: new Map([['deep', 'Deep']]),
    incomingIds: ['deep'],
    nodeStates: run.nodeStates,
  }).text, 'done');
});

await test('无 recent value 的 agent schema 仍递归返回对象和数组字段', () => {
  const outputSchema = {
    type: 'object',
    properties: {
      customer: { type: 'object', properties: { name: { type: 'string', description: '客户名' } } },
      items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } },
      status: { type: 'string', enum: ['open', 'closed'] },
    },
  };
  const graph = {
    nodes: [{ id: 'a', type: 'agent', data: { outputMode: 'structured', outputSchema } }, { id: 't', type: 'output', data: {} }],
    edges: [{ source: 'a', target: 't' }],
  };
  const schema = buildVariableSchema({ graph, targetNodeId: 't', run: {} });
  const flat = [];
  const visit = (value) => { flat.push(value); value.children?.forEach(visit); };
  schema.items.forEach(visit);
  assert.ok(flat.some((value) => value.token === 'node["a"].data.customer.name'));
  assert.ok(flat.some((value) => value.token === 'node["a"].data.items[0].sku'));
  assert.deepEqual(flat.find((value) => value.token === 'node["a"].data.status').enum, ['open', 'closed']);
  assert.ok(schema.builtins.every((value) => value.source === 'builtin'));
});

await test('无 recent value 的 script outputSchema 仍递归返回字段', () => {
  const graph = {
    nodes: [
      { id: 's', type: 'script', data: { outputSchema: {
        type: 'object', properties: {
          result: { type: 'object', properties: { count: { type: 'number' } } },
          files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
        },
      } } },
      { id: 't', type: 'output', data: {} },
    ],
    edges: [{ source: 's', target: 't' }],
  };
  const schema = buildVariableSchema({ graph, targetNodeId: 't', run: {} });
  const flat = [];
  const visit = (value) => { flat.push(value); value.children?.forEach(visit); };
  schema.items.forEach(visit);
  assert.ok(flat.some((value) => value.token === 'node["s"].data.result.count'));
  assert.ok(flat.some((value) => value.token === 'node["s"].data.files[0].name'));
});

await test('无 recent value 仍返回 HTTP 静态字段', () => {
  const graph = { nodes: [{ id: 'h', type: 'http', data: {} }, { id: 't', type: 'output', data: {} }], edges: [{ source: 'h', target: 't' }] };
  const schema = buildVariableSchema({ graph, targetNodeId: 't', run: {} });
  const data = schema.nodes[0].children.find((item) => item.label === 'data');
  assert.ok(data.children.some((item) => item.token === 'node["h"].data.status'));
  assert.ok(data.children.some((item) => item.token === 'node["h"].data.json'));
});

await test('运行作用域不回退全局历史并按 workflow/fingerprint 隔离', () => {
  const graphA = { nodes: [{ id: 'a', type: 'input', data: { text: 'A' } }], edges: [] };
  const graphB = { nodes: [{ id: 'b', type: 'input', data: { text: 'B' } }], edges: [] };
  const runs = [
    { runId: 'rB', workflowId: 'wfB', graphFingerprint: graphFingerprint(graphB) },
    { runId: 'rA', workflowId: 'wfA', graphFingerprint: graphFingerprint(graphA) },
  ];
  assert.equal(selectScopedRun({ workflowId: 'wfA' }, { readRun: () => null, runs }).run.runId, 'rA');
  assert.equal(selectScopedRun({ graph: graphA }, { readRun: () => null, runs }).run.runId, 'rA');
  assert.equal(selectScopedRun({}, { readRun: () => null, runs }).run, null);
  assert.equal(selectScopedRun({ runId: 'missing' }, { readRun: () => null, runs }).status, 404);
});

await test('图指纹忽略前端补齐的空数组和默认 false', () => {
  const sparse = {
    nodes: [{ id: 'a', type: 'input', data: { label: 'A', text: 'x' } }],
    edges: [],
  };
  const hydrated = {
    nodes: [{ id: 'a', type: 'input', data: {
      label: 'A', text: 'x', tools: [], skills: [], attachments: [],
      planMode: false, continueOnFail: false, allowPrivate: false,
    } }],
    edges: [],
  };
  assert.equal(graphFingerprint(sparse), graphFingerprint(hydrated));
  assert.notEqual(graphFingerprint(sparse), graphFingerprint({
    ...sparse,
    nodes: [{ ...sparse.nodes[0], data: { ...sparse.nodes[0].data, allowPrivate: true } }],
  }));
});

await test('目标模板可编辑但上游执行图变化会隔离最近运行', () => {
  const runGraph = {
    nodes: [
      { id: 'source', type: 'http', data: { url: 'https://example.com/a' } },
      { id: 'target', type: 'output', data: { inputTemplate: 'old' } },
    ],
    edges: [{ source: 'source', target: 'target' }],
  };
  const editedTarget = {
    ...runGraph,
    nodes: runGraph.nodes.map((node) => node.id === 'target'
      ? { ...node, data: { ...node.data, inputTemplate: '{{node["source"].data}}' } }
      : node),
  };
  const editedSource = {
    ...runGraph,
    nodes: runGraph.nodes.map((node) => node.id === 'source'
      ? { ...node, data: { ...node.data, url: 'https://example.com/b' } }
      : node),
  };
  const run = { graph: runGraph, graphFingerprint: graphFingerprint(runGraph) };
  assert.equal(upstreamGraphFingerprint(runGraph, 'target'), upstreamGraphFingerprint(editedTarget, 'target'));
  assert.equal(runMatchesGraphScope(run, editedTarget, 'target'), true);
  assert.equal(runMatchesGraphScope(run, editedSource, 'target'), false);
});

await test('subgraphFingerprint 含目标节点自身：改目标或改上游均变，改无关下游不变', () => {
  const runGraph = {
    nodes: [
      { id: 'source', type: 'http', data: { url: 'https://example.com/a' } },
      { id: 'target', type: 'output', data: { inputTemplate: 'old' } },
      { id: 'sink', type: 'output', data: { inputTemplate: 's' } },
    ],
    edges: [
      { source: 'source', target: 'target' },
      { source: 'target', target: 'sink' },
    ],
  };
  const editedTarget = { ...runGraph, nodes: runGraph.nodes.map((node) => node.id === 'target'
    ? { ...node, data: { ...node.data, inputTemplate: 'new' } } : node) };
  const editedSource = { ...runGraph, nodes: runGraph.nodes.map((node) => node.id === 'source'
    ? { ...node, data: { ...node.data, url: 'https://example.com/b' } } : node) };
  const editedSink = { ...runGraph, nodes: runGraph.nodes.map((node) => node.id === 'sink'
    ? { ...node, data: { ...node.data, inputTemplate: 's2' } } : node) };
  assert.equal(subgraphFingerprint(runGraph, 'target'), subgraphFingerprint(editedSink, 'target'));
  assert.notEqual(subgraphFingerprint(runGraph, 'target'), subgraphFingerprint(editedTarget, 'target'));
  assert.notEqual(subgraphFingerprint(runGraph, 'target'), subgraphFingerprint(editedSource, 'target'));
  // 快照图与当前图 position 差异不影响语义指纹
  const movedTarget = { ...runGraph, nodes: runGraph.nodes.map((node) => ({ ...node, position: { x: 9, y: 9 } })) };
  assert.equal(subgraphFingerprint(runGraph, 'target'), subgraphFingerprint(movedTarget, 'target'));
});

await test('resumeDiff：改失败节点/未跑下游可全量复用，改成功节点自身或其上游才失效', () => {
  const prevGraph = {
    nodes: [
      { id: 'in', type: 'input', data: { label: '输入', text: 'hello' } },
      { id: 'mid', type: 'agent', data: { label: '中转', prompt: 'p' } },
      { id: 'out', type: 'output', data: { label: '汇总', inputTemplate: '{{$upstream}}' } },
      { id: 'tail', type: 'output', data: { label: '尾部', inputTemplate: '{{$upstream}}' } },
    ],
    edges: [
      { source: 'in', target: 'mid' },
      { source: 'mid', target: 'out' },
      { source: 'out', target: 'tail' },
    ],
  };
  const states = {
    in: { status: 'success' },
    mid: { status: 'error' },
    out: { status: 'skipped' },
  }; // tail 从未执行
  const edit = (id, data) => ({ ...prevGraph, nodes: prevGraph.nodes.map((node) => node.id === id
    ? { ...node, data: { ...node.data, ...data } } : node) });

  // 改卡住的 mid（error 节点）：全部 success 照常复用
  assert.deepEqual(resumeDiff(prevGraph, edit('mid', { prompt: 'fixed' }), states),
    { reusable: ['in'], rerun: [] });
  // 改从未执行的 tail：同上
  assert.deepEqual(resumeDiff(prevGraph, edit('tail', { inputTemplate: 'x' }), states),
    { reusable: ['in'], rerun: [] });
  // 删掉未执行的 tail（加新节点同理）：同上
  const removedTail = {
    nodes: prevGraph.nodes.filter((node) => node.id !== 'tail'),
    edges: prevGraph.edges.filter((edge) => edge.source !== 'out' && edge.target !== 'tail'),
  };
  assert.deepEqual(resumeDiff(prevGraph, removedTail, states), { reusable: ['in'], rerun: [] });

  // in 自身被改 → in 失效；success 下游（此处无）依赖其输出也失效
  const states2 = { in: { status: 'success' }, mid: { status: 'success' }, out: { status: 'skipped' } };
  assert.deepEqual(resumeDiff(prevGraph, edit('in', { text: 'changed' }), states2),
    { reusable: [], rerun: ['in', 'mid'] });
  // 改上游（in）导致 mid 失效；只改 mid 时仅 mid 失效、in 复用
  assert.deepEqual(resumeDiff(prevGraph, edit('mid', { prompt: 'changed' }), states2),
    { reusable: ['in'], rerun: ['mid'] });
  // 图里消失的成功节点判失效
  const removedMid = {
    nodes: prevGraph.nodes.filter((node) => node.id !== 'mid'),
    edges: prevGraph.edges.filter((edge) => edge.source !== 'mid' && edge.target !== 'mid'),
  };
  assert.deepEqual(resumeDiff(prevGraph, removedMid, states2), { reusable: ['in'], rerun: ['mid'] });
});

await test('完成运行不通过 SSE 全局快照恢复', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const sseBlock = source.slice(source.indexOf("path: '/wf1/api/events'"), source.indexOf('// ---------------- helpers'));
  assert.ok(!sseBlock.includes('else if (runHistory[0])'));
});

await test('SSE 全局订阅恢复全部 live run 并携带归属', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const sseBlock = source.slice(source.indexOf("path: '/wf1/api/events'"), source.indexOf('// ---------------- helpers'));
  assert.ok(sseBlock.includes(': [...orch.runs.values()]'));
  assert.ok(sseBlock.includes('for (const live of liveRuns)'));
  assert.ok(sseBlock.includes('workflowId: live.run.workflowId ?? null'));
  assert.ok(sseBlock.includes('canvasId: live.run.canvasId ?? null'));
});

await test('SSE 摘要不包含 envelope value/schema 或 trace', () => {
  const outputSummary = summarizeStructuredOutputs({ n: { version: 1, type: 'json', value: { secret: 1 }, schema: { secret: true } } });
  assert.deepEqual(outputSummary.n, { hasStructured: true, outputType: 'json' });
  const notification = { channel: 'feishu', sent: 1, failed: 0 };
  const stateSummary = summarizeNodeStates({ n: { status: 'success', durationMs: 1, notification, trace: { secret: true }, input: 'raw' } });
  assert.deepEqual(stateSummary.n, { status: 'success', durationMs: 1, notification });
  assert.deepEqual(summarizeOutputs({ n: '{"secret":1}', t: 'plain' }, { n: { version: 1, type: 'json', value: { secret: 1 } } }), {
    n: '(结构化输出，请在节点详情查看)', t: 'plain',
  });
});

await test('路径安全拒绝目录穿越与反斜杠文件名', () => {
  assert.equal(resolveInside('/tmp/base', '../secret'), null);
  assert.equal(safeFilename('..\\secret.txt'), 'secret.txt');
});

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
