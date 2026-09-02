import assert from 'node:assert/strict';
import { applyRunEvent, currentNodesFromNodeStates, progressFromNodeStates, workflowCards } from './workflow-list-state.js';

assert.deepEqual(progressFromNodeStates({ a: { status: 'success' }, b: { status: 'running' }, c: { status: 'canceled' } }, 3), { done: 2, total: 3, succeeded: 1 });
assert.deepEqual(currentNodesFromNodeStates({ a: { status: 'running' }, b: { status: 'success' } }, { a: '节点 A' }), [{ id: 'a', label: '节点 A' }]);

let runs = applyRunEvent([], 'run-start', { runId: 'r1', workflowId: 'wf1', workflowName: '一', source: 'workflow-list', nodeIds: ['a', 'b'] });
runs = applyRunEvent(runs, 'node-status', { runId: 'r1', nodeId: 'a', status: 'running' });
assert.equal(runs[0].live, true);
assert.equal(runs[0].progress.total, 2);
assert.deepEqual(runs[0].currentNodes, [{ id: 'a', label: 'a' }]);
runs = applyRunEvent(runs, 'run-end', { runId: 'r1', workflowId: 'wf1', status: 'success', durationMs: 42 });
assert.equal(runs[0].live, false);
assert.equal(runs[0].status, 'success');
runs = applyRunEvent(runs, 'node-status', { runId: 'r1', nodeId: 'a', status: 'running' });
assert.equal(runs[0].status, 'success');
assert.equal(runs[0].live, false);

const cards = workflowCards([{ id: 'wf1', name: '一', liveRuns: [{ runId: 'r2', startedAt: '2026-01-01T00:00:00Z' }] }], runs);
assert.equal(cards[0].liveRuns[0].runId, 'r2');
assert.equal(cards[0].lastRun.runId, 'r1');
console.log('workflow list state tests: passed');
