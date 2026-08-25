// Opt-in live test. This file is intentionally excluded from the default *.test.mjs suite.
// Group: FEISHU_APP_ID=... FEISHU_APP_SECRET=... FEISHU_CHAT_ID=oc_... node test/notification-feishu.live.mjs
// Direct: FEISHU_APP_ID=... FEISHU_APP_SECRET=... FEISHU_OPEN_ID=ou_... node test/notification-feishu.live.mjs
import assert from 'node:assert/strict';
import { Orchestrator, lintGraph } from '../lib/engine.js';
import { createFeishuNotificationChannel } from '../lib/notification-feishu.js';
import { NotificationChannelRegistry, WorkflowNotificationManager } from '../lib/notifications.js';
import { renderTemplate } from '../lib/template.js';

const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret } = process.env;
const targetType = process.env.FEISHU_OPEN_ID ? 'open_id' : 'chat_id';
const targetId = process.env.FEISHU_OPEN_ID || process.env.FEISHU_CHAT_ID;
assert.ok(appId && appSecret && targetId, '需要应用凭据，以及 FEISHU_CHAT_ID 或 FEISHU_OPEN_ID');

const sent = [];
const channels = new NotificationChannelRegistry();
const feishu = createFeishuNotificationChannel({ getCredential: () => ({ appId, appSecret }) });
channels.register({
  ...feishu,
  async send(request) {
    const result = await feishu.send(request);
    sent.push({
      kind: request.event.kind,
      nodeId: request.event.node?.id || null,
      messageId: result.message_id,
    });
    return result;
  },
});

const runId = `run_feishu_live_${Date.now().toString(36)}`;
const graph = {
  nodes: [
    { id: 'input', type: 'input', data: { label: '真实输入', text: 'Workflow One 飞书通知端到端测试' } },
    { id: 'notify-inline', type: 'notify', data: { label: '连线结束通知', channel: 'feishu', mode: 'terminal', channelConfig: { targetType, targetId } } },
    { id: 'output', type: 'output', data: { label: '真实输出' } },
    { id: 'notify-alone', type: 'notify', data: { label: '独立逐节点通知', channel: 'feishu', mode: 'each_node', channelConfig: { targetType, targetId } } },
  ],
  edges: [
    { id: 'edge-input-notify', source: 'input', target: 'notify-inline' },
    { id: 'edge-notify-output', source: 'notify-inline', target: 'output' },
  ],
};

assert.equal(lintGraph(graph, { notificationChannels: channels }).ok, true);
const notifications = new WorkflowNotificationManager({ channels, logger: console });
let orchestrator;
orchestrator = new Orchestrator(null, {
  renderTemplate,
  onEvent(event, payload) {
    if (event === 'node-status') {
      notifications.onNodeStatus(payload, orchestrator.runs.get(payload.runId)?.run);
    }
  },
});

notifications.startRun({ runId, graph, workflowName: '飞书通知真实工作流测试', workflowId: 'wf_feishu_live' });
const run = await orchestrator.run(structuredClone(graph), {
  runId,
  workflowName: '飞书通知真实工作流测试',
  workflowId: 'wf_feishu_live',
  source: 'live-test',
});
await notifications.complete(runId, run);

assert.equal(run.status, 'success');
assert.match(run.outputs.output, /Workflow One 飞书通知端到端测试/);
assert.deepEqual(run.nodeStates['notify-inline'].notification, { channel: 'feishu', sent: 1, failed: 0 });
assert.deepEqual(run.nodeStates['notify-alone'].notification, { channel: 'feishu', sent: 3, failed: 0 });
assert.equal(sent.length, 4);
assert.ok(sent.every((item) => item.messageId));

async function runTerminalScenario({ name, expectedStatus, nodeRunner, cancel = false }) {
  const scenarioRunId = `run_feishu_${expectedStatus}_${Date.now().toString(36)}`;
  const scenarioGraph = {
    nodes: [
      { id: 'work', type: 'agent', data: { label: name } },
      { id: 'notify', type: 'notify', data: { label: '独立结束通知', channel: 'feishu', mode: 'terminal', channelConfig: { targetType, targetId } } },
    ],
    edges: [],
  };
  const scenarioNotifications = new WorkflowNotificationManager({ channels, logger: console });
  let scenarioOrchestrator;
  scenarioOrchestrator = new Orchestrator(null, {
    renderTemplate,
    onEvent(event, payload) {
      if (event !== 'node-status') return;
      scenarioNotifications.onNodeStatus(payload, scenarioOrchestrator.runs.get(payload.runId)?.run);
      if (cancel && payload.nodeId === 'work' && payload.status === 'running') {
        queueMicrotask(() => scenarioOrchestrator.cancel(scenarioRunId, 'live test cancel'));
      }
    },
  });
  scenarioOrchestrator.nodeRunner = nodeRunner;
  scenarioNotifications.startRun({ runId: scenarioRunId, graph: scenarioGraph, workflowName: `飞书通知${name}测试`, workflowId: `wf_feishu_${expectedStatus}` });
  const scenarioRun = await scenarioOrchestrator.run(structuredClone(scenarioGraph), {
    runId: scenarioRunId,
    workflowName: `飞书通知${name}测试`,
    workflowId: `wf_feishu_${expectedStatus}`,
    source: 'live-test',
  });
  await scenarioNotifications.complete(scenarioRunId, scenarioRun);
  assert.equal(scenarioRun.status, expectedStatus);
  assert.deepEqual(scenarioRun.nodeStates.notify.notification, { channel: 'feishu', sent: 1, failed: 0 });
  return { runId: scenarioRunId, status: scenarioRun.status, notification: scenarioRun.nodeStates.notify.notification };
}

const errorRun = await runTerminalScenario({
  name: '异常终止',
  expectedStatus: 'error',
  nodeRunner: async () => { throw new Error('live test expected failure'); },
});
const canceledRun = await runTerminalScenario({
  name: '取消',
  expectedStatus: 'canceled',
  cancel: true,
  nodeRunner: async (_node, _run, _state, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }),
});
assert.equal(sent.length, 6);

console.log(JSON.stringify({
  successRun: {
    runId,
    status: run.status,
    notifications: {
      inline: run.nodeStates['notify-inline'].notification,
      standalone: run.nodeStates['notify-alone'].notification,
    },
  },
  errorRun,
  canceledRun,
  sent,
}, null, 2));
