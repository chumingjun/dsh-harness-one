import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, relative } from 'node:path';
import { resolveInside, safeFileId } from './safe-path.js';

export const RUN_DOCUMENT_VERSION = 3;

const MIME_TYPES = {
  '.avif': 'image/avif',
  '.csv': 'text/csv; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mdown': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const PREVIEWABLE = new Set([
  'application/json', 'application/pdf', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'text/csv', 'text/html', 'text/markdown', 'text/plain',
]);

const baseMediaType = (value) => String(value || '').split(';', 1)[0].trim().toLowerCase();

export function mediaTypeFor(filename) {
  return MIME_TYPES[extname(String(filename || '')).toLowerCase()] || 'application/octet-stream';
}

export function isPreviewableMediaType(mediaType) {
  return PREVIEWABLE.has(baseMediaType(mediaType));
}

export function parseByteRange(rangeHeader, size) {
  if (rangeHeader == null || String(rangeHeader).trim() === '') return null;
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer');
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return { unsatisfiable: true };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return { unsatisfiable: true };
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function streamArtifactResponse(req, res, { file, filename, mediaType, preview = false }) {
  const size = statSync(file).size;
  const range = parseByteRange(req.headers?.range, size);
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mediaType || 'application/octet-stream',
    'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'X-Content-Type-Options': 'nosniff',
  };
  if (preview && baseMediaType(mediaType) === 'text/html') {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  }
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${size}` });
    res.end();
    return null;
  }

  const status = range ? 206 : 200;
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  headers['Content-Length'] = String(range ? end - start + 1 : size);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  const stream = createReadStream(file, range ? { start, end } : undefined);
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
  return stream;
}

const clone = (value) => value == null ? value : structuredClone(value);
const nodeLabel = (run, nodeId) => (run.graph?.nodes || []).find((node) => node.id === nodeId)?.data?.label || nodeId;
const artifactId = (nodeId, relativePath) => createHash('sha256').update(`${nodeId}\0${relativePath}`).digest('hex').slice(0, 24);
const asIso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function normalizeRunDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('运行文档必须是对象');
  const sourceVersion = Number(value.schemaVersion || 1);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > RUN_DOCUMENT_VERSION) {
    throw new Error(`不支持的运行文档版本: ${value.schemaVersion}`);
  }
  const startedAt = asIso(value.startedAt);
  const durationMs = Number.isFinite(Number(value.durationMs)) ? Math.max(0, Number(value.durationMs)) : null;
  const finishedAt = asIso(value.finishedAt)
    || (startedAt && durationMs != null ? new Date(new Date(startedAt).getTime() + durationMs).toISOString() : null);
  const document = {
    ...clone(value),
    schemaVersion: RUN_DOCUMENT_VERSION,
    startedAt,
    finishedAt,
    durationMs,
    runInputs: clone(value.runInputs && typeof value.runInputs === 'object' ? value.runInputs : {}),
    nodeStates: clone(value.nodeStates && typeof value.nodeStates === 'object' ? value.nodeStates : {}),
    outputs: clone(value.outputs && typeof value.outputs === 'object' ? value.outputs : {}),
    structuredOutputs: clone(value.structuredOutputs && typeof value.structuredOutputs === 'object' ? value.structuredOutputs : {}),
    artifactIndex: Array.isArray(value.artifactIndex) ? clone(value.artifactIndex) : [],
  };
  delete document.review;
  delete document.acceptance;
  return document;
}

function runArtifactDirectory(run, { artifactRoot, artifactRunDir, runArtifactDir }) {
  const directRunDir = artifactRunDir || runArtifactDir;
  if (directRunDir) return directRunDir;
  const runDir = artifactRoot && resolveInside(artifactRoot, safeFileId(run.runId, 'invalid'));
  if (!runDir) throw new Error(artifactRoot ? '非法 runId' : '缺少 artifactRoot 或 artifactRunDir');
  return runDir;
}

export function snapshotRunArtifacts(runValue, {
  workspaceRoot,
  workspaceForNode,
  artifactRoot,
  artifactRunDir,
  runArtifactDir,
}) {
  const run = normalizeRunDocument(runValue);
  const directRunDir = artifactRunDir || runArtifactDir;
  const runDir = runArtifactDirectory(run, { artifactRoot, artifactRunDir, runArtifactDir });
  mkdirSync(runDir, { recursive: true });
  const artifacts = [];
  const issues = [];
  const seen = new Set();

  for (const [nodeId, state] of Object.entries(run.nodeStates)) {
    const files = Array.isArray(state?.artifacts) ? state.artifacts : [];
    const workspace = typeof workspaceForNode === 'function'
      ? workspaceForNode({
        workflowId: run.workflowId,
        runId: run.runId,
        nodeId,
        nodeLabel: nodeLabel(run, nodeId),
      })
      : workspaceRoot && resolveInside(workspaceRoot, safeFileId(nodeLabel(run, nodeId), 'agent'));
    for (const relativePath of files) {
      if (!relativePath || String(relativePath).endsWith('/')) continue;
      const source = workspace && resolveInside(workspace, relativePath);
      try {
        if (!workspace || !source || !existsSync(source) || !statSync(source).isFile()) throw new Error('文件不存在');
        const realWorkspace = realpathSync(workspace);
        const realSource = realpathSync(source);
        if (resolveInside(realWorkspace, realSource) !== realSource) throw new Error('路径越界');
        const normalizedPath = relative(realWorkspace, realSource).replace(/\\/g, '/');
        const dedupeKey = `${nodeId}\0${normalizedPath}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const id = artifactId(nodeId, normalizedPath);
        const target = resolveInside(runDir, id);
        if (!target) throw new Error('快照路径非法');
        if (!existsSync(target)) copyFileSync(realSource, target, fsConstants.COPYFILE_EXCL);
        const stat = statSync(target);
        const mediaType = mediaTypeFor(relativePath);
        artifacts.push({
          id,
          nodeId,
          nodeLabel: nodeLabel(run, nodeId),
          name: basename(String(relativePath)),
          relativePath: normalizedPath,
          size: stat.size,
          mediaType,
          previewable: isPreviewableMediaType(mediaType),
          sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
          snapshot: directRunDir ? id : `${safeFileId(run.runId, 'invalid')}/${id}`,
        });
      } catch (error) {
        issues.push({ code: 'artifact-snapshot-failed', nodeId, path: String(relativePath), message: String(error.message || error) });
      }
    }
  }
  return { artifacts, issues };
}

