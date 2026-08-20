// shared/chat-pane.js 单测：事件流→渲染项的解析规则 + createChatPane 工厂冒烟。
// 片段不是模块（构建期内联进插件 bundle），用 new Function 包装源文本取回函数。
// 用法：node --test shared/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'chat-pane.js'), 'utf8');
const sandbox = new Function(`${src}; return { ccpgChatHistoryToItems, ccpgChatTextOf, createChatPane, ccpgChatPaneApiCall, ccpgMdBlocks };`)();
const { ccpgChatHistoryToItems, createChatPane, ccpgMdBlocks } = sandbox;

const userMsg = (text, extra = {}) => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra },
});

test('user/assistant/tool 事件映射为渲染项', () => {
  const items = ccpgChatHistoryToItems({ events: [
    userMsg('你好'),
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } },
    { type: 'tool/call', data: { name: 'web_search', arguments: JSON.stringify({ q: 'x' }) } },
  ] });
  assert.deepEqual(items, [
    { kind: 'user', text: '你好' },
    { kind: 'ai', text: '在的' },
    { kind: 'tool', name: 'web_search', text: '{"q":"x"}' },
  ]);
});

test('事件可裸可包在 {event:…} 信封里（官方信封兼容）', () => {
  const bare = ccpgChatHistoryToItems({ events: [userMsg('a')] });
  const wrapped = ccpgChatHistoryToItems({ events: [{ event: userMsg('a') }] });
  assert.equal(bare.length, 1);
  assert.deepEqual(wrapped, bare);
});

test('user 文本兼容 data.message.content 形态', () => {
  const items = ccpgChatHistoryToItems({ events: [{
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: 'hello' }] }, source: { kind: 'user' } },
  }] });
  assert.equal(items[0]?.text, 'hello');
});

test('系统注入（source.kind 非 user）跳过，不显示为用户消息', () => {
  const items = ccpgChatHistoryToItems({ events: [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'skill snapshot' }], source: { kind: 'plugin' } } },
  ] });
  assert.equal(items.length, 0);
});

test('连续重复 user 消息去重（重发绑定场景）', () => {
  const items = ccpgChatHistoryToItems({ events: [userMsg('同句'), userMsg('同句')] });
  assert.equal(items.length, 1);
});

test('formatTool 命中时替换默认摘要，返回空/抛错回退 JSON 截断', () => {
  const events = { events: [
    { type: 'tool/call', data: { name: 'canvas_graph_patch', arguments: JSON.stringify({ ops: [1, 2, 3] }) } },
    { type: 'tool/call', data: { name: 'boom', arguments: '{}' } },
    { type: 'tool/call', data: { name: 'plain', arguments: 'not-json' } },
  ] };
  const items = ccpgChatHistoryToItems(events, (name, args) => {
    if (name === 'canvas_graph_patch' && args?.ops) return `${args.ops.length} 个操作`;
    if (name === 'boom') throw new Error('x');
    return '';
  });
  assert.equal(items[0].text, '3 个操作');
  assert.equal(items[1].text, '{}');
  assert.equal(items[2].text, 'not-json'); // 非 JSON 参数走 String 截断兜底
});

