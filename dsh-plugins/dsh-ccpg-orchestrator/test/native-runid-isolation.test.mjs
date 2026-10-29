// Real engine script-only regression; no dsh, model, provider or agent node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Orchestrator, registerKind } from '../lib/engine.js';

const gates = [];
const releaseGates = () => { for (const release of gates.splice(0)) release(); };
registerKind({
  type: 'native_hold_for_test',
  execute: async () => {
    await new Promise((resolve) => { gates.push(resolve); });
    return 'done';
  },
});

const graph = () => ({ nodes: [{ id: 'hold', type: 'native_hold_for_test', data: {} }], edges: [] });

test('active run ID cannot be reused until first run finishes', async () => {
  const engine = new Orchestrator(null);
  const first = engine.run(graph(), { runId: 'same' });
  assert.equal(engine.runs.has('same'), true);
  // The second call must be rejected before changing the active registry.
  const second = engine.run(graph(), { runId: 'same' });
  assert.equal(engine.runs.size, 1);
  releaseGates();
  const outcome = await Promise.allSettled([first, second]);
  assert.equal(outcome[0].status, 'fulfilled');
  assert.equal(outcome[1].status, 'rejected');
  assert.match(String(outcome[1].reason?.message), /runId|运行|already/);
});

test('completed run ID can be reused later', async () => {
  const engine = new Orchestrator(null);
  const first = engine.run(graph(), { runId: 'retry' });
  releaseGates();
  assert.equal((await first).status, 'success');
  const second = engine.run(graph(), { runId: 'retry' });
  releaseGates();
  assert.equal((await second).status, 'success');
});

test('separate run IDs remain independently addressable', async () => {
  const engine = new Orchestrator(null);
  const a = engine.run(graph(), { runId: 'first' });
  const b = engine.run(graph(), { runId: 'second' });
  assert.equal(engine.runs.has('first'), true);
  assert.equal(engine.runs.has('second'), true);
  releaseGates();
  assert.equal((await a).status, 'success');
  assert.equal((await b).status, 'success');
});
