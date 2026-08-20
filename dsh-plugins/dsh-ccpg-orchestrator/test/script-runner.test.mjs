import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runScript } from '../lib/script-runner.js';
import { createScriptWorkspace } from '../lib/script-workspace.js';
import { resolveScriptInputs } from '../lib/typed-expression.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack || error.message}`); process.exitCode = 1; }
}

const roots = [];
const tempWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1-script-'));
  roots.push(dir);
  return dir;
};

console.log('script runner tests:');

await test('保留命名参数 JSON 类型并返回对象', async () => {
  const workspaceDir = tempWorkspace();
  const result = await runScript({
    workspaceDir,
    input: { items: [{ id: 1 }], limit: 2, enabled: false, empty: null },
    code: 'function main(input) { return { first: input.items[0], limit: input.limit, enabled: input.enabled, empty: input.empty }; }',
  });
  assert.deepEqual(result.value, { first: { id: 1 }, limit: 2, enabled: false, empty: null });
});

await test('input 深冻结，脚本不能修改入参', async () => {
  const result = await runScript({
    workspaceDir: tempWorkspace(), input: { nested: { value: 1 } },
    code: 'function main(input) { try { input.nested.value = 9; } catch {} return input; }',
  });
  assert.deepEqual(result.value, { nested: { value: 1 } });
});

await test('拒绝缺失 main、Promise 和危险宿主能力', async () => {
  await assert.rejects(() => runScript({ workspaceDir: tempWorkspace(), input: {}, code: 'const value = 1;' }), /必须声明 function main/);
  await assert.rejects(() => runScript({ workspaceDir: tempWorkspace(), input: {}, code: 'function main() { return Promise.resolve(1); }' }), /不支持 async\/Promise/);
  const result = await runScript({
    workspaceDir: tempWorkspace(), input: {},
    code: 'function main() { return { process: typeof process, require: typeof require, fetch: typeof fetch, buffer: typeof Buffer }; }',
  });
  assert.deepEqual(result.value, { process: 'undefined', require: 'undefined', fetch: 'undefined', buffer: 'undefined' });
});

await test('拒绝 undefined、函数、BigInt、NaN、Infinity 和危险键输出', async () => {
  for (const expression of ['undefined', 'function () {}', '1n', 'NaN', 'Infinity', '({ bad: undefined })']) {
    await assert.rejects(() => runScript({
      workspaceDir: tempWorkspace(), input: {}, code: `function main() { return ${expression}; }`,
    }), /JSON|序列化/);
  }
  await assert.rejects(() => runScript({
    workspaceDir: tempWorkspace(), input: {},
    code: 'function main() { const out = Object.create(null); Object.defineProperty(out, "constructor", { value: 1, enumerable: true }); return out; }',
  }), /不安全字段/);
});

await test('死循环、递归和取消能回收 worker', async () => {
  const t0 = Date.now();
  await assert.rejects(() => runScript({
    workspaceDir: tempWorkspace(), input: {}, timeoutMs: 150,
    code: 'function main() { while (true) {} }',
  }), /超时|interrupted/i);
  assert.ok(Date.now() - t0 < 2500);

  await assert.rejects(() => runScript({
    workspaceDir: tempWorkspace(), input: {}, timeoutMs: 500,
    code: 'function main() { return main(); }',
  }), /stack|栈|interrupted|memory/i);

  const controller = new AbortController();
  const pending = runScript({
    workspaceDir: tempWorkspace(), input: {}, timeoutMs: 5000, signal: controller.signal,
    code: 'function main() { while (true) {} }',
  });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(() => pending, /取消/);
});

await test('工作区读写、列表、base64 和删除', async () => {
  const workspaceDir = tempWorkspace();
  const result = await runScript({
    workspaceDir, input: {},
    code: `function main(_input, workspace) {
      workspace.write('nested/report.txt', 'hello');
      const text = workspace.read('nested/report.txt');
      workspace.write('blob.bin', { base64: 'AAEC' });
      const binary = workspace.read('blob.bin', { encoding: 'base64' });
      const list = workspace.list('nested');
      const removed = workspace.remove('nested/report.txt');
      return { text, binary, list, removed };
    }`,
  });
  assert.equal(result.value.text, 'hello');
  assert.deepEqual(result.value.binary, { base64: 'AAEC' });
  assert.equal(result.value.list[0].path, 'nested/report.txt');
  assert.equal(result.value.removed, true);
  assert.equal(readFileSync(join(workspaceDir, 'blob.bin')).toString('hex'), '000102');
});