function artifactRoots(value) {
  if (Array.isArray(value)) return value.flatMap(artifactRoots);
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  return [
    ...artifactRoots(value.artifactRoots),
    ...artifactRoots(value.artifactRoot),
    ...artifactRoots(value.artifactRunDirs),
    ...artifactRoots(value.artifactRunDir),
    ...artifactRoots(value.runArtifactDirs),
    ...artifactRoots(value.runArtifactDir),
  ];
}

function artifactCandidates(run, artifact) {
  const snapshot = String(artifact.snapshot || '');
  const runId = safeFileId(run.runId, 'invalid');
  return [...new Set([
    snapshot,
    `${runId}/${artifact.id}`,
    artifact.id,
    basename(snapshot),
  ].filter(Boolean))];
}

export function resolveRunArtifact(artifactRoot, run, requestedId) {
  const artifact = run.artifactIndex.find((item) => item.id === requestedId);
  if (!artifact?.snapshot) return null;
  for (const candidateRoot of artifactRoots(artifactRoot)) {
    if (!existsSync(candidateRoot) || !statSync(candidateRoot).isDirectory()) continue;
    const root = realpathSync(candidateRoot);
    for (const candidate of artifactCandidates(run, artifact)) {
      const full = resolveInside(root, candidate);
      if (!full || !existsSync(full) || !statSync(full).isFile()) continue;
      const real = realpathSync(full);
      if (resolveInside(root, real) === real) return { artifact, file: real };
    }
  }
  return null;
}

function nodeType(node) {
  return node?.type || node?.data?.nodeType || null;
}

function isRuntimeNode(node) {
  return nodeType(node) !== 'note';
}

