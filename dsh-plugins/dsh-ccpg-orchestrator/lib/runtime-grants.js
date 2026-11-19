// 高权限运行授权（设计 §18.1）：节点数据本身不是授权证据。
// 含 elevated 节点（codex full / claude bash|full）的工作流，启动前须有运行者
// 显式确认过的 grant，且与当前 elevated 集合逐节点精确匹配；集合变化即失配重确认。
// 覆盖手动/助手/trigger/schedule/catch-up（共享 startWorkflowRun 与 /run 两入口）。
// pi 不在此列：它由实例级 enablePiRuntime 门禁管（开关警示已声明覆盖自动触发）。
// 本模块只做纯逻辑；文件读写在 index.js（工作区 state/runtime-grants.json，atomicJson）。

import { resolveRuntimePermission, isElevatedPermission } from './runtime-cli.js';

/** 从图提取 elevated 集合：{ [nodeId]: { runtime, permission } }。非法权限值按原样记入，
 *  让授权弹窗如实展示（执行时另行 fail-closed），不在此处吞错。 */
export function elevatedSetOf(graph) {
  const set = {};
  for (const node of graph?.nodes || []) {
    if (node?.type !== 'agent') continue;
    const runtime = String(node.data?.runtime || 'dsh').trim() || 'dsh';
    if (runtime === 'dsh') continue;
    let permission;
    try { permission = resolveRuntimePermission(runtime, node.data?.runtimePermission); }
    catch { permission = String(node.data?.runtimePermission); } // 非法值：留待执行拒绝
    if (!isElevatedPermission(runtime, permission)) continue;
    set[node.id] = { runtime, permission };
  }
  return set;
}

/** 逐节点精确匹配（键集合 + 每节点 runtime/permission 全等）；顺序无关。 */
export function grantMatches(grant, elevated) {
  const granted = grant?.elevated;
  if (!granted || typeof granted !== 'object') return false;
  const wantKeys = Object.keys(elevated);
  const gotKeys = Object.keys(granted);
  if (wantKeys.length !== gotKeys.length) return false;
  return wantKeys.every((id) => granted[id]
    && granted[id].runtime === elevated[id].runtime
    && granted[id].permission === elevated[id].permission);
}

/** 授权清单（弹窗用）：label + runtime + permission。 */
export function elevatedListOf(graph, elevated) {
  return Object.keys(elevated).map((id) => {
    const node = (graph?.nodes || []).find((n) => n.id === id);
    return { nodeId: id, label: node?.data?.label || id, ...elevated[id] };
  });
}
