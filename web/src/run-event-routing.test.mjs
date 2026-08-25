import assert from 'node:assert/strict';
import { eventBelongsToCanvas, eventBelongsToRun, normalizeWorkflowId, shouldFollowRunStart } from './run-event-routing.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('run event routing tests:');

test('workflow ids normalize empty values to draft scope', () => {
  assert.equal(normalizeWorkflowId(undefined), null);
  assert.equal(normalizeWorkflowId(''), null);
  assert.equal(normalizeWorkflowId('wf-a'), 'wf-a');
});

test('assistant run must match both canvas and workflow', () => {
  const current = { canvasId: 'cv-a', workflowId: 'wf-a' };
  assert.equal(eventBelongsToCanvas({ canvasId: 'cv-a', workflowId: 'wf-a' }, current), true);
  assert.equal(eventBelongsToCanvas({ canvasId: 'cv-b', workflowId: 'wf-a' }, current), false);
  assert.equal(eventBelongsToCanvas({ canvasId: 'cv-a', workflowId: 'wf-b' }, current), false);
});

test('named workflow events without canvas id can be adopted', () => {
  assert.equal(eventBelongsToCanvas(
    { workflowId: 'wf-a' },
    { canvasId: 'cv-a', workflowId: 'wf-a' },
  ), true);
});

test('unscoped draft events are rejected but scoped draft events are isolated', () => {
  const current = { canvasId: 'cv-a', workflowId: null };
  assert.equal(eventBelongsToCanvas({ workflowId: null }, current), false);
  assert.equal(eventBelongsToCanvas({ canvasId: 'cv-a', workflowId: null }, current), true);
  assert.equal(eventBelongsToCanvas({ canvasId: 'cv-b', workflowId: null }, current), false);
});

test('only the active run can mutate live state', () => {
  assert.equal(eventBelongsToRun({ runId: 'run-new' }, 'run-new'), true);
  assert.equal(eventBelongsToRun({ runId: 'run-old' }, 'run-new'), false);
  assert.equal(eventBelongsToRun({}, 'run-new'), false);
  assert.equal(eventBelongsToRun({ runId: 'run-new' }, null), false);
});

test('follow run start: 本画布手动/续跑启动跟随视图', () => {
  const current = { canvasId: 'cv-a', workflowId: 'wf-a' };
  assert.equal(shouldFollowRunStart({ runId: 'r1', canvasId: 'cv-a', workflowId: 'wf-a', source: 'manual' }, current), true);
  assert.equal(shouldFollowRunStart({ runId: 'r1', canvasId: 'cv-a', workflowId: 'wf-a', source: 'resume' }, current), true);
  assert.equal(shouldFollowRunStart({ runId: 'r1', canvasId: 'cv-a', workflowId: 'wf-a', source: 'assistant' }, current), true);
});

test('follow run start: 定时/webhook 触发不抢占视图（即使属于本工作流）', () => {
  const current = { canvasId: 'cv-a', workflowId: 'wf-a' };
  assert.equal(shouldFollowRunStart({ runId: 'r1', workflowId: 'wf-a', source: 'schedule' }, current), false);
  assert.equal(shouldFollowRunStart({ runId: 'r1', workflowId: 'wf-a', source: 'webhook' }, current), false);
  // 无 canvasId 的 manual（历史遗留形状）：命名工作流对齐时可跟随
  assert.equal(shouldFollowRunStart({ runId: 'r1', workflowId: 'wf-a', source: 'manual' }, current), true);
});

test('follow run start: 其他画布/工作流的启动不跟随', () => {
  const current = { canvasId: 'cv-a', workflowId: 'wf-a' };
  assert.equal(shouldFollowRunStart({ runId: 'r1', canvasId: 'cv-b', workflowId: 'wf-a', source: 'manual' }, current), false);
  assert.equal(shouldFollowRunStart({ runId: 'r1', canvasId: 'cv-a', workflowId: 'wf-b', source: 'manual' }, current), false);
  assert.equal(shouldFollowRunStart({ runId: 'r1', source: 'manual' }, { canvasId: 'cv-a', workflowId: null }), false);
  assert.equal(shouldFollowRunStart({ source: 'manual' }, current), false);
});

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
