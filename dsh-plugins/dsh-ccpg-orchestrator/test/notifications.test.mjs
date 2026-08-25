import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NotificationChannelRegistry,
  summarizeNotificationText,
  validateNotificationNodeData,
  WorkflowNotificationManager,
} from '../lib/notifications.js';

const graph = {
  nodes: [
    { id: 'input', type: 'input', data: { label: '工单输入' } },
    { id: 'agent', type: 'agent', data: { label: '处理节点' } },
    { id: 'note', type: 'note', data: { label: '说明' } },
    { id: 'each', type: 'notify', data: { label: '逐节点通知', channel: 'test', mode: 'each_node', channelConfig: { targetId: 'group' } } },
    { id: 'terminal', type: 'notify', data: { label: '结束通知', channel: 'test', mode: 'terminal', channelConfig: { targetId: 'group' } } },
  ],
  edges: [],
};

test('渠道注册表负责 provider 校验和发送', async () => {
  const channels = new NotificationChannelRegistry();
  channels.register({ id: 'test', label: '测试', validate: () => [], send: async ({ event }) => event.runId });
  assert.deepEqual(channels.list(), [{ id: 'test', label: '测试' }]);
  assert.deepEqual(channels.validate('missing', {}), [{ level: 'error', message: '不支持的消息渠道：missing' }]);
  assert.equal(await channels.send('test', { event: { runId: 'run-1' } }), 'run-1');
  assert.throws(() => channels.register({ id: 'test', send() {} }), /重复注册/);
});

test('逐节点和结束模式去重发送，并排除通知/注释节点进度', async () => {
  const sent = [];
  const channels = new NotificationChannelRegistry();
  channels.register({ id: 'test', send: async (request) => { sent.push(request); return { id: sent.length }; } });
  const manager = new WorkflowNotificationManager({ channels });
  const run = {
    runId: 'run-1', status: 'error', startedAt: '2026-08-25T08:00:00.000Z', durationMs: 1200,
    outputs: { input: 'hello', agent: 'password="hidden" result' },
    nodeStates: {
      input: { status: 'success', durationMs: 10 },
      agent: { status: 'error', error: 'token=secret-value', durationMs: 20 },
      each: { status: 'success' }, terminal: { status: 'success' }, note: { status: 'success' },
    },
  };
  manager.startRun({ runId: run.runId, graph, workflowName: '报修流程', workflowId: 'wf-1' });
  manager.onNodeStatus({ runId: run.runId, nodeId: 'input', status: 'success' }, run);
  manager.onNodeStatus({ runId: run.runId, nodeId: 'agent', status: 'error', error: 'token=secret-value' }, run);
  manager.onNodeStatus({ runId: run.runId, nodeId: 'agent', status: 'error', error: 'duplicate' }, run);
  manager.onNodeStatus({ runId: run.runId, nodeId: 'note', status: 'success' }, run);
  manager.onNodeStatus({ runId: run.runId, nodeId: 'each', status: 'success' }, run);
  await manager.complete(run.runId, run);

  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map(({ event }) => event.kind), ['node', 'node', 'run', 'run']);
  assert.deepEqual(sent[0].event.progress, { done: 2, total: 2 });
  assert.equal(sent[1].event.node.summary, 'token=***');
  assert.deepEqual(sent[2].event.stats, { success: 1, error: 1, canceled: 0, skipped: 0 });
  assert.equal(sent[2].event.summary, 'hello');
  assert.equal(sent[2].event.startedAt, run.startedAt);
  assert.match(sent[2].event.finishedAt, /^\d{4}-/);
  assert.deepEqual(run.nodeStates.each.notification, { channel: 'test', sent: 3, failed: 0 });
  assert.deepEqual(run.nodeStates.terminal.notification, { channel: 'test', sent: 1, failed: 0 });
});

test('发送失败只写通知元数据，不改变运行结果', async () => {
  const channels = new NotificationChannelRegistry();
  channels.register({ id: 'test', send: async () => { throw new Error('network down'); } });
  const manager = new WorkflowNotificationManager({ channels });
  const failedGraph = { nodes: [graph.nodes[0], graph.nodes[3]], edges: [] };
  const run = { runId: 'run-2', status: 'success', outputs: { input: 'ok' }, nodeStates: { input: { status: 'success' }, each: { status: 'success' } } };
  manager.startRun({ runId: run.runId, graph: failedGraph, workflowName: '流程' });
  manager.onNodeStatus({ runId: run.runId, nodeId: 'input', status: 'success' }, run);
  await manager.complete(run.runId, run);
  assert.equal(run.status, 'success');
  assert.deepEqual(run.nodeStates.each.notification, { channel: 'test', sent: 0, failed: 2, lastError: 'network down' });
});

test('通知配置校验与摘要截断/脱敏', () => {
  assert.equal(validateNotificationNodeData({ channel: '', mode: 'bad', channelConfig: {} }).length, 3);
  const summary = summarizeNotificationText(`Authorization: Bearer abc.def\n${'x'.repeat(600)}`);
  assert.doesNotMatch(summary, /abc\.def/);
  assert.equal(summary.length, 501);
  assert.ok(summary.endsWith('…'));
});
