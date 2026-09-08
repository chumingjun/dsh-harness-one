// #105 修改类补丁应用前确认：性质判定与摘要（纯函数，App.jsx 与单测共用）。
// 「修改类」= 批内含 deleteNode 或 updateNode（renameNode 服务端归一为 updateNode）；
// 搭建类（新增为主）保持直接落图。
export const isModifyClassPatch = (ops) => (ops || []).some(
  (op) => op?.op === 'deleteNode' || op?.op === 'updateNode',
);

// 摘要文案：删除带节点名（点名最危险的操作），其余计类别数。
// nodes 是落图前的画布节点（React Flow 形状），用于 id→label。
export const summarizePendingOps = (ops, nodes) => {
  const labels = new Map((nodes || []).map((n) => [n.id, n.data?.label || n.id]));
  const deleted = [];
  const updated = new Set();
  let added = 0;
  let connected = 0;
  let deletedEdges = 0;
  for (const op of ops || []) {
    if (op?.op === 'deleteNode') deleted.push(labels.get(op.id) || op.id);
    else if (op?.op === 'updateNode') updated.add(labels.get(op.id) || op.id);
    else if (op?.op === 'addNode') added += 1;
    else if (op?.op === 'connect') connected += 1;
    else if (op?.op === 'deleteEdge') deletedEdges += 1;
  }
  const parts = [];
  if (deleted.length) parts.push(`删除 ${deleted.length} 个节点（${deleted.join('、')}）`);
  if (updated.size) parts.push(`修改 ${updated.size} 个节点`);
  if (added) parts.push(`新增 ${added} 个节点`);
  if (connected) parts.push(`新增 ${connected} 条连线`);
  if (deletedEdges) parts.push(`删除 ${deletedEdges} 条连线`);
  return parts.join('、') || '无变更';
};

export const PATCH_CONFIRM_TIMEOUT_MS = 30000;
