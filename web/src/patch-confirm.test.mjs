import assert from 'node:assert/strict';
import { isModifyClassPatch, summarizePendingOps, PATCH_CONFIRM_TIMEOUT_MS } from './patch-confirm.js';

// 判定：deleteNode/updateNode → 修改类；纯新增/连线 → 搭建类
assert.equal(isModifyClassPatch([{ op: 'addNode' }, { op: 'connect' }]), false);
assert.equal(isModifyClassPatch([{ op: 'addNode' }, { op: 'updateNode', id: 'a', data: {} }]), true);
assert.equal(isModifyClassPatch([{ op: 'deleteNode', id: 'a' }]), true);
assert.equal(isModifyClassPatch(null), false);
assert.equal(isModifyClassPatch([]), false);

// 摘要：删除带节点名、各类别计数、连本文案
const nodes = [
  { id: 'n1', data: { label: '工单输出' } },
  { id: 'n2', data: {} }, // 无 label 回退 id
  { id: 'n3', data: { label: '分类智能体' } },
];
const summary = summarizePendingOps(
  [
    { op: 'deleteNode', id: 'n1' },
    { op: 'updateNode', id: 'n3', data: { prompt: 'x' } },
    { op: 'updateNode', id: 'n3', data: { model: 'y' } }, // 同节点两次修改计 1
    { op: 'addNode', id: 'n9' },
    { op: 'connect', id: 'e1' },
  ],
  nodes,
);
assert.equal(summary, '删除 1 个节点（工单输出）、修改 1 个节点、新增 1 个节点、新增 1 条连线');

assert.equal(summarizePendingOps([], nodes), '无变更');
assert.equal(summarizePendingOps([{ op: 'deleteNode', id: 'ghost' }], nodes), '删除 1 个节点（ghost）');
assert.equal(summarizePendingOps([{ op: 'deleteEdge', id: 'e2' }], nodes), '删除 1 条连线');

assert.equal(PATCH_CONFIRM_TIMEOUT_MS, 30000);
console.log('patch-confirm tests: passed');