await test('源码、输入、输出和工作区写入上限生效', async () => {
  await assert.rejects(() => runScript({
    workspaceDir: tempWorkspace(), input: {}, code: `function main(){return null;}/*${'x'.repeat(70 * 1024)}*/`,
  }), /源码超过/);
  await assert.rejects(() => runScript({
    workspaceDir: tempWorkspace(), input: { value: 'x'.repeat(1024 * 1024) }, code: 'function main(input) { return input; }',
  }), /输入超过/);
  await assert.rejects(() => runScript({
    workspaceDir: tempWorkspace(), input: {}, code: "function main() { return 'x'.repeat(1024 * 1024 + 1); }",
  }), /输出超过/);
  await assert.rejects(() => runScript({
    workspaceDir: tempWorkspace(), input: {}, workspaceLimits: { maxFileWriteBytes: 4, maxTotalWriteBytes: 4 },
    code: "function main(_input, workspace) { workspace.write('large.txt', '12345'); return null; }",
  }), /写入超过/);
});

await test('constructor 链不能获得宿主对象', async () => {
  const result = await runScript({
    workspaceDir: tempWorkspace(), input: {},
    code: "function main() { const ctor = ({}).constructor.constructor; return { globalType: typeof ctor('return globalThis')(), processType: ctor('return typeof process')(), hostCallType: ctor('return typeof __hostWorkspaceCall')() }; }",
  });
  assert.deepEqual(result.value, { globalType: 'object', processType: 'undefined', hostCallType: 'undefined' });
});

await test('工作区拒绝穿越、反斜杠、目录删除和符号链接', async () => {
  const workspaceDir = tempWorkspace();
  const workspace = createScriptWorkspace(workspaceDir);
  assert.throws(() => workspace.write('../outside.txt', 'x'), /父目录|相对路径/);
  assert.throws(() => workspace.write('..\\outside.txt', 'x'), /相对路径/);
  mkdirSync(join(workspaceDir, 'dir'));
  assert.throws(() => workspace.remove('dir'), /只能删除文件/);
  const outside = tempWorkspace();
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, join(workspaceDir, 'link'));
  assert.throws(() => workspace.read('link/secret.txt'), /符号链接/);
});

await test('typed resolver 保留 canonical/scoped/常量类型并拒绝非直接上游', () => {
  const ctx = {
    outputs: new Map([['source', '{"fallback":1}']]),
    structuredOutputs: new Map([['source', { version: 1, type: 'json', value: { items: [{ id: 7 }] } }]]),
    labels: new Map([['source', '来源']]), incomingIds: ['source'],
    globalVariables: { flag: false }, workflowVariables: { limit: 0 }, runInputs: { ticket: { id: 'T1' } },
    nodeStates: { source: { status: 'success' } }, triggerInput: 'trigger',
  };
  const resolved = resolveScriptInputs([
    { name: 'items', expression: '{{node["source"].data.items}}' },
    { name: 'flag', expression: '{{vars.global["flag"]}}' },
    { name: 'limit', expression: '{{vars.workflow["limit"]}}' },
    { name: 'ticket', expression: '{{inputs["ticket"]}}' },
    { name: 'constant', value: [1, true, null] },
  ], ctx);
  assert.deepEqual({ ...resolved }, {
    items: [{ id: 7 }], flag: false, limit: 0, ticket: { id: 'T1' }, constant: [1, true, null],
  });
  assert.throws(() => resolveScriptInputs([{ name: 'x', expression: '{{node["other"].data}}' }], ctx), /没有值/);
  assert.throws(() => resolveScriptInputs([{ name: 'x', value: 1 }, { name: 'x', value: 2 }], ctx), /重复/);
  assert.throws(() => resolveScriptInputs([{ name: '__proto__', value: 1 }], ctx), /不安全/);
});

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
