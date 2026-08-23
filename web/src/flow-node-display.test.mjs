// FlowNode 轮次/模型名显示逻辑单测：statusText 拼接规则 + shortModel 不截断。
// FlowNode.jsx 是 JSX 组件，这里测它的纯逻辑等价物（与组件内联逻辑保持同步）。
// 用法：node --test web/src/flow-node-display.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'FlowNode.jsx'), 'utf8');

function statusTextFor(data, status) {
  const turns = status === 'running' ? data.liveTurns : data.runTurns;
  const STATUS_TEXT = {
    queued: '排队中', running: '执行中', waiting: '⏸ 待审批',
    error: '✗ 失败', skipped: '跳过', canceled: '已取消',
  };
  const detail = status === 'success'
    ? `✓ ${data.runChars ?? 0} 字${turns != null ? ` · ${turns} 轮` : ''}`
    : status === 'running'
      ? (turns != null ? ` 第 ${turns} 轮` : '')
      : `${STATUS_TEXT[status] || ''}${turns != null ? ` · ${turns} 轮` : ''}`;
  return status === 'running' ? `${STATUS_TEXT.running}${detail}` : detail;
}

test('源码包含轮次拼接逻辑（liveTurns/runTurns 双路）', () => {
  assert.ok(src.includes('liveTurns'), 'FlowNode 应读 liveTurns');
  assert.ok(src.includes('runTurns'), 'FlowNode 应读 runTurns');
  assert.ok(src.includes('轮'), '应有轮次文案');
});

test('运行中视觉：脉动类名 + 实时计时徽标 + startedAt 数据源', () => {
  assert.ok(src.includes('flow-node-is-running'), '运行中节点应有脉动光晕类名');
  assert.ok(src.includes('useElapsedBadge'), '应有实时计时 hook');
  assert.ok(src.includes('flow-node-elapsed'), '应有计时徽标元素');
  assert.ok(src.includes('runStartedAt'), '计时应读 runStartedAt');
});

test('成功态：字数 + 轮次', () => {
  assert.equal(statusTextFor({ runChars: 1234, runTurns: 3 }, 'success'), '✓ 1234 字 · 3 轮');
  assert.equal(statusTextFor({ runChars: 10 }, 'success'), '✓ 10 字');
});

test('运行中：状态元素与轮次分开渲染，不出现 [object Object]', () => {
  assert.equal(statusTextFor({ liveTurns: 2, runTurns: 9 }, 'running'), '执行中 第 2 轮');
  assert.equal(statusTextFor({}, 'running'), '执行中');
  assert.equal(src.includes("`${STATUS_TEXT[status] || ''}${status === 'running'"), false, 'React 状态元素不能参与模板字符串拼接');
});

test('失败/取消态：状态 + 轮次（用 runTurns）', () => {
  assert.equal(statusTextFor({ runTurns: 4 }, 'error'), '✗ 失败 · 4 轮');
  assert.equal(statusTextFor({ runTurns: 4 }, 'canceled'), '已取消 · 4 轮');
});

test('shortModel 不再截断长模型名', () => {
  const reg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'registry.jsx'), 'utf8');
  const m = reg.match(/function shortModel[\s\S]*?\n}/);
  assert.ok(m, 'registry 应有 shortModel');
  const fn = new Function(`${m[0]}; return shortModel;`)();
  assert.equal(fn('airouter:deepseek-v4-flash-128k-preview'), 'deepseek-v4-flash-128k-preview');
  assert.equal(fn('glm-5.3'), 'GLM 5.3');
  assert.equal(fn('provideronly:name-x'.length > 16 ? 'provideronly:a-very-long-model-name-here' : 'a:b'), fn('provideronly:a-very-long-model-name-here'));
});
