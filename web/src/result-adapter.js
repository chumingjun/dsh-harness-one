const URL_PATTERN = /https?:\/\/[^\s<>()\[\]"']+/gi;

export const RUN_ARTIFACT_SAVE_PATH = '/run-artifacts/save';

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

function basename(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');
}

function graphNodes(runDetail) {
  return asArray(runDetail?.graph?.nodes);
}

function nodeMap(runDetail) {
  return new Map(graphNodes(runDetail).map((node) => [node.id, node]));
}

function nodeType(node) {
  return node?.type || node?.data?.nodeType || null;
}

function isRuntimeNode(value) {
  return first(value?.nodeType, value?.type, nodeType(value)) !== 'note';
}

function stableNodeOrder(runDetail) {
  const nodes = graphNodes(runDetail).filter(isRuntimeNode);
  if (!nodes.length) {
    const ids = [...new Set([
      ...asArray(runDetail?.nodeOrder),
      ...Object.keys(asObject(runDetail?.nodeStates)),
      ...Object.keys(asObject(runDetail?.outputs)),
    ])];
    return ids.map((id) => ({ id, type: null, data: { label: id } }));
  }
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of asArray(runDetail?.graph?.edges)) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.get(edge.source).push(edge.target);
    incoming.set(edge.target, incoming.get(edge.target) + 1);
  }
  const ready = nodes.filter((node) => incoming.get(node.id) === 0).sort((a, b) => index.get(a.id) - index.get(b.id));
  const ordered = [];
  while (ready.length) {
    const node = ready.shift();
    ordered.push(node);
    for (const target of outgoing.get(node.id)) {
      incoming.set(target, incoming.get(target) - 1);
      if (incoming.get(target) === 0) {
        ready.push(byId.get(target));
        ready.sort((a, b) => index.get(a.id) - index.get(b.id));
      }
    }
  }
  if (ordered.length !== nodes.length) {
    const seen = new Set(ordered.map((node) => node.id));
    ordered.push(...nodes.filter((node) => !seen.has(node.id)));
  }
  return ordered;
}

function normalizeFile(file, fallback = {}) {
  if (typeof file === 'string') {
    return { name: basename(file), path: file, ...fallback };
  }
  const value = asObject(file);
  const path = first(value.path, value.relativePath, value.file, value.filename, value.name, value.key);
  if (!path) return null;
  return {
    id: first(value.id, value.artifactId),
    name: basename(first(value.name, value.filename, path)),
    path: String(path),
    url: first(value.url, value.href, value.downloadUrl),
    downloadUrl: first(value.downloadUrl, value.url, value.href),
    previewUrl: value.previewUrl,
    nodeId: first(value.nodeId, fallback.nodeId),
    nodeLabel: first(value.nodeLabel, value.node, fallback.nodeLabel),
    size: value.size,
    mimeType: first(value.mimeType, value.mediaType, value.contentType),
  };
}

export function getArtifactIds(files = []) {
  return [...new Set(asArray(files).map((file) => (
    typeof file === 'string' || typeof file === 'number' ? file : first(file?.id, file?.artifactId)
  )).filter(Boolean).map(String))];
}

export function buildArtifactSavePayload({ runId, artifactIds, files, sessionId } = {}) {
  return {
    runId: String(runId || ''),
    artifactIds: getArtifactIds(artifactIds || files),
    sessionId: String(sessionId || ''),
  };
}

export async function saveRunArtifacts(url, payload, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildArtifactSavePayload(payload)),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error(data.error || `保存失败（HTTP ${response.status}）`);
  return {
    ...data,
    savedCount: Number(data.savedCount) || 0,
    names: savedArtifactNames(data.names),
  };
}

export function savedArtifactNames(names = []) {
  return [...new Set(asArray(names).map(basename).filter(Boolean))];
}

export function isRunResultsReady(model, hasLoadedResults = true) {
  if (!hasLoadedResults || !model?.runId) return false;
  return !['idle', 'queued', 'pending', 'running', 'waiting'].includes(model.status);
}

export async function loadRunResults(url, { signal, waitUntilReady = false } = {}, fetchImpl = globalThis.fetch) {
  const attempts = waitUntilReady ? 32 : 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(250 * attempt, 1000)));
    const response = await fetchImpl(url, { signal });
    const data = await response.json().catch(() => ({}));
    if (response.ok && (!waitUntilReady || isRunResultsReady(data, true))) return data;
    if (response.ok || response.status === 404) {
      if (attempt < attempts - 1) continue;
      throw new Error(waitUntilReady ? '成果整理超时，请重试' : (data.error || '运行记录不存在'));
    }
    throw new Error(data.error || `加载成果失败（HTTP ${response.status}）`);
  }
  throw new Error('加载成果失败');
}

function normalizeLink(link) {
  if (typeof link === 'string') return { url: link, label: link };
  const value = asObject(link);
  const url = first(value.url, value.href, value.link);
  return url ? {
    url: String(url),
    label: first(value.label, value.title, value.name, url),
    nodeId: value.nodeId,
    nodeLabel: value.nodeLabel,
  } : null;
}

