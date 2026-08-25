import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeishuClient } from '../lib/feishu.js';
import { buildFeishuNotificationCard, createFeishuNotificationChannel } from '../lib/notification-feishu.js';

test('FeishuClient 按 interactive 消息结构发送卡片', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { json: async () => calls.length === 1
      ? { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
      : { code: 0, data: { message_id: 'message-1' } } };
  };
  try {
    const client = new FeishuClient({ appId: 'app', appSecret: 'secret' });
    const result = await client.sendMessageCard({ receiveId: 'oc_group', card: { header: {} } });
    assert.equal(result.message_id, 'message-1');
    assert.match(calls[1].url, /\/im\/v1\/messages\?receive_id_type=chat_id$/);
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.receive_id, 'oc_group');
    assert.equal(body.msg_type, 'interactive');
    assert.deepEqual(JSON.parse(body.content), { header: {} });
    await client.sendMessageCard({ receiveIdType: 'open_id', receiveId: 'ou_user', card: { header: {} } });
    assert.match(calls[2].url, /\/im\/v1\/messages\?receive_id_type=open_id$/);
    assert.equal(JSON.parse(calls[2].options.body).receive_id, 'ou_user');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('飞书 provider 校验凭据并渲染运行卡片', async () => {
  let request;
  const provider = createFeishuNotificationChannel({
    getCredential: () => ({ appId: 'app', appSecret: 'secret' }),
    clientFactory: () => ({ sendMessageCard: async (value) => { request = value; return { message_id: 'm1' }; } }),
  });
  assert.deepEqual(provider.validate({ targetId: 'oc_group' }), []);
  assert.deepEqual(provider.validate({ targetType: 'open_id', targetId: 'ou_user' }), []);
  assert.match(provider.validate({ targetType: 'open_id', targetId: 'oc_group' })[0].message, /ou_/);
  assert.match(provider.validate({ targetType: 'email', targetId: 'a@example.com' })[0].message, /不支持/);
  await provider.send({
    config: { targetType: 'open_id', targetId: 'ou_user' },
    event: {
      kind: 'run', status: 'error', workflowName: '巡检', runId: 'run-1', durationMs: 1200,
      startedAt: '2026-08-25T08:00:00.000Z', finishedAt: '2026-08-25T08:00:01.200Z',
      progress: { done: 2, total: 3 }, stats: { success: 1, error: 1, canceled: 0, skipped: 1 },
      summary: '已完成部分巡检', failedNodes: [{ label: '分析', error: 'boom' }],
    },
  });
  assert.equal(request.receiveIdType, 'open_id');
  assert.equal(request.receiveId, 'ou_user');
  assert.equal(request.card.header.template, 'red');
  const runCardText = JSON.stringify(request.card);
  assert.match(runCardText, /已完成部分巡检/);
  assert.match(runCardText, /分析：boom/);
  assert.match(runCardText, /成功 1 · 失败 1 · 取消 0 · 跳过 1/);

  const card = buildFeishuNotificationCard({
    kind: 'node', status: 'success', workflowName: '巡检', runId: 'run-2', progress: { done: 1, total: 2 },
    node: { label: '采集', status: 'success', durationMs: 250, summary: '完成' },
  });
  assert.equal(card.header.template, 'green');
  assert.match(card.elements[2].text.content, /完成/);

  const canceledCard = buildFeishuNotificationCard({
    kind: 'run', status: 'canceled', workflowName: '巡检', runId: 'run-3', progress: { done: 1, total: 2 }, reason: '用户主动取消',
  });
  assert.match(JSON.stringify(canceledCard), /取消原因.*用户主动取消/);
});
