import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexRuntime } from '../lib/runtime-codex.js';
import { newAcc } from '../lib/runtime-cli.js';

// fixture 取自本机真实录制（codex-cli 0.170.0）的事件形状，已脱敏：
// 去掉个人路径、用户名、token、shell 环境值与无关大段文本，只保留协议字段。
const CONFIG_WARNING = {
  type: 'item.completed',
  item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n  user config: `mcp_servers.example.type` is ignored.' },
};
const msg = (id, text) => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const cmdStart = (id, command) => ({ type: 'item.started', item: { id, type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' } });
const cmdDone = (id, command, out, code) => ({ type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: out, exit_code: code, status: code === 0 ? 'completed' : 'failed' } });
const TURN_DONE = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 3 } };

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1-adapter-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function feed(events) {
  const acc = newAcc();
  for (const ev of events) codexRuntime.onFrame(ev, acc);
  return acc;
}

test('codex argv：-a never 在 exec 之前，沙箱 workspace-write，终值文件与 schema 走独立临时目录', () => {
  const files = { resultFile: '/tmp/scratch/final.txt', schemaFile: '/tmp/scratch/schema.json' };
  const { argv, stdin } = codexRuntime.buildSpawn({ persona: 'PERSONA', userPrompt: 'TASK', cwd: '/ws', model: 'gpt-x', files });
  assert.deepEqual(argv.slice(0, 2), ['-a', 'never']);
  assert.equal(argv[2], 'exec');
  assert.ok(argv.includes('--json'));
  assert.ok(argv.includes('--skip-git-repo-check'));
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write');
  assert.equal(argv[argv.indexOf('-C') + 1], '/ws');
  assert.equal(argv[argv.indexOf('--output-last-message') + 1], files.resultFile);
  assert.equal(argv[argv.indexOf('--output-schema') + 1], files.schemaFile);
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-x');
  // persona 与业务输入走 stdin，不出现在 argv（进程列表可见）
  assert.equal(stdin, 'PERSONA\n\nTASK');
  assert.ok(!argv.some((a) => String(a).includes('TASK')));
});

test('codex 无 schema/model 时不传对应 flag', () => {
  const { argv } = codexRuntime.buildSpawn({ persona: 'p', userPrompt: 't', cwd: '/ws', model: '', files: { resultFile: '/tmp/f.txt', schemaFile: null } });
  assert.ok(!argv.includes('--output-schema'));
  assert.ok(!argv.includes('-m'));
});

test('codex 多条 agent_message：预览与候选终值取最后一条，不拼接', () => {
  const acc = feed([msg('i1', '我先确认文件内容。'), msg('i2', '已改为 goodbye。')]);
  assert.equal(acc.finalText, '已改为 goodbye。');
  assert.equal(acc.preview, '已改为 goodbye。');
  assert.equal(acc.entries.filter((e) => e.kind === 'assistant').length, 2);
});

test('codex 配置警告 error item 只作诊断，不判致命', () => {
  const acc = feed([CONFIG_WARNING, CONFIG_WARNING, msg('i1', 'OK'), TURN_DONE]);
  assert.equal(acc.fatal, null);
  assert.equal(acc.sawTerminal, true);
  assert.equal(acc.entries.filter((e) => e.kind === 'inject').length, 2);
});

// 回归：真跑时 codex 因更新插件市场失败（github SSL 噪声）发 error item，
// 任务其实已完成（report.md 已产出）。旧实现把它当致命错误 → 误判失败。
const MARKETPLACE_ERROR = {
  type: 'item.completed',
  item: { id: 'e1', type: 'error', message: "Codex could not update marketplace `ponytail`: git ls-remote marketplace source failed with status exit status: 128: fatal: unable to access 'https://example.invalid/repo.git/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL" },
};

test('codex 环境噪声 error item（插件市场/网络）只作诊断，不判致命', () => {
  const acc = feed([MARKETPLACE_ERROR, msg('i1', '已写入 report.md'), TURN_DONE]);
  assert.equal(acc.fatal, null);
  assert.equal(acc.sawTerminal, true);
  assert.equal(acc.diagnostics.length, 1);
  assert.match(acc.diagnostics[0], /marketplace/);
  assert.equal(acc.entries.filter((e) => e.kind === 'inject').length, 1);
});