// 技术输出文件（调试/错误转储）不进「过程文件」展示列表；
// 仍保留在 files/产物索引里——正文行内引用可点、ZIP 导出完整。
const TECHNICAL_ARTIFACT_PATTERNS = [/^fetch_err[^/]*\.json$/i];

export function isTechnicalArtifact(file) {
  const name = String(file?.name || file?.path || '').split('/').filter(Boolean).at(-1) || '';
  return TECHNICAL_ARTIFACT_PATTERNS.some((pattern) => pattern.test(name));
}

function normalizeResultRow(row, nodes, runDetail) {
  const value = asObject(row);
  const nodeId = first(value.nodeId, value.id);
  const node = nodes.get(nodeId);
  const state = asObject(runDetail?.nodeStates?.[nodeId]);
  return {
    nodeId,
    nodeLabel: first(value.nodeLabel, value.label, node?.data?.label, nodeId),
    nodeType: first(value.nodeType, value.type, nodeType(node)),
    status: first(value.status, state.status, 'pending'),
    output: value.output == null ? null : textOf(value.output),
    structuredOutput: first(value.structuredOutput, runDetail?.structuredOutputs?.[nodeId], null),
    error: first(value.error, state.error, state.toleratedError),
    durationMs: first(value.durationMs, state.durationMs),
    startedAt: first(value.startedAt, state.startedAt),
    legacyInferred: Boolean(value.legacyInferred),
  };
}

function fallbackRows(runDetail) {
  const nodes = nodeMap(runDetail);
  const outputs = asObject(runDetail.outputs);
  return stableNodeOrder(runDetail).map((node) => normalizeResultRow({
    nodeId: node.id,
    nodeType: nodeType(node),
    status: runDetail.nodeStates?.[node.id]?.status,
    output: Object.prototype.hasOwnProperty.call(outputs, node.id) ? outputs[node.id] : null,
  }, nodes, runDetail));
}

function timelineText(row) {
  if (row.error) return row.error;
  if (row.status === 'success') return '节点已完成';
  if (row.status === 'running') return '节点正在执行';
  if (row.status === 'queued' || row.status === 'pending') return '节点等待执行';
  if (row.status === 'waiting') return '节点等待审批';
  if (row.status === 'skipped') return '本次流程未执行该节点';
  if (row.status === 'canceled') return '节点已取消';
  return `节点状态：${row.status}`;
}

