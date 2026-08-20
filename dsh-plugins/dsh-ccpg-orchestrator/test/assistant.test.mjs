import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraphOps, wouldCreateCycle, summarizeGraphForAI, checkPatchResult } from '../lib/assistant.js';

const baseGraph = () => ({
  nodes: [
    { id: 'n_input_1', type: 'input', position: { x: 0, y: 0 }, data: { label: '工单输入', text: '漏水报修' } },
    { id: 'n_agent_1', type: 'agent', position: { x: 320, y: 0 }, data: { label: '分类智能体', prompt: '分类' } },
  ],
  edges: [{ id: 'e_1', source: 'n_input_1', target: 'n_agent_1' }],
});

test('addNode with after auto-connects and generates stable id', () => {
  const r = validateGraphOps(baseGraph(), [
    { op: 'addNode', type: 'approval', label: '人工审批', after: 'n_agent_1' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.graph.nodes.length, 3);
  assert.equal(r.graph.edges.length, 2);
  const added = r.patch[0];
  assert.match(added.id, /^n_a/);
  assert.equal(added.data.label, '人工审批');
  const edge = r.patch[1];
  assert.equal(edge.op, 'connect');
  assert.equal(edge.from, 'n_agent_1');
  assert.equal(edge.to, added.id);
});

test('unknown node type rejects whole batch', () => {
  const r = validateGraphOps(baseGraph(), [
    { op: 'addNode', type: 'approval', label: '审批', after: 'n_agent_1' },
    { op: 'addNode', type: 'robot', label: '坏类型' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /未知节点类型/);
  // 原子性：失败批不改图
  assert.equal(r.graph, undefined);
});

test('connect forming cycle rejected', () => {
  const r = validateGraphOps(baseGraph(), [{ op: 'connect', from: 'n_agent_1', to: 'n_input_1' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /环/);
});

test('deleteNode removes incident edges in patch', () => {
  const r = validateGraphOps(baseGraph(), [{ op: 'deleteNode', id: 'n_agent_1' }]);
  assert.equal(r.ok, true);
  assert.equal(r.graph.edges.length, 0);
  assert.deepEqual(r.patch, [{ op: 'deleteNode', id: 'n_agent_1' }]);
});

test('updateNode merges partial data', () => {
  const r = validateGraphOps(baseGraph(), [
    { op: 'updateNode', id: 'n_agent_1', data: { tools: ['feishu_doc_read'] } },
  ]);
  assert.equal(r.ok, true);
  const node = r.graph.nodes.find((n) => n.id === 'n_agent_1');
  assert.equal(node.data.tools[0], 'feishu_doc_read');
  assert.equal(node.data.label, '分类智能体'); // 未传字段保留
});

test('renameNode becomes updateNode patch with label', () => {
  const r = validateGraphOps(baseGraph(), [{ op: 'renameNode', id: 'n_agent_1', label: '派单智能体' }]);
  assert.equal(r.ok, true);
  assert.equal(r.patch[0].data.label, '派单智能体');
});

test('missing referenced node fails with clear error', () => {
  const r = validateGraphOps(baseGraph(), [{ op: 'updateNode', id: 'n_x', data: { a: 1 } }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /不存在/);
});

test('empty ops and bad input rejected', () => {
  assert.equal(validateGraphOps(baseGraph(), []).ok, false);
  assert.equal(validateGraphOps(null, [{ op: 'addNode', type: 'note' }]).ok, false);
});

test('wouldCreateCycle direct and transitive', () => {
  const g = baseGraph();
  assert.equal(wouldCreateCycle(g.nodes, g.edges, 'n_agent_1', 'n_input_1'), true);
  assert.equal(wouldCreateCycle(g.nodes, g.edges, 'n_input_1', 'n_agent_1'), false); // 已存在的边方向再连（重复边上层已挡）这里只测环
});

test('summarizeGraphForAI keeps agent fields compact', () => {
  const s = summarizeGraphForAI(baseGraph());
  assert.equal(s.nodes.length, 2);
  assert.equal(s.nodes[1].label, '分类智能体');
  assert.equal(s.edges[0].from, 'n_input_1');
});

test('checkPatchResult lint flags empty include/exclude or ok graph', () => {
  const okGraph = { nodes: [{ id: 'a', type: 'input', data: { label: 'A' } }], edges: [] };
  const r = checkPatchResult(okGraph);
  assert.equal(typeof r.lintOk, 'boolean');
  assert.ok(Array.isArray(r.issues));
});

test('full scenario: build leak-repair chain via ops', () => {
  const r = validateGraphOps(baseGraph(), [
    { op: 'addNode', type: 'condition', label: '紧急判断', after: 'n_agent_1' },
  ]);
  assert.equal(r.ok, true);
  const condId = r.patch[0].id;
  const r2 = validateGraphOps(r.graph, [{ op: 'addNode', type: 'output', label: '处理输出' }]);
  assert.equal(r2.ok, true);
  const outputId = r2.patch[0].id;
  const r3 = validateGraphOps(r2.graph, [
    { op: 'connect', from: condId, to: outputId, branch: 'true' },
  ]);
  assert.equal(r3.ok, true);
  assert.equal(r3.graph.edges.some((e) => e.branch === 'true'), true);
});