test('codex 噪声 error item + 完整终态 + 终值文件 = 成功', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'final.txt'), schemaFile: null };
  writeFileSync(files.resultFile, '- [report.md](report.md) 已写入');
  const acc = feed([CONFIG_WARNING, MARKETPLACE_ERROR, msg('i1', '已写入 report.md'), TURN_DONE]);
  const out = codexRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', files });
  assert.equal(out.error, null);
  assert.match(out.text, /report\.md/);
}));

test('codex 真致命错误仍 fail-closed：噪声伴随缺终态即失败', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'final.txt'), schemaFile: null };
  writeFileSync(files.resultFile, '部分文本');
  const acc = feed([MARKETPLACE_ERROR, msg('i1', '部分文本')]); // 无 turn.completed
  const out = codexRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', files });
  assert.equal(out.error.code, 'RUNTIME_NO_TERMINAL');
}));

test('codex 诊断条数有上限，不无限增长', () => {
  const events = [];
  for (let i = 0; i < 60; i += 1) events.push({ type: 'item.completed', item: { id: `e${i}`, type: 'error', message: `noise ${i}` } });
  const acc = feed(events);
  assert.equal(acc.diagnostics.length, 20);
  assert.equal(acc.fatal, null);
});

test('codex command_execution 跨 started/completed 配对回填结果', () => {
  const acc = feed([cmdStart('c1', 'sed -n 1,40p hello.txt'), cmdDone('c1', 'sed -n 1,40p hello.txt', 'hello\n', 0)]);
  const tools = acc.entries.filter((e) => e.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'bash');
  assert.deepEqual(tools[0].result, { ok: true, text: 'hello\n' });
});

test('codex 工具非零退出记为 result.ok=false，但不单独判节点失败', () => {
  const acc = feed([cmdStart('c1', 'git status'), cmdDone('c1', 'git status', 'fatal: not a git repository', 128), msg('i1', 'done'), TURN_DONE]);
  const tool = acc.entries.find((e) => e.kind === 'tool');
  assert.equal(tool.result.ok, false);
  assert.equal(acc.fatal, null);
});

test('codex file_change 投影为 edit 工具项', () => {
  const acc = feed([{ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'hello.txt', kind: 'update' }], status: 'completed' } }]);
  const tool = acc.entries.find((e) => e.kind === 'tool' && e.name === 'edit');
  assert.ok(tool);
  assert.match(tool.args, /hello\.txt/);
  assert.equal(tool.result.ok, true);
});

test('codex usage 按 turn 累加，turns 计 turn.started', () => {
  const acc = feed([
    { type: 'turn.started' }, TURN_DONE,
    { type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } },
  ]);
  assert.equal(acc.turns, 2);
  assert.deepEqual(acc.usage, { inputTokens: 150, outputTokens: 12 });
});

test('codex 未知事件只记录类型，不抛错、不判致命', () => {
  const acc = feed([{ type: 'brand_new_event', foo: 1 }, { type: 'item.completed', item: { id: 'z', type: 'reasoning_v2' } }, msg('i1', 'OK'), TURN_DONE]);
  assert.ok(acc.unknownEvents.has('brand_new_event'));
  assert.ok(acc.unknownEvents.has('item:reasoning_v2'));
  assert.equal(acc.fatal, null);
});

test('codex 终值以 --output-last-message 文件为事实源，而非最后一条 agent_message', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'final.txt'), schemaFile: null };
  // 前导语在事件里是最后一条，但原生终值文件才是答案
  const acc = feed([msg('i1', '我先看看。'), TURN_DONE]);
  writeFileSync(files.resultFile, '真正的最终答案');
  const out = codexRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', files });
  assert.equal(out.error, null);
  assert.equal(out.text, '真正的最终答案');
}));

test('codex 终值文件缺失或为空即失败，不回退到预览文本', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'missing.txt'), schemaFile: null };
  const acc = feed([msg('i1', '看起来完成了'), TURN_DONE]);
  const out = codexRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', files });
  assert.equal(out.error.code, 'RUNTIME_EMPTY_RESULT');
  assert.equal(out.text, '');

  writeFileSync(files.resultFile, '   \n');
  const blank = codexRuntime.finalize(feed([msg('i1', 'x'), TURN_DONE]), { code: 0, signal: null }, { stderrTail: '', files });
  assert.equal(blank.error.code, 'RUNTIME_EMPTY_RESULT');
}));

