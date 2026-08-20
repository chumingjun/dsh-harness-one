const URL_PATTERN = /https?:\/\/[^\s<>()\[\]"']+/gi;

const asArray = (value) => value == null ? [] : (Array.isArray(value) ? value : [value]);
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && 'value' in value) return textOf(value.value);
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nodeMap(runDetail) {
  return new Map(asArray(runDetail?.graph?.nodes).map((node) => [node.id, node]));
}

function finalOutput(runDetail) {
  const outputs = asObject(runDetail?.outputs);
  const nodes = nodeMap(runDetail);
  const order = asArray(runDetail?.nodeOrder).length ? runDetail.nodeOrder : Object.keys(outputs);
  const outputNodeId = [...order].reverse().find((id) => nodes.get(id)?.data?.nodeType === 'output' || nodes.get(id)?.type === 'output');
  const finalId = outputNodeId || [...order].reverse().find((id) => outputs[id] != null);
  return finalId ? textOf(outputs[finalId]) : '';
}

function normalizeFile(file, fallback = {}) {
  if (typeof file === 'string') {
    return { name: file.split('/').filter(Boolean).at(-1) || file, path: file, ...fallback };
  }
  const value = asObject(file);
  const path = first(value.path, value.file, value.filename, value.name, value.key);
  if (!path) return null;
  return {
    name: first(value.name, value.filename, String(path).split('/').filter(Boolean).at(-1), path),
    path: String(path),
    url: first(value.url, value.href, value.downloadUrl),
    previewUrl: value.previewUrl,
    nodeId: first(value.nodeId, fallback.nodeId),
    nodeLabel: first(value.nodeLabel, value.node, fallback.nodeLabel),
    size: value.size,
    mimeType: first(value.mimeType, value.mediaType, value.contentType),
  };
}

function normalizeLink(link) {
  if (typeof link === 'string') return { url: link, label: link };
  const value = asObject(link);
  const url = first(value.url, value.href, value.link);
  return url ? { url: String(url), label: first(value.label, value.title, value.name, url) } : null;
}

export function normalizeRunEvent(event, index = 0) {
  const value = asObject(event);
  const status = first(value.status, value.state, value.level === 'error' ? 'error' : undefined, 'info');
  const kind = first(value.kind, value.type, value.event, value.nodeId ? 'node' : 'run');
  return {
    id: first(value.id, `${value.t || value.timestamp || 'event'}-${index}`),
    time: first(value.t, value.time, value.timestamp, value.createdAt),
    kind,
    status,
    nodeId: first(value.nodeId, value.node?.id),
    nodeLabel: first(value.nodeLabel, value.label, value.node?.label),
    text: textOf(first(value.text, value.message, value.error, value.detail, value.summary)),
    meta: first(value.meta, value.durationMs != null ? `${value.durationMs}ms` : undefined),
    raw: event,
  };
}

export function getRunId(runDetail, status, results) {
  return first(
    results?.runId, results?.id, results?.run?.runId, results?.run?.id,
    runDetail?.runId, runDetail?.id, status?.runId, status?.id,
  ) || null;
}

export function adaptRunResults(payload, context = {}) {
  const source = asObject(payload);
  const runDetail = asObject(context.runDetail || source.runDetail || source.run || source.detail);
  const result = asObject(source.result || source.results);
  const nodes = nodeMap(runDetail);
  const nodeStates = asObject(runDetail.nodeStates);
  const runId = getRunId(runDetail, context.status, source);

  const explicitFiles = [
    ...asArray(source.files), ...asArray(source.artifacts),
    ...asArray(result.files), ...asArray(result.artifacts),
  ].map((file) => normalizeFile(file)).filter(Boolean);
  const stateFiles = Object.entries(nodeStates).flatMap(([nodeId, state]) => {
    const nodeLabel = nodes.get(nodeId)?.data?.label || nodeId;
    return asArray(state?.artifacts).map((file) => normalizeFile(file, { nodeId, nodeLabel })).filter(Boolean);
  });
  const files = uniqueBy([...explicitFiles, ...stateFiles], (file) => `${file.nodeLabel || ''}:${file.path}`);

  const coreText = textOf(first(
    source.coreText, source.primaryText, source.markdown, source.content,
    result.coreText, result.primaryText, result.markdown, result.content, result.text,
    source.primaryResult?.output, result.primaryResult?.output,
    finalOutput(runDetail),
  ));
  const extractedLinks = (coreText.match(URL_PATTERN) || []).map(normalizeLink).filter(Boolean);
  const links = uniqueBy([
    ...asArray(source.links).map(normalizeLink),
    ...asArray(result.links).map(normalizeLink),
    ...extractedLinks,
  ].filter(Boolean), (link) => link.url);

  const explicitEvents = [
    ...asArray(context.events), ...asArray(source.events), ...asArray(source.process),
    ...asArray(result.events), ...asArray(result.process),
  ];
  const stateEvents = Object.entries(nodeStates).map(([nodeId, state]) => ({
    kind: 'node', nodeId, nodeLabel: nodes.get(nodeId)?.data?.label || nodeId,
    status: state?.status, text: state?.error || '', durationMs: state?.durationMs,
  }));
  const events = (explicitEvents.length ? explicitEvents : stateEvents).map(normalizeRunEvent);

  const explicitIssues = [
    ...asArray(source.issues), ...asArray(source.problems), ...asArray(source.errors),
    ...asArray(result.issues), ...asArray(result.problems),
  ];
  const stateIssues = Object.entries(nodeStates)
    .filter(([, state]) => state?.error || ['error', 'canceled'].includes(state?.status))
    .map(([nodeId, state]) => ({
      nodeId, nodeLabel: nodes.get(nodeId)?.data?.label || nodeId,
      status: state.status || 'error', message: state.error || `节点${state.status === 'canceled' ? '已取消' : '执行失败'}`,
    }));
  const issues = [...explicitIssues, ...stateIssues].map((issue, index) => {
    if (typeof issue === 'string') return { id: `issue-${index}`, status: 'error', message: issue };
    const value = asObject(issue);
    return {
      id: first(value.id, `issue-${index}`),
      status: first(value.status, value.level, 'error'),
      nodeId: value.nodeId,
      nodeLabel: first(value.nodeLabel, value.label),
      message: textOf(first(value.message, value.text, value.error, value.detail, value)),
    };
  });

  const review = asObject(source.review || source.acceptance || result.review || result.acceptance || runDetail.review);
  return {
    runId,
    status: first(source.status, source.run?.status, runDetail.status, context.status?.last, context.status?.status, context.status?.running ? 'running' : undefined, 'idle'),
    workflowName: first(source.workflowName, source.run?.workflowName, runDetail.workflowName, '当前运行'),
    startedAt: first(source.startedAt, source.run?.startedAt, runDetail.startedAt),
    durationMs: first(source.durationMs, source.run?.durationMs, runDetail.durationMs),
    summary: textOf(first(source.summary, result.summary, source.description, result.description)),
    coreText,
    files,
    links,
    input: textOf(first(source.input, source.inputs?.triggerInput, result.input, result.inputs?.triggerInput, runDetail.triggerInput, context.triggerInput)),
    events,
    issues,
    review: {
      status: first(review.status, review.decision, review.result, 'pending'),
      comment: textOf(first(review.comment, review.note, review.reason)),
      reviewer: first(review.reviewer, review.reviewedBy, review.by, review.author),
      reviewedAt: first(review.reviewedAt, review.updatedAt, review.createdAt),
    },
    raw: payload,
  };
}
