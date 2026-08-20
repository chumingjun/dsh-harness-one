import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator, lintGraph, registerKind } from '../lib/engine.js';
import { renderTemplate } from '../lib/template.js';
import { runScript } from '../lib/script-runner.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack || error.message}`); process.exitCode = 1; }
}

const roots = [];
function makeOrchestrator() {
  const root = mkdtempSync(join(tmpdir(), 'wf1-script-engine-'));
  roots.push(root);
  const orch = new Orchestrator(null, { renderTemplate });
  orch.scriptRunner = async ({ node, input, signal, timeoutMs }) => {
    const workspaceDir = join(root, node.id);
    const result = await runScript({ code: node.data.code, input, signal, timeoutMs, workspaceDir });
    return { ...result, artifacts: readdirSync(workspaceDir, { recursive: true }).map(String) };
  };
  return orch;
}

console.log('script engine tests:');

registerKind({
  type: 'fixture-json',
  async execute() { return { output: 'fixture', data: { items: [{ id: 1 }, { id: 2 }] } }; },
});

await test('正式 DAG 保留上游 JSON 类型、生成结构化输出和 artifact', async () => {
  const orch = makeOrchestrator();
  const graph = {
    nodes: [
      { id: 'source', type: 'fixture-json', data: { label: '来源' } },
      {
        id: 'script', type: 'script', data: {
          label: '整理脚本', language: 'javascript', scriptTimeoutMs: 1000,
          inputs: [
            { name: 'items', expression: '{{node["source"].data.items}}' },
            { name: 'limit', value: 1 },
          ],
          code: "function main(input, workspace) { workspace.write('result.json', JSON.stringify(input.items.slice(0, input.limit))); return { count: input.items.length, selected: input.items.slice(0, input.limit) }; }",
          outputSchema: {
            type: 'object',
            properties: { count: { type: 'number' }, selected: { type: 'array' } },
            required: ['count', 'selected'], additionalProperties: false,
          },
        },
      },
    ],
    edges: [{ source: 'source', target: 'script' }],
  };
  const run = await orch.run(graph);
  assert.equal(run.status, 'success');
  assert.deepEqual(run.structuredOutputs.script.value, { count: 2, selected: [{ id: 1 }] });
  assert.ok(run.nodeStates.script.artifacts.includes('result.json'));
  assert.equal(run.nodeStates.script.runtime, 'quickjs');
  assert.deepEqual({ ...run.nodeStates.script.input }, { items: [{ id: 1 }, { id: 2 }], limit: 1 });
});

await test('script 输出 Schema 不匹配时节点失败', async () => {
  const orch = makeOrchestrator();
  const run = await orch.run({
    nodes: [{ id: 'script', type: 'script', data: {
      label: 'S', code: 'function main() { return { count: "bad" }; }', inputs: [], scriptTimeoutMs: 1000,
      outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
    } }], edges: [],
  });
  assert.equal(run.status, 'error');
  assert.match(run.nodeStates.script.error, /Schema|校验失败|must be number/);
});

await test('script lint 检查 main、参数引用、危险名、超时和 Schema', () => {
  const graph = {
    nodes: [
      { id: 'source', type: 'input', data: { label: '来源' } },
      { id: 'other', type: 'input', data: { label: '非上游' } },
      { id: 'script', type: 'script', data: {
        label: '坏脚本', code: 'const nope = true;', scriptTimeoutMs: 50,
        inputs: [
          { name: '__proto__', value: 1 },
          { name: 'x', expression: '{{node["other"].data}}' },
        ],
        outputSchema: '{bad',
      } },
    ],
    edges: [{ source: 'source', target: 'script' }],
  };
  const lint = lintGraph(graph);
  assert.equal(lint.ok, false);
  const messages = lint.issues.filter((issue) => issue.nodeId === 'script').map((issue) => issue.message).join('\n');
  assert.match(messages, /main/);
  assert.match(messages, /不安全/);
  assert.match(messages, /直接上游/);
  assert.match(messages, /超时/);
  assert.match(messages, /Schema/);
});

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
