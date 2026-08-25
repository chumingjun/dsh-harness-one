const MODES = new Set(['terminal', 'each_node']);
const NODE_TERMINAL_STATUSES = new Set(['success', 'error']);
const PROGRESS_STATUSES = new Set(['success', 'error', 'canceled', 'skipped']);
const SECRET_VALUE_RE = /((?:password|secret|token|api[_-]?key|authorization)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

export function summarizeNotificationText(value, limit = 500) {
  const redacted = String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(SECRET_VALUE_RE, '$1***')
    .trim();
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

export function validateNotificationNodeData(data = {}, channels) {
  const issues = [];
  const channel = String(data.channel || '').trim();
  if (!channel) issues.push({ level: 'error', message: '消息通知节点未选择渠道' });
  if (!MODES.has(data.mode || 'terminal')) {
    issues.push({ level: 'error', message: '消息通知模式必须是 terminal 或 each_node' });
  }
  if (!channels && !String(data.channelConfig?.targetId || '').trim()) {
    issues.push({ level: 'error', message: '消息通知节点未配置接收目标' });
  }
  if (channel && channels) issues.push(...channels.validate(channel, data.channelConfig || {}));
  return issues;
}

export class NotificationChannelRegistry {
  constructor() {
    this.channels = new Map();
  }

  register(provider) {
    if (!provider?.id || typeof provider.send !== 'function') {
      throw new Error('通知渠道需要 { id, send }');
    }
    if (this.channels.has(provider.id)) throw new Error(`通知渠道重复注册：${provider.id}`);
    this.channels.set(provider.id, provider);
    return provider;
  }

  list() {
    return [...this.channels.values()].map(({ id, label }) => ({ id, label: label || id }));
  }

  validate(channelId, config) {
    const provider = this.channels.get(channelId);
    if (!provider) return [{ level: 'error', message: `不支持的消息渠道：${channelId}` }];
    return provider.validate?.(config) || [];
  }

  async send(channelId, request) {
    const provider = this.channels.get(channelId);
    if (!provider) throw new Error(`不支持的消息渠道：${channelId}`);
    return provider.send(request);
  }
}

export class WorkflowNotificationManager {
  constructor({ channels, logger } = {}) {
    this.channels = channels;
    this.logger = logger;
    this.runs = new Map();
  }

  startRun({ runId, graph, workflowName, workflowId }) {
    const notificationNodes = (graph?.nodes || []).filter((node) => node.type === 'notify' && node.data?.enabled !== false);
    if (!notificationNodes.length) return;
    const businessNodes = (graph.nodes || []).filter((node) => node.type !== 'notify' && node.type !== 'note');
    this.runs.set(runId, {
      runId,
      workflowName: workflowName || '未命名工作流',
      workflowId: workflowId || null,
      notificationNodes,
      businessNodes,
      businessNodeIds: new Set(businessNodes.map((node) => node.id)),
      nodesById: new Map((graph.nodes || []).map((node) => [node.id, node])),
      deliveries: new Map(notificationNodes.map((node) => [node.id, []])),
      sent: new Set(),
      queue: Promise.resolve(),
    });
  }

  onNodeStatus(payload, run) {
    const context = this.runs.get(payload?.runId);
    if (!context || !run || payload.resumed || !context.businessNodeIds.has(payload.nodeId) || !NODE_TERMINAL_STATUSES.has(payload.status)) return;
    const node = context.nodesById.get(payload.nodeId);
    const event = {
      kind: 'node',
      status: payload.status,
      runId: context.runId,
      workflowId: context.workflowId,
      workflowName: context.workflowName,
      progress: progressFor(context, run),
      node: {
        id: node.id,
        label: node.data?.label || node.id,
        status: payload.status,
        durationMs: run.nodeStates?.[node.id]?.durationMs,
        summary: summarizeNotificationText(payload.status === 'error' ? payload.error : run.outputs?.[node.id], 300),
      },
    };
    for (const notificationNode of context.notificationNodes) {
      if ((notificationNode.data?.mode || 'terminal') === 'each_node') {
        this._enqueue(context, notificationNode, `node:${node.id}:${payload.status}`, event);
      }
    }
  }

  async complete(runId, run) {
    const context = this.runs.get(runId);
    if (!context) return;
    const failedNodes = context.businessNodes.flatMap((node) => {
      const state = run.nodeStates?.[node.id];
      return state?.status === 'error'
        ? [{ label: node.data?.label || node.id, error: summarizeNotificationText(state.error) }]
        : [];
    });
    const event = {
      kind: 'run',
      status: run.status,
      runId,
      workflowId: context.workflowId,
      workflowName: context.workflowName,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: run.durationMs,
      progress: progressFor(context, run),
      stats: statsFor(context, run),
      summary: summaryFor(context, run),
      reason: summarizeNotificationText(run.status === 'canceled' ? run.cancelReason : run.error),
      failedNodes,
    };
    for (const notificationNode of context.notificationNodes) {
      this._enqueue(context, notificationNode, `run:${run.status}`, event);
    }
    await context.queue;
    for (const notificationNode of context.notificationNodes) {
      const deliveries = context.deliveries.get(notificationNode.id) || [];
      const failed = deliveries.filter((delivery) => !delivery.ok);
      const state = run.nodeStates?.[notificationNode.id] || { status: 'success' };
      run.nodeStates[notificationNode.id] = {
        ...state,
        notification: {
          channel: notificationNode.data?.channel,
          sent: deliveries.length - failed.length,
          failed: failed.length,
          ...(failed.length ? { lastError: failed.at(-1).error } : {}),
        },
      };
    }
    this.runs.delete(runId);
  }

  discard(runId) {
    this.runs.delete(runId);
  }

  _enqueue(context, node, eventKey, event) {
    const key = `${node.id}:${eventKey}`;
    if (context.sent.has(key)) return;
    context.sent.add(key);
    context.queue = context.queue.then(async () => {
      const deliveries = context.deliveries.get(node.id);
      try {
        const result = await this.channels.send(node.data?.channel, {
          config: node.data?.channelConfig || {}, event,
        });
        deliveries.push({ ok: true, eventKey, result });
      } catch (error) {
        const message = String(error.message || error);
        deliveries.push({ ok: false, eventKey, error: message });
        this.logger?.warn?.(`[notify] ${node.data?.channel || 'unknown'} 发送失败（${context.runId}/${node.id}）：${message}`);
      }
    });
  }
}

function progressFor(context, run) {
  const done = context.businessNodes.filter((node) => PROGRESS_STATUSES.has(run.nodeStates?.[node.id]?.status)).length;
  return { done, total: context.businessNodes.length };
}

function statsFor(context, run) {
  const stats = { success: 0, error: 0, canceled: 0, skipped: 0 };
  for (const node of context.businessNodes) {
    const status = run.nodeStates?.[node.id]?.status;
    if (Object.hasOwn(stats, status)) stats[status] += 1;
  }
  return stats;
}

function summaryFor(context, run) {
  const completed = (nodes) => nodes.flatMap((node) => {
    const output = run.nodeStates?.[node.id]?.status === 'success' ? run.outputs?.[node.id] : '';
    const text = summarizeNotificationText(output, 800);
    return text ? [{ label: node.data?.label || node.id, text }] : [];
  });
  let outputs = completed(context.businessNodes.filter((node) => node.type === 'output'));
  if (!outputs.length) outputs = completed([...context.businessNodes].reverse()).slice(0, 1);
  if (outputs.length === 1) return outputs[0].text;
  return summarizeNotificationText(outputs.map((item) => `${item.label}：${item.text}`).join('\n\n'), 1200);
}
