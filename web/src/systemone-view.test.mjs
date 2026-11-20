// systemone 前端纯逻辑单测：边标签映射 / 分支 chips / 自动分配 / 概率排序 / 判决色调。
// 用法：node web/src/systemone-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  edgeBranchLabel, systemOneBranchChips, nextSystemOneBranch, sortedProbabilities, verdictTone,
} from './systemone-view.js';

test('边标签：condition 保持 是/否', () => {
  assert.equal(edgeBranchLabel({ nodeType: 'condition' }, 'true'), '是');
  assert.equal(edgeBranchLabel({ nodeType: 'condition' }, 'false'), '否');
});

test('边标签：systemone noul 判决集中文映射', () => {
  const d = { nodeType: 'systemone', mode: 'noul' };
  assert.equal(edgeBranchLabel(d, 'yes'), '是');
  assert.equal(edgeBranchLabel(d, 'no'), '否');
  assert.equal(edgeBranchLabel(d, 'unsettled'), '待定');
});

test('边标签：choice 选项名原样；无 branch → undefined；未知类型保留旧映射', () => {
  assert.equal(edgeBranchLabel({ nodeType: 'systemone', mode: 'choice' }, 'refund'), 'refund');
  assert.equal(edgeBranchLabel({ nodeType: 'systemone' }, undefined), undefined);
  assert.equal(edgeBranchLabel({ nodeType: 'agent' }, 'true'), '是');
  assert.equal(edgeBranchLabel({}, 'custom'), 'custom');
});

test('chips：noul 三判决 / choice 选项 / score 空', () => {
  assert.deepEqual(systemOneBranchChips({ mode: 'noul' }), [['yes', '是'], ['no', '否'], ['unsettled', '待定']]);
  assert.deepEqual(systemOneBranchChips({ mode: 'choice', options: [{ name: 'refund', description: 'x' }, { name: 'shipping', description: 'y' }] }), [['refund', 'refund'], ['shipping', 'shipping']]);
  assert.deepEqual(systemOneBranchChips({ mode: 'choice', options: [{ name: ' ', description: 'x' }, { name: 'a', description: 'y' }] }), [['a', 'a']]);
  assert.deepEqual(systemOneBranchChips({ mode: 'score' }), []);
  assert.deepEqual(systemOneBranchChips({}), [['yes', '是'], ['no', '否'], ['unsettled', '待定']]);
});

test('自动分配：按序补未用分支，全用过 → undefined', () => {
  const noul = { mode: 'noul' };
  assert.equal(nextSystemOneBranch(noul, []), 'yes');
  assert.equal(nextSystemOneBranch(noul, ['yes']), 'no');
  assert.equal(nextSystemOneBranch(noul, ['yes', 'no']), 'unsettled');
  assert.equal(nextSystemOneBranch(noul, ['yes', 'no', 'unsettled']), undefined);
  const choice = { mode: 'choice', options: [{ name: 'refund' }, { name: 'shipping' }] };
  assert.equal(nextSystemOneBranch(choice, ['refund']), 'shipping');
  assert.equal(nextSystemOneBranch(choice, ['refund', 'shipping']), undefined);
  assert.equal(nextSystemOneBranch({ mode: 'score' }, []), undefined);
});

test('概率排序：降序，空值安全', () => {
  assert.deepEqual(sortedProbabilities({ a: 0.2, b: 0.7, c: 0.1 }), [['b', 0.7], ['a', 0.2], ['c', 0.1]]);
  assert.deepEqual(sortedProbabilities(null), []);
  assert.deepEqual(sortedProbabilities(undefined), []);
});

test('判决色调：noul 三态，其余 neutral', () => {
  assert.equal(verdictTone({ mode: 'noul', verdict: 'yes', value: 0.99 }), 'yes');
  assert.equal(verdictTone({ mode: 'noul', verdict: 'no', value: 0.1 }), 'no');
  assert.equal(verdictTone({ mode: 'noul', verdict: 'unsettled', value: 0.5 }), 'unsettled');
  assert.equal(verdictTone({ mode: 'choice', verdict: 'refund' }), 'neutral');
  assert.equal(verdictTone({ mode: 'score', value: 1.5 }), 'neutral');
  assert.equal(verdictTone(null), 'neutral');
});