test('codex 缺 turn.completed 即失败（exit=0 也不算成功）', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'final.txt'), schemaFile: null };
  writeFileSync(files.resultFile, '有答案但没有终态帧');
  const acc = feed([msg('i1', '有答案但没有终态帧')]);
  const out = codexRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', files });
  assert.equal(out.error.code, 'RUNTIME_NO_TERMINAL');
  assert.equal(out.error.retryable, false);
}));

test('codex 非零退出 / turn.failed / spawn 失败都判失败', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'final.txt'), schemaFile: null };
  writeFileSync(files.resultFile, '答案');
  const ok = feed([msg('i1', '答案'), TURN_DONE]);
  assert.equal(codexRuntime.finalize(ok, { code: 1, signal: null }, { stderrTail: 'boom', files }).error.code, 'RUNTIME_EXIT_NONZERO');
  assert.equal(codexRuntime.finalize(ok, { code: null, signal: 'SIGKILL' }, { stderrTail: '', files }).error.code, 'RUNTIME_EXIT_NONZERO');
  assert.equal(codexRuntime.finalize(ok, { code: null, signal: null, spawnError: 'ENOENT' }, { stderrTail: '', files }).error.code, 'RUNTIME_SPAWN_FAILED');
  const failed = feed([{ type: 'turn.failed', message: 'context window exceeded' }]);
  assert.equal(codexRuntime.finalize(failed, { code: 0, signal: null }, { stderrTail: '', files }).error.code, 'RUNTIME_PROTOCOL_ERROR');
}));

// 回归（真跑取证）：codex 的真失败原因是顶层 {type:"error"} 事件（503 / Reconnecting n/5），
// 不是 item.completed。旧实现当未知事件丢掉 → 失败文案只剩退出码，用户无法诊断。
const RECONNECT_503 = { type: 'error', message: 'Reconnecting... 5/5 (unexpected status 503 Service Unavailable: No available channel for model gpt-x under group itbp (distributor))' };

test('codex 顶层 error 事件进诊断与轨迹，并带进失败文案', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'missing.txt'), schemaFile: null };
  const acc = feed([{ type: 'turn.started' }, RECONNECT_503]);
  assert.equal(acc.unknownEvents.has('error'), false);
  assert.match(acc.lastProtocolError, /503/);
  assert.ok(acc.entries.some((e) => e.kind === 'inject' && /503/.test(e.text)));
  const out = codexRuntime.finalize(acc, { code: 1, signal: null }, { stderrTail: 'Reading prompt from stdin...', files });
  assert.equal(out.error.code, 'RUNTIME_EXIT_NONZERO');
  assert.match(out.error.message, /503/);
  assert.match(out.error.message, /No available channel/);
}));

test('codex 顶层 error 后若重连恢复并完整终态，仍判成功', () => withScratch((dir) => {
  const files = { resultFile: join(dir, 'final.txt'), schemaFile: null };
  writeFileSync(files.resultFile, '恢复后的答案');
  const acc = feed([{ type: 'turn.started' }, RECONNECT_503, msg('i1', '恢复后的答案'), TURN_DONE]);
  const out = codexRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', files });
  assert.equal(out.error, null);
  assert.equal(out.text, '恢复后的答案');
}));

// ---- claude code 适配器（fixture 取自本机 claude 2.1.327 真实录制，已脱敏）----
import { claudeRuntime } from '../lib/runtime-claude.js';

const cToolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const cToolResult = (id, content, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const cText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const cResult = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: '最终答案', num_turns: 3, permission_denials: [], usage: { input_tokens: 13, output_tokens: 449 }, total_cost_usd: 0.13, ...over });
const cFeed = (events) => { const acc = newAcc(); for (const e of events) claudeRuntime.onFrame(e, acc); return acc; };

test('claude argv：stream-json + acceptEdits + 不持久会话；schema 走 argv，prompt 走 stdin', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const { argv, stdin } = claudeRuntime.buildSpawn({ persona: 'P', userPrompt: 'T', cwd: '/ws', model: 'claude-x', files: { schema } });
  assert.equal(argv[0], '-p');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(argv.includes('--no-session-persistence'));
  assert.ok(argv.includes('--include-partial-messages'));
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-x');
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--json-schema') + 1]), schema);
  assert.equal(stdin, 'P\n\nT');
  assert.ok(!argv.some((a) => String(a).includes('T')));
  // 不默认放行 Bash
  assert.ok(!argv.includes('--allowedTools'));
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
});