// 面向普通用户的耗时文案：毫秒不直接暴露，统一换算成秒/分
export function formatDuration(durationMs) {
  if (durationMs == null || Number.isNaN(Number(durationMs))) return '';
  const ms = Number(durationMs);
  if (ms < 1000) return '不到 1 秒';
  const seconds = ms / 1000;
  if (seconds < 60) return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

//  HH:MM:SS 时钟格式，用于「开始时间」
export function formatClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
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
    turns: value.turns,
    preview: textOf(value.preview) || undefined,
    durationMs: value.durationMs,
    startedAt: first(value.startedAt, value.startedat),
    text: textOf(first(value.text, value.message, value.error, value.detail, value.summary)),
    meta: first(value.meta, value.durationMs != null ? formatDuration(value.durationMs) : undefined),
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
  const runId = getRunId(runDetail, context.status, source);
  const fallback = fallbackRows(runDetail);

  const explicitRows = asArray(source.results).map((row) => normalizeResultRow(row, nodes, runDetail)).filter(isRuntimeNode);
  const baseRows = explicitRows.length ? explicitRows : fallback;
  const outputResults = asArray(source.outputResults).length
    ? source.outputResults.map((row) => normalizeResultRow(row, nodes, runDetail)).filter(isRuntimeNode)
    : baseRows.filter((row) => row.nodeType === 'output');
  let effectiveOutputs = outputResults;
  let finalStatus = source.finalStatus;
  if (!effectiveOutputs.length) {
    const inferred = [...baseRows].reverse().find((row) => row.status === 'success' && row.output);
    if (inferred) effectiveOutputs = [{ ...inferred, legacyInferred: true }];
    finalStatus ||= inferred ? 'legacy-inferred' : 'unavailable';
  } else if (!finalStatus) {
    const successful = effectiveOutputs.filter((row) => row.status === 'success' && row.output);
    finalStatus = successful.length === effectiveOutputs.length ? 'available' : successful.length ? 'partial' : 'unavailable';
  }
  const processResults = asArray(source.processResults).length
    ? source.processResults.map((row) => normalizeResultRow(row, nodes, runDetail)).filter(isRuntimeNode)
    : baseRows.filter((row) => row.nodeType !== 'output');

  const explicitFiles = [...asArray(source.files), ...asArray(source.artifacts), ...asArray(result.files), ...asArray(result.artifacts)]
    .map((file) => normalizeFile(file)).filter(Boolean);
  const stateFiles = Object.entries(asObject(runDetail.nodeStates)).flatMap(([nodeId, state]) => {
    const nodeLabel = nodes.get(nodeId)?.data?.label || nodeId;
    return asArray(state?.artifacts).map((file) => normalizeFile(file, { nodeId, nodeLabel })).filter(Boolean);
  });
  const allFiles = uniqueBy([...explicitFiles, ...stateFiles], (file) => `${file.nodeId || file.nodeLabel || ''}:${file.path}`);
  const explicitFinalFiles = asArray(source.finalArtifacts).map((file) => normalizeFile(file)).filter(Boolean);
  const explicitProcessFiles = asArray(source.processArtifacts).map((file) => normalizeFile(file)).filter(Boolean);
  const outputIds = new Set(effectiveOutputs.map((row) => row.nodeId));
  const finalFiles = explicitFinalFiles.length ? explicitFinalFiles : allFiles.filter((file) => outputIds.has(file.nodeId));
  const processFiles = (explicitProcessFiles.length ? explicitProcessFiles : allFiles.filter((file) => !outputIds.has(file.nodeId)))
    .filter((file) => !isTechnicalArtifact(file));

  const selectedOutput = effectiveOutputs.find((row) => row.status === 'success' && row.output) || null;
  const coreText = textOf(first(source.coreText, source.primaryText, source.primaryResult?.output, selectedOutput?.output));
  const extractedLinks = (coreText.match(URL_PATTERN) || []).map(normalizeLink).filter(Boolean);
  const links = uniqueBy([
    ...asArray(source.links).map(normalizeLink),
    ...asArray(result.links).map(normalizeLink),
    ...extractedLinks,
  ].filter(Boolean), (link) => link.url);

  const liveByNode = new Map(asArray(context.events).filter((event) => event?.nodeId).map((event) => [event.nodeId, normalizeRunEvent(event)]));
  const sourceTimeline = asArray(source.nodeTimeline).length
    ? source.nodeTimeline.map((row) => normalizeResultRow(row, nodes, runDetail)).filter(isRuntimeNode)
    : fallback;
  const liveNodesSeen = new Set();
  const nodeTimeline = sourceTimeline.map((row) => {
    const live = liveByNode.get(row.nodeId);
    if (live) liveNodesSeen.add(row.nodeId);
    // live 事件是此刻真实状态（detail 是启动快照/竞态残影），status/轮次/预览以 live 为准
    const merged = live
      ? {
        ...row,
        status: live.status || row.status,
        error: live.text || row.error,
        turns: live.turns ?? row.turns,
        preview: live.preview ?? row.preview,
        durationMs: live.status === 'running' ? undefined : first(live.durationMs, row.durationMs),
      }
      : row;
    return {
      ...merged,
      id: `node:${row.nodeId}`,
      kind: 'node',
      text: timelineText(merged),
      meta: merged.durationMs != null ? formatDuration(merged.durationMs) : undefined,
    };
  });
  // run-results/detail 尚未就绪时（live 运行），时间线骨架可能缺失该节点：用 live 事件补行
  for (const [nodeId, live] of liveByNode) {
    if (liveNodesSeen.has(nodeId)) continue;
    if (live.status === 'queued' || live.status === 'pending') continue;
    nodeTimeline.push({
      id: `node:${nodeId}`,
      kind: 'node',
      nodeId,
      nodeLabel: live.nodeLabel || nodeId,
      nodeType: nodes.get(nodeId)?.type,
      status: live.status || 'running',
      error: live.text,
      turns: live.turns,
      preview: live.preview,
      startedAt: live.startedAt,
      text: timelineText({ status: live.status || 'running', error: live.text }),
    });
  }
  const runEvents = [
    ...asArray(context.events), ...asArray(source.events), ...asArray(source.process),
    ...asArray(result.events), ...asArray(result.process),
  ].filter((event) => !event?.nodeId).map(normalizeRunEvent);

  const explicitIssues = [...asArray(source.issues), ...asArray(source.problems), ...asArray(source.errors), ...asArray(result.issues), ...asArray(result.problems)];
  const stateIssues = Object.entries(asObject(runDetail.nodeStates))
    .filter(([, state]) => state?.error || ['error', 'canceled'].includes(state?.status))
    .map(([nodeId, state]) => ({ nodeId, nodeLabel: nodes.get(nodeId)?.data?.label || nodeId, status: state.status || 'error', message: state.error || `节点${state.status === 'canceled' ? '已取消' : '执行失败'}` }));
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

  return {
    runId,
    status: first(source.status, source.run?.status, runDetail.status, context.status?.last, context.status?.status, context.status?.running ? 'running' : undefined, 'idle'),
    workflowName: first(source.workflowName, source.run?.workflowName, runDetail.workflowName, '当前运行'),
    startedAt: first(source.startedAt, source.run?.startedAt, runDetail.startedAt),
    durationMs: first(source.durationMs, source.run?.durationMs, runDetail.durationMs),
    summary: textOf(first(source.summary, result.summary, source.description, result.description)),
    finalStatus,
    outputResults: effectiveOutputs,
    processResults,
    coreText,
    finalFiles,
    processFiles,
    files: allFiles,
    links,
    input: textOf(first(source.input, source.inputs?.triggerInput, result.input, result.inputs?.triggerInput, runDetail.triggerInput, context.triggerInput)),
    nodeTimeline,
    runEvents,
    events: nodeTimeline,
    issues,
    raw: payload,
  };
}
