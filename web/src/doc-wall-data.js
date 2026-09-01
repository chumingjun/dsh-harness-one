// 文稿视图数据层：把一次运行的产物整理成「左侧节点列表 + 右侧文档条带」模型。
// 纯函数、零 React——照 run-view-state.js 惯例，全部可 node 直测。
// 事实源：adaptRunResults 产物（finalFiles/processFiles/节点时间线）。运行中的实时态
// （流卡/增量落卡）由 DocWallView 用 SSE props 叠加，不在这里建模。

export const DOC_CLIP_CHARS = 2000;      // 卡内渲染上限；全文只进预览弹窗
export const STRIP_CARD_LIMIT = 12;      // 单节点条带铺卡上限，超出出「还有 N 张」

const DOC_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'csv']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v']);

export function fileKind(file) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase();
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'data';
}

// 卡内正文截断：保留开头（标题结构在前文的概率远高于结尾）
export function clipDocContent(text, limit = DOC_CLIP_CHARS) {
  const raw = String(text || '');
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}…`;
}

function fileRow(file) {
  if (!file) return null;
  const kind = fileKind(file);
  return {
    id: file.id || `${file.nodeId || ''}:${file.name}`,
    nodeId: file.nodeId || null,
    nodeLabel: file.nodeLabel || null,
    name: file.name,
    path: file.path || file.relativePath || file.name,
    hasContent: Object.prototype.hasOwnProperty.call(file, 'content'),
    size: file.size ?? null,
    kind,
    previewUrl: file.previewUrl || null,
    downloadUrl: file.downloadUrl || file.url || null,
    content: kind === 'doc' ? clipDocContent(file.content || '') : '',
    finishedAt: file.finishedAt || null, // 新卡高亮：完成时间晚于上次已读即标新
  };
}

function stripFor(docs) {
  const shown = docs.slice(0, STRIP_CARD_LIMIT);
  return { docs: shown, hidden: docs.length - shown.length };
}

// 文件 → 节点分桶。file.nodeId 缺失（legacy 清单只有 nodeLabel）时按 label 匹配。
function bucketFilesByNode(files, nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, []]));
  const byLabel = new Map(nodes.map((node) => [node.nodeLabel, node.nodeId]));
  for (const file of files) {
    const row = fileRow(file);
    if (!row) continue;
    const nodeId = row.nodeId && byId.has(row.nodeId) ? row.nodeId : byLabel.get(row.nodeLabel);
    if (nodeId && byId.has(nodeId)) byId.get(nodeId).push(row);
  }
  return byId;
}

/**
 * buildDocWallModel({ runResults, progressByNode, nodeStates, scopedArtifactUrl }) →
 * {
 *   runId, workflowName, status, hasRun,
 *   finals: { docs, hidden, links },
 *   nodes: [{ nodeId, nodeLabel, status, kind, docs, hidden, dataFiles, durationMs, error, live }],
 *   totals: { docs, dataFiles, images, videos },
 * }
 * - nodes 按执行拓扑序（run-results 的 nodeTimeline 已排好）
 * - doc 类铺卡；data 类折 chip（files.label/ext 汇总）
 * - live：progressByNode 有该节点即运行中（流卡由视图层渲染，这里只标状态）
 * - scopedArtifactUrl(runId, nodeId, path)：nodeStates 产物的 scoped URL 工厂（apiUrl 包装），
 *   缺省退化为裸 /wf1/api/artifact 形状（纯测试环境无 sessionId 注入）
 */
export function buildDocWallModel({ runResults, progressByNode = {}, nodeStates = {}, scopedArtifactUrl } = {}) {
  const run = runResults || {};
  const timeline = Array.isArray(run.nodeTimeline) ? run.nodeTimeline : [];
  const artifactUrlFor = (nodeId, path) => (scopedArtifactUrl
    ? scopedArtifactUrl(run.runId || '', nodeId, path)
    : `/wf1/api/artifact?run=${encodeURIComponent(run.runId || '')}&node=${encodeURIComponent(nodeId)}&file=${encodeURIComponent(String(path))}`);

  const finalsDocs = [];
  const finalsLinks = [];
  for (const file of run.finalFiles || []) {
    const row = fileRow(file);
    if (row) finalsDocs.push(row);
  }
  for (const link of run.links || []) {
    if (link?.type === 'writeback' || link?.url) finalsLinks.push({ label: link.nodeLabel ? `${link.nodeLabel} 链接` : (link.url || ''), url: link.url });
  }
  const finalsStrip = stripFor(finalsDocs);

  const processRows = timeline.filter((row) => !(row.nodeType === 'output' || run.outputResults?.some((o) => o.nodeId === row.nodeId)));
  const nodes = processRows.map((row) => ({
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel || row.nodeId,
    status: row.status || 'pending',
    kind: row.nodeType || null,
    docs: [],
    dataFiles: [],
    durationMs: row.durationMs ?? null,
    error: row.error || null,
    live: Boolean(progressByNode[row.nodeId]),
  }));

  const stateArtifacts = [];
  for (const [nodeId, state] of Object.entries(nodeStates || {})) {
    for (const path of state?.artifacts || []) {
      const name = String(path).split('/').filter(Boolean).at(-1) || String(path);
      stateArtifacts.push({
        name,
        path: String(path),
        nodeId,
        // 节点工作区产物走 scoped artifact 路由（run + node + file 定位）；不可预览的类型 DocumentPreviewButton 自行隐藏
        previewUrl: `${artifactUrlFor(nodeId, String(path))}&preview=1`,
        downloadUrl: artifactUrlFor(nodeId, String(path)),
        // 新卡高亮用：stateArtifacts 无单文件时间，继承运行完成时间（比上次已读晚即视为新）
        finishedAt: run.finishedAt || null,
      });
    }
  }
  // 分桶挂回节点：doc 铺卡、data 折 chip。去重时带 downloadUrl 的行优先——
  // adaptRunResults 派生的 processFiles 只有名字没 URL，会被同键的 stateArtifacts（scoped URL）覆盖
  const dedupeFiles = (files) => {
    const byKey = new Map();
    for (const file of files) {
      const key = `${file.nodeId || ''}:${file.name}`;
      const prev = byKey.get(key);
      if (!prev || (!prev.downloadUrl && file.downloadUrl)) byKey.set(key, file);
    }
    return [...byKey.values()];
  };
  const buckets = bucketFilesByNode(dedupeFiles([...(run.processFiles || []), ...stateArtifacts]), nodes);
  for (const node of nodes) {
    const files = buckets.get(node.nodeId) || [];
    node.docs = files.filter((file) => file.kind === 'doc' || file.kind === 'image' || file.kind === 'video');
    node.dataFiles = files.filter((file) => file.kind === 'data');
  }
  const finalsStripDocs = finalsDocs;
  return {
    runId: run.runId || null,
    workflowName: run.workflowName || null,
    status: run.status || null,
    hasRun: Boolean(run.runId),
    finals: { docs: finalsStrip.docs, hidden: finalsStrip.hidden, links: finalsLinks },
    nodes,
    totals: {
      docs: finalsStripDocs.length + nodes.reduce((sum, node) => sum + node.docs.length, 0),
      dataFiles: nodes.reduce((sum, node) => sum + node.dataFiles.length, 0),
      images: nodes.reduce((sum, node) => sum + node.docs.filter((d) => d.kind === 'image').length, 0),
      videos: nodes.reduce((sum, node) => sum + node.docs.filter((d) => d.kind === 'video').length, 0),
    },
  };
}
