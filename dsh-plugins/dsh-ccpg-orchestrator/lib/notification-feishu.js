import { FeishuClient } from './feishu.js';

const STATUS = {
  success: { label: '成功', color: 'green' },
  error: { label: '失败', color: 'red' },
  canceled: { label: '已取消', color: 'grey' },
};
const TARGETS = {
  chat_id: { label: '群聊', prefix: 'oc_' },
  open_id: { label: '私聊用户', prefix: 'ou_' },
};

export function createFeishuNotificationChannel({ getCredential, clientFactory } = {}) {
  return {
    id: 'feishu',
    label: '飞书',
    validate(config = {}) {
      const issues = [];
      const targetType = config.targetType || 'chat_id';
      const target = TARGETS[targetType];
      const targetId = String(config.targetId || '').trim();
      if (!target) {
        issues.push({ level: 'error', message: `飞书通知不支持接收类型：${targetType}` });
      } else if (!targetId) {
        issues.push({ level: 'error', message: `飞书通知未填写${target.label} ${targetType}` });
      } else if (!targetId.startsWith(target.prefix)) {
        issues.push({ level: 'error', message: `${target.label} ${targetType} 应以 ${target.prefix} 开头` });
      }
      if (!getCredential?.(config.credentialId)) {
        issues.push({ level: 'error', message: '飞书通知没有可用的应用凭据' });
      }
      return issues;
    },
    async send({ config = {}, event }) {
      const credential = getCredential?.(config.credentialId);
      if (!credential) throw new Error('飞书通知没有可用的应用凭据');
      const client = clientFactory
        ? clientFactory(credential)
        : new FeishuClient({ appId: credential.appId, appSecret: credential.appSecret });
      return client.sendMessageCard({
        receiveIdType: config.targetType || 'chat_id',
        receiveId: String(config.targetId || '').trim(),
        card: buildFeishuNotificationCard(event),
        signal: AbortSignal.timeout(10_000),
      });
    },
  };
}

export function buildFeishuNotificationCard(event) {
  const status = STATUS[event.status] || { label: event.status || '进行中', color: 'blue' };
  const node = event.node;
  const title = event.kind === 'run'
    ? `${event.workflowName} · ${status.label}`
    : `${event.workflowName} · ${node.label}`;
  const fields = node ? [
    field('状态', STATUS[node.status]?.label || node.status),
    field('整体进度', `${event.progress?.done || 0}/${event.progress?.total || 0}`),
    field('节点耗时', formatDuration(node.durationMs)),
  ] : [
    field('状态', status.label),
    field('整体进度', `${event.progress?.done || 0}/${event.progress?.total || 0}`),
    field('总耗时', formatDuration(event.durationMs)),
    field('节点统计', formatStats(event.stats), false),
    field('开始时间', formatTime(event.startedAt)),
    field('结束时间', formatTime(event.finishedAt)),
  ];
  const details = node
    ? [section('输出摘要', node.summary || '节点无文本输出')]
    : runDetails(event, status);
  return {
    config: { wide_screen_mode: true },
    header: { template: node ? (STATUS[node.status]?.color || 'blue') : status.color, title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', fields },
      ...details.flatMap((detail) => [{ tag: 'hr' }, detail]),
      { tag: 'note', elements: [{ tag: 'plain_text', content: `运行 ID：${event.runId}` }] },
    ],
  };
}

function runDetails(event, status) {
  const details = [];
  if (event.summary) details.push(section('最终输出摘要', event.summary));
  if (event.failedNodes?.length) {
    details.push(section('异常详情', event.failedNodes.map((item) => `${item.label}：${item.error || '执行失败'}`).join('\n')));
  }
  if (event.status === 'canceled') details.push(section('取消原因', event.reason || '用户取消'));
  if (!details.length) details.push(section('运行结果', `工作流${status.label}`));
  return details;
}

function section(label, value) {
  return { tag: 'div', text: { tag: 'plain_text', content: `${label}\n${value}` } };
}

function field(label, value, isShort = true) {
  return { is_short: isShort, text: { tag: 'lark_md', content: `**${label}**\n${value ?? '-'}` } };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatStats(stats = {}) {
  return `成功 ${stats.success || 0} · 失败 ${stats.error || 0} · 取消 ${stats.canceled || 0} · 跳过 ${stats.skipped || 0}`;
}

function formatTime(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