test('paused=true 时挂起轮询不发请求，恢复后立即补拉', async () => {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    head: { appendChild: () => {} },
  };
  const effects = [];
  const slots = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: () => ({ current: null }),
    useState: (init) => {
      const i = slots.length;
      slots.push(init);
      return [init, (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useEffect: (fn) => effects.push(fn),
  };
  const seen = [];
  const ChatPane = createChatPane(react, {
    pollMs: 5, apiCall: (method, payload) => { seen.push(payload.sessionId); return Promise.resolve({ events: [] }); },
  });

  // 挂载即 paused：一个请求都不该发
  let clean1 = [];
  ChatPane({ sessionId: 'p1', paused: true });
  effects.forEach((fn) => clean1.push(fn()));
  await new Promise((r) => setTimeout(r, 20));
  clean1.forEach((fn) => fn && fn());
  assert.equal(seen.length, 0, 'paused 期间不应发请求');

  // 恢复可见：重渲染 + 重放挂载 effect（真实 React 中 effect 已在挂载时建立循环，
  // 桩里循环被 cleanup 停掉了，需重新驱动一次以模拟持续轮询中的恢复）
  const clean2 = [];
  ChatPane({ sessionId: 'p1', paused: false });
  effects.forEach((fn) => clean2.push(fn()));
  await new Promise((r) => setTimeout(r, 15));
  clean2.forEach((fn) => fn && fn());
  assert.ok(seen.length >= 1, '恢复后应补拉');
});

test('ccpgMdBlocks：标题/列表/表格/代码块/行内标记解析为对应元素', () => {
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };
  const md = [
    '# 标题',
    '',
    '段落有 **加粗**、`代码`、[链接](https://a.b) 与 *斜体*',
    '- 项目一',
    '- 项目二',
    '',
    '| 列 | 值 |',
    '| --- | --- |',
    '| a | 1 |',
    '| b | 2 |',
    '',
    '```sh',
    'echo hi',
    '```',
    '> 引用一行',
  ].join('\n');
  const blocks = ccpgMdBlocks(react, md);
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['h1', 'p', 'ul', 'table', 'pre', 'blockquote']);
  // 行内：段落 children（createElement 展开后是平铺数组）含 strong/code/a
  const inlineKinds = blocks[1].children.map((c) => (typeof c === 'string' ? 'text' : c.type));
  assert.ok(Array.isArray(inlineKinds) && inlineKinds.includes('strong') && inlineKinds.includes('code') && inlineKinds.includes('a'), JSON.stringify(inlineKinds));
  // 表格：thead 2 列 + tbody 2 行
  const table = blocks[3];
  assert.equal(table.children[0].children[0].children.length, 2);
  assert.equal(table.children[1].children.length, 2);
  // 代码块内容原样
  assert.equal(blocks[4].children[0].children[0], 'echo hi');
});

test('ccpgMdBlocks：纯文本段落与空串安全', () => {
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };
  assert.deepEqual(ccpgMdBlocks(react, ''), []);
  const only = ccpgMdBlocks(react, '就一句话');
  assert.equal(only.length, 1);
  assert.equal(only[0].type, 'p');
  assert.equal(only[0].children[0], '就一句话');
});

test('createChatPane 冒烟：工厂产组件、样式注入、空态与类名前缀、轮询取数', async () => {
  // 浏览器全局桩：ensureStyle 只需 head.appendChild 可调
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    head: { appendChild: () => {} },
  };
  // react 桩：记录元素树；effect 立即执行以便驱动轮询；useState 按调用序各占一个槽
  const effects = [];
  const slots = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: () => ({ current: null }),
    useState: (init) => {
      const i = slots.length;
      slots.push(init);
      return [init, (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useEffect: (fn) => effects.push(fn),
  };
  const seen = [];
  const ChatPane = createChatPane(react, {
    title: 'T', hint: 'H', emptyText: 'E', pollMs: 5, cssPrefix: 'xx',
    apiCall: (method, payload) => {
      seen.push({ method, payload });
      return Promise.resolve({ events: [userMsg('hi')] });
    },
  });
  assert.equal(typeof ChatPane, 'function');

  const cleanup = [];
  const tree = ChatPane({ sessionId: 's1' });
  effects.forEach((fn) => cleanup.push(fn()));
  await new Promise((r) => setTimeout(r, 20)); // 等 promise 链 + 下轮 tick
  cleanup.forEach((fn) => fn && fn());

  assert.ok(seen[0] && seen[0].method === 'session.history' && seen[0].payload.sessionId === 's1');
  assert.equal(seen[0].payload.maxMessages, 60);
  assert.deepEqual(slots[0], [{ kind: 'user', text: 'hi' }]); // 第一个 useState 槽 = items
  assert.equal(tree.type, 'div');
  const [head, list, hintEl] = tree.children;
  assert.equal(head.children[0].children[0], 'T');
  assert.equal(list.props.className, 'xx-list');
  assert.equal(list.children[0].children[0], 'E'); // 首帧空态
  assert.equal(hintEl.children[0], 'H');
});