test('claude tool_use/tool_result 按 id 配对（string 与 array 两种 content）', () => {
  const acc = cFeed([
    cToolUse('t1', 'Read', { file_path: '/ws/hello.txt' }),
    cToolResult('t1', 'hello\n'),
    cToolUse('t2', 'Bash', { command: 'echo hi' }),
    cToolResult('t2', [{ type: 'text', text: 'hi\n' }], true),
  ]);
  const tools = acc.entries.filter((e) => e.kind === 'tool');
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0].result, { ok: true, text: 'hello\n' });
  assert.deepEqual(tools[1].result, { ok: false, text: 'hi\n' });
});

test('claude 增量只进预览：text_delta 累积、thinking_delta 忽略、不产生轨迹条', () => {
  const acc = cFeed([
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret thought' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } } },
  ]);
  assert.equal(acc.preview, '你好');
  assert.equal(acc.entries.length, 0);
});

test('claude system 事件不进轨迹；未知事件只记录', () => {
  const acc = cFeed([
    { type: 'system', subtype: 'init', permissionMode: 'acceptEdits', model: 'm' },
    { type: 'system', subtype: 'hook_started' },
    { type: 'system', subtype: 'thinking_tokens' },
    { type: 'brand_new' },
  ]);
  assert.equal(acc.entries.length, 0);
  assert.ok(acc.unknownEvents.has('brand_new'));
});

test('claude 成功终态：text/turns/usage/cost', () => {
  const acc = cFeed([cText('中间'), cResult()]);
  const out = claudeRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', stdoutPlainTail: '' });
  assert.equal(out.error, null);
  assert.equal(out.text, '最终答案');
  assert.equal(out.turns, 3);
  assert.deepEqual(out.usage, { inputTokens: 13, outputTokens: 449, costUsd: 0.13 });
});

test('claude 权限拒绝判失败，不读模型自述判成功', () => {
  const acc = cFeed([cText('我被拒了但我可以说完成了'), cResult({ permission_denials: [{ tool: 'Bash', reason: 'denied' }] })]);
  const out = claudeRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', stdoutPlainTail: '' });
  assert.equal(out.error.code, 'RUNTIME_PERMISSION_DENIED');
  assert.equal(out.error.retryable, false);
});

test('claude 错误 subtype / is_error / 缺终态 / 空结果 / 非零退出 都判失败', () => {
  const ctx = { stderrTail: '', stdoutPlainTail: '' };
  assert.equal(claudeRuntime.finalize(cFeed([cResult({ subtype: 'error_during_execution' })]), { code: 0 }, ctx).error.code, 'RUNTIME_RESULT_ERROR');
  assert.equal(claudeRuntime.finalize(cFeed([cResult({ is_error: true })]), { code: 0 }, ctx).error.code, 'RUNTIME_RESULT_ERROR');
  assert.equal(claudeRuntime.finalize(cFeed([cText('无终态')]), { code: 0 }, ctx).error.code, 'RUNTIME_NO_TERMINAL');
  assert.equal(claudeRuntime.finalize(cFeed([cResult({ result: '  ' })]), { code: 0 }, ctx).error.code, 'RUNTIME_EMPTY_RESULT');
  assert.equal(claudeRuntime.finalize(cFeed([cResult()]), { code: 1, signal: null }, ctx).error.code, 'RUNTIME_EXIT_NONZERO');
});

// ---- pi 适配器（fixture 取自本机 pi 1.5.0 真实录制，已脱敏）----
import { piRuntime } from '../lib/runtime-pi.js';

const pToolCall = (id, name, args) => ({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }] } });
const pToolResult = (id, text, isError = false) => ({ type: 'message_end', message: { role: 'toolResult', toolCallId: id, toolName: 'write', content: [{ type: 'text', text }], isError } });
const pAssistant = (text, over = {}) => ({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: 15375, output: 19, cost: { total: 0.01 } }, ...over } });
const pEnd = () => [{ type: 'agent_end', willRetry: false }, { type: 'agent_settled', aborted: false }];
const pFeed = (events) => { const acc = newAcc(); for (const e of events) piRuntime.onFrame(e, acc); return acc; };