function orderedGraphNodes(run) {
  const nodes = (Array.isArray(run.graph?.nodes) ? run.graph.nodes : []).filter(isRuntimeNode);
  if (!nodes.length) {
    const ids = [...new Set([...(run.nodeOrder || []), ...Object.keys(run.nodeStates), ...Object.keys(run.outputs)])];
    return ids.map((id) => ({ id, type: null, data: { label: id } }));
  }
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of run.graph?.edges || []) {
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

function resultRow(run, node) {
  const state = run.nodeStates[node.id] || {};
  return {
    nodeId: node.id,
    nodeLabel: node.data?.label || node.id,
    nodeType: nodeType(node),
    status: state.status || 'pending',
    output: Object.prototype.hasOwnProperty.call(run.outputs, node.id) ? run.outputs[node.id] : null,
    structuredOutput: run.structuredOutputs[node.id] || null,
    error: state.error || state.toleratedError || null,
    durationMs: state.durationMs ?? null,
  };
}

function processText(row) {
  if (row.error) return row.error;
  if (row.status === 'success') return '节点已完成';
  if (row.status === 'running') return '节点正在执行';
  if (row.status === 'queued' || row.status === 'pending') return '节点等待执行';
  if (row.status === 'waiting') return '节点等待审批';
  if (row.status === 'skipped') return '本次流程未执行该节点';
  if (row.status === 'canceled') return '节点已取消';
  return `节点状态：${row.status}`;
}

function extractHttpLinks(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>()\[\]"']+/gi) || [];
  return [...new Set(matches)].map((url) => ({ type: 'output', url }));
}

export function createRunResults(value, { apiBase = '/wf1/api' } = {}) {
  const run = normalizeRunDocument(value);
  const rows = orderedGraphNodes(run).map((node) => resultRow(run, node));
  const configuredOutputs = rows.filter((row) => row.nodeType === 'output');
  const successfulOutputs = configuredOutputs.filter((row) => row.status === 'success' && row.output != null);
  const legacyResult = configuredOutputs.length === 0
    ? [...rows].reverse().find((row) => row.status === 'success' && row.output != null) || null
    : null;
  const outputResults = configuredOutputs.length ? configuredOutputs : (legacyResult ? [{ ...legacyResult, legacyInferred: true }] : []);
  const processResults = rows.filter((row) => row.nodeType !== 'output');
  const finalStatus = configuredOutputs.length === 0
    ? (legacyResult ? 'legacy-inferred' : 'unavailable')
    : successfulOutputs.length === configuredOutputs.length
      ? 'available'
      : successfulOutputs.length > 0 ? 'partial' : 'unavailable';
  const artifacts = run.artifactIndex.map((artifact) => ({
    id: artifact.id,
    nodeId: artifact.nodeId,
    nodeLabel: artifact.nodeLabel,
    name: artifact.name,
    size: artifact.size,
    mediaType: artifact.mediaType,
    previewable: Boolean(artifact.previewable),
    sha256: artifact.sha256,
    downloadUrl: `${apiBase}/run-artifact?run=${encodeURIComponent(run.runId)}&artifact=${encodeURIComponent(artifact.id)}`,
    previewUrl: artifact.previewable ? `${apiBase}/run-artifact?run=${encodeURIComponent(run.runId)}&artifact=${encodeURIComponent(artifact.id)}&preview=1` : null,
  }));
  const outputNodeIds = new Set(configuredOutputs.map((row) => row.nodeId));
  const outputArtifacts = artifacts.filter((artifact) => outputNodeIds.has(artifact.nodeId));
  const isTechnicalArtifact = (artifact) => Number(artifact.size) === 0
    || /^fetch_err[^/]*\.json$/i.test(String(artifact.name || ''))
    || /\.log$/i.test(String(artifact.name || ''));
  const finalArtifacts = outputArtifacts.length
    ? outputArtifacts
    : artifacts.filter((artifact) => !isTechnicalArtifact(artifact));
  const finalArtifactIds = new Set(finalArtifacts.map((artifact) => artifact.id));
  const processArtifacts = artifacts.filter((artifact) => !finalArtifactIds.has(artifact.id));
  const links = [];
  for (const row of outputResults) {
    for (const link of extractHttpLinks(row.output)) links.push({ ...link, nodeId: row.nodeId, nodeLabel: row.nodeLabel });
    const url = run.nodeStates[row.nodeId]?.writeback?.url;
    if (url) links.push({ type: 'writeback', nodeId: row.nodeId, nodeLabel: row.nodeLabel, url: String(url) });
  }
  const issues = [
    ...(Array.isArray(run.issues) ? run.issues : []),
    ...Object.entries(run.nodeStates).flatMap(([nodeId, state]) => state?.error || state?.toleratedError ? [{
      code: state.error ? 'node-error' : 'node-tolerated-error', nodeId, nodeLabel: nodeLabel(run, nodeId),
      message: String(state.error || state.toleratedError),
    }] : []),
  ];
  return {
    runId: run.runId,
    status: run.status,
    workflowName: run.workflowName || null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    finalStatus,
    outputResults,
    processResults,
    nodeTimeline: rows.map((row) => ({ ...row, text: processText(row) })),
    primaryResult: successfulOutputs[0] || legacyResult,
    results: rows,
    artifacts,
    finalArtifacts,
    processArtifacts,
    links,
    inputs: { triggerInput: run.triggerInput ?? '', runInputs: run.runInputs },
    issues,
  };
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/'));
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(0, 10); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

export function createRunExport(run, artifactRoot) {
  const results = createRunResults(run);
  const entries = [{ name: 'run-results.json', data: JSON.stringify(results, null, 2) }];
  for (const artifact of run.artifactIndex) {
    const resolved = resolveRunArtifact(artifactRoot, run, artifact.id);
    if (resolved) entries.push({
      name: `artifacts/${safeFileId(artifact.nodeLabel, artifact.nodeId)}/${artifact.relativePath}`,
      data: readFileSync(resolved.file),
    });
  }
  return createZip(entries);
}
