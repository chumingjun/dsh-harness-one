import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, relative } from 'node:path';
import { resolveInside, safeFileId } from './safe-path.js';

export const RUN_DOCUMENT_VERSION = 3;
export const REVIEW_STATUSES = new Set(['pending', 'accepted', 'rejected']);

const MIME_TYPES = {
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

const PREVIEWABLE = new Set([
  'application/json; charset=utf-8', 'image/jpeg', 'image/png', 'image/webp',
  'text/csv; charset=utf-8', 'text/html; charset=utf-8',
  'text/markdown; charset=utf-8', 'text/plain; charset=utf-8',
]);

const clone = (value) => value == null ? value : structuredClone(value);
const nodeLabel = (run, nodeId) => (run.graph?.nodes || []).find((node) => node.id === nodeId)?.data?.label || nodeId;
const artifactId = (nodeId, relativePath) => createHash('sha256').update(`${nodeId}\0${relativePath}`).digest('hex').slice(0, 24);
const asIso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function normalizeReview(value) {
  const review = value && typeof value === 'object' ? value : {};
  const status = REVIEW_STATUSES.has(review.status) ? review.status : 'pending';
  return {
    status,
    by: review.by == null ? null : String(review.by).slice(0, 80),
    comment: review.comment == null ? '' : String(review.comment).slice(0, 2000),
    updatedAt: asIso(review.updatedAt),
  };
}

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
  return {
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
    review: normalizeReview(value.review),
  };
}

export function snapshotRunArtifacts(runValue, { workspaceRoot, artifactRoot }) {
  const run = normalizeRunDocument(runValue);
  const runDir = resolveInside(artifactRoot, safeFileId(run.runId, 'invalid'));
  if (!runDir) throw new Error('非法 runId');
  mkdirSync(runDir, { recursive: true });
  const artifacts = [];
  const issues = [];
  const seen = new Set();

  for (const [nodeId, state] of Object.entries(run.nodeStates)) {
    const files = Array.isArray(state?.artifacts) ? state.artifacts : [];
    const workspace = resolveInside(workspaceRoot, safeFileId(nodeLabel(run, nodeId), 'agent'));
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
        const mediaType = MIME_TYPES[extname(relativePath).toLowerCase()] || 'application/octet-stream';
        artifacts.push({
          id,
          nodeId,
          nodeLabel: nodeLabel(run, nodeId),
          name: basename(String(relativePath)),
          relativePath: normalizedPath,
          size: stat.size,
          mediaType,
          previewable: PREVIEWABLE.has(mediaType),
          sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
          snapshot: `${safeFileId(run.runId, 'invalid')}/${id}`,
        });
      } catch (error) {
        issues.push({ code: 'artifact-snapshot-failed', nodeId, path: String(relativePath), message: String(error.message || error) });
      }
    }
  }
  return { artifacts, issues };
}

export function resolveRunArtifact(artifactRoot, run, requestedId) {
  const artifact = run.artifactIndex.find((item) => item.id === requestedId);
  if (!artifact?.snapshot) return null;
  const full = resolveInside(artifactRoot, artifact.snapshot);
  if (!full || !existsSync(full) || !statSync(full).isFile()) return null;
  const root = realpathSync(artifactRoot);
  const real = realpathSync(full);
  return resolveInside(root, real) === real ? { artifact, file: real } : null;
}

function resultRows(run) {
  const order = Array.isArray(run.nodeOrder) ? run.nodeOrder : Object.keys(run.outputs);
  return order.filter((nodeId) => Object.prototype.hasOwnProperty.call(run.outputs, nodeId)).map((nodeId) => ({
    nodeId,
    nodeLabel: nodeLabel(run, nodeId),
    nodeType: (run.graph?.nodes || []).find((node) => node.id === nodeId)?.type || null,
    status: run.nodeStates[nodeId]?.status || null,
    output: run.outputs[nodeId],
    structuredOutput: run.structuredOutputs[nodeId] || null,
  }));
}

export function createRunResults(value, { apiBase = '/wf1/api' } = {}) {
  const run = normalizeRunDocument(value);
  const results = resultRows(run);
  const primaryResult = [...results].reverse().find((item) => item.nodeType === 'output' && item.status === 'success')
    || [...results].reverse().find((item) => item.status === 'success') || null;
  const links = [];
  for (const [nodeId, state] of Object.entries(run.nodeStates)) {
    const url = state?.writeback?.url;
    if (url) links.push({ type: 'writeback', nodeId, nodeLabel: nodeLabel(run, nodeId), url: String(url) });
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
    primaryResult,
    results,
    artifacts: run.artifactIndex.map((artifact) => ({
      ...artifact,
      downloadUrl: `${apiBase}/run-artifact?run=${encodeURIComponent(run.runId)}&artifact=${encodeURIComponent(artifact.id)}`,
      previewUrl: artifact.previewable ? `${apiBase}/run-artifact?run=${encodeURIComponent(run.runId)}&artifact=${encodeURIComponent(artifact.id)}&preview=1` : null,
    })),
    links,
    inputs: { triggerInput: run.triggerInput ?? '', runInputs: run.runInputs },
    review: run.review,
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