test('pi argv：--mode json -p --no-session + provider/model 拆分；prompt 走 stdin', () => {
  const { argv, stdin } = piRuntime.buildSpawn({ persona: 'P', userPrompt: 'T', cwd: '/ws', model: 'airouter/glm-5.3-flash' });
  assert.deepEqual(argv, ['--mode', 'json', '-p', '--no-session', '--no-mcp', '--no-extensions', '--provider', 'airouter', '--model', 'glm-5.3-flash']);
  assert.equal(stdin, 'P\n\nT');
});

// 回归（真跑根因）：环境 MCP/扩展会在启动时联网初始化或注入生命周期干扰 → 空转/挂起。
// 无人值守委派必须隔离环境 MCP 与扩展。
test('claude 隔离环境 MCP（strict-mcp-config + 空 mcpServers）', () => {
  const { argv } = claudeRuntime.buildSpawn({ persona: 'P', userPrompt: 'T', cwd: '/ws', model: '', files: { schema: null } });
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]), { mcpServers: {} });
});

test('pi 隔离环境 MCP 与扩展', () => {
  const { argv } = piRuntime.buildSpawn({ persona: 'P', userPrompt: 'T', cwd: '/ws', model: 'airouter/glm-5.3-flash' });
  assert.ok(argv.includes('--no-mcp'));
  assert.ok(argv.includes('--no-extensions'));
});

test('pi 拒绝非法模型形状（缺 slash / 空段 / 注入 flag）', () => {
  for (const bad of ['', 'noslash', '/model', 'provider/', 'provider/-rf', 'pro vider/model']) {
    assert.throws(() => piRuntime.buildSpawn({ persona: 'p', userPrompt: 't', cwd: '/ws', model: bad }), (e) => e.code === 'RUNTIME_BAD_MODEL');
  }
});

test('pi toolCall/toolResult 按 id 配对', () => {
  const acc = pFeed([pToolCall('c1', 'write', { path: '/ws/hello.txt' }), pToolResult('c1', 'Successfully wrote')]);
  const tool = acc.entries.find((e) => e.kind === 'tool');
  assert.equal(tool.name, 'write');
  assert.deepEqual(tool.result, { ok: true, text: 'Successfully wrote' });
});

