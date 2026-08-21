import assert from 'node:assert/strict';
import { eventBelongsToCanvas, eventBelongsToRun, normalizeWorkflowId } from './run-event-routing.js';

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

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