test('pi system 消息（约51KB）跳过；增量只进预览', () => {
  const acc = pFeed([
    { type: 'message_end', message: { role: 'system', content: '', sections: { preamble: 'x'.repeat(51000) } } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好' } },
  ]);
  assert.equal(acc.entries.length, 0);
  assert.equal(acc.preview, '你好');
});

test('pi 成功终态：agent_end + agent_settled + 正常 stopReason', () => {
  const acc = pFeed([{ type: 'turn_start' }, pAssistant('最终答案'), ...pEnd()]);
  const out = piRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', stdoutPlainTail: '' });
  assert.equal(out.error, null);
  assert.equal(out.text, '最终答案');
  assert.equal(out.turns, 1);
  assert.equal(out.usage.inputTokens, 15375);
  assert.equal(out.usage.outputTokens, 19);
});

// 关键回归：pi exit=0 但 401/503 → 必须判失败（实测默认模型坏就是这个形状）
test('pi exit=0 但 stopReason=error / errorMessage 非空 → 判失败', () => {
  const acc = pFeed([pAssistant('', { stopReason: 'error', errorMessage: '401 {"type":"authentication_error"}' }), ...pEnd()]);
  const out = piRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', stdoutPlainTail: '' });
  assert.equal(out.error.code, 'RUNTIME_RESULT_ERROR');
  assert.match(out.error.message, /401/);
});

test('pi 缺终态帧 / aborted / 空答案 / 非零退出 都判失败', () => {
  const ctx = { stderrTail: '', stdoutPlainTail: '' };
  assert.equal(piRuntime.finalize(pFeed([pAssistant('x')]), { code: 0 }, ctx).error.code, 'RUNTIME_NO_TERMINAL');
  assert.equal(piRuntime.finalize(pFeed([pAssistant('x'), { type: 'agent_end', willRetry: false }, { type: 'agent_settled', aborted: true }]), { code: 0 }, ctx).error.code, 'RUNTIME_ABORTED');
  assert.equal(piRuntime.finalize(pFeed([pAssistant('  '), ...pEnd()]), { code: 0 }, ctx).error.code, 'RUNTIME_EMPTY_RESULT');
  assert.equal(piRuntime.finalize(pFeed([pAssistant('x'), ...pEnd()]), { code: 1 }, ctx).error.code, 'RUNTIME_EXIT_NONZERO');
});

test('pi auto_retry 只作诊断不判致命，也不刷新进展', () => {
  const acc = pFeed([
    { type: 'auto_retry_start' }, { type: 'auto_retry_end' },
    pAssistant('恢复后答案'), ...pEnd(),
  ]);
  assert.equal(acc.diagnostics.length, 2);
  const out = piRuntime.finalize(acc, { code: 0, signal: null }, { stderrTail: '', stdoutPlainTail: '' });
  assert.equal(out.error, null);
  assert.equal(out.text, '恢复后答案');
});

test('claude 默认 restricted 不放行 Bash；bash 模式才加 --allowedTools 且放最后', () => {
  const base = { persona: 'P', userPrompt: 'T', cwd: '/ws', model: '', files: { schema: null } };
  const off = claudeRuntime.buildSpawn(base);
  assert.ok(!off.argv.includes('--allowedTools'));
  assert.equal(off.argv[off.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  const on = claudeRuntime.buildSpawn({ ...base, permission: 'bash' });
  assert.equal(on.argv[on.argv.length - 2], '--allowedTools');
  assert.equal(on.argv[on.argv.length - 1], 'Bash');
  assert.equal(on.argv[on.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(on.stdin, 'P\n\nT'); // prompt 仍走 stdin，不被可变参数吞
});

// 权限模式（设计 §17/§18）：full 只替换 mode 值，不重复传 --permission-mode
test('claude full = bypassPermissions，单一 mode flag，schema 位置不变', () => {
  const base = { persona: 'P', userPrompt: 'T', cwd: '/ws', model: '', files: { schema: { type: 'object' } } };
  const { argv } = claudeRuntime.buildSpawn({ ...base, permission: 'full' });
  assert.equal(argv.filter((a) => a === '--permission-mode').length, 1);
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(!argv.includes('--allowedTools'));
  assert.ok(argv.indexOf('--json-schema') < argv.length - 1);
});

test('codex full = danger-full-access；默认 sandbox 逐字不变', () => {
  const base = { persona: 'P', userPrompt: 'T', cwd: '/ws', model: '', files: { resultFile: '/tmp/r', schemaFile: null } };
  const def = codexRuntime.buildSpawn(base);
  assert.equal(def.argv[def.argv.indexOf('-s') + 1], 'workspace-write');
  const full = codexRuntime.buildSpawn({ ...base, permission: 'full' });
  assert.equal(full.argv[full.argv.indexOf('-s') + 1], 'danger-full-access');
  assert.equal(full.argv[full.argv.indexOf('-a') + 1], 'never');
});

test('适配器防御性复核：非法权限值 fail-closed（RUNTIME_BAD_PERMISSION）', () => {
  const cbase = { persona: 'P', userPrompt: 'T', cwd: '/ws', model: '', files: { schema: null } };
  assert.throws(() => claudeRuntime.buildSpawn({ ...cbase, permission: 'bogus' }), (e) => e.code === 'RUNTIME_BAD_PERMISSION');
  const xbase = { persona: 'P', userPrompt: 'T', cwd: '/ws', model: '', files: { resultFile: '/tmp/r', schemaFile: null } };
  assert.throws(() => codexRuntime.buildSpawn({ ...xbase, permission: 'bash' }), (e) => e.code === 'RUNTIME_BAD_PERMISSION');
});

// 回归（真跑取证）：用户 SessionStart hook 在无 tty 时阻塞 claude（dsh 生产无终端运行）。
// 无人值守委派必须 disableAllHooks，否则发完 hook_started 就停到节点超时。
test('claude 无人值守默认关闭用户 hooks（解无 tty 阻塞）', () => {
  const { argv } = claudeRuntime.buildSpawn({ persona: 'P', userPrompt: 'T', cwd: '/ws', model: '', files: { schema: null } });
  const i = argv.indexOf('--settings');
  assert.ok(i >= 0);
  assert.deepEqual(JSON.parse(argv[i + 1]), { disableAllHooks: true });
});
