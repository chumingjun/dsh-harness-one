import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  LIMITS, buildChildEnv, sanitizePath, createFrameSplitter, parseProcessTable,
  treeFromTable, identityOf, terminateProcessTree, probeRuntime, clearProbeCache,
  runExternalCli, newAcc, pushEntry, resolveBin,
} from '../lib/runtime-cli.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('sanitizePath 去掉空段与 "."，防止子进程从 cwd 解析可执行文件', () => {
  assert.equal(sanitizePath('/usr/bin::./:/bin:.'), '/usr/bin:/bin');
  assert.equal(sanitizePath(''), '');
  assert.equal(sanitizePath('C:\\a;;.;C:\\b', 'win32'), 'C:\\a;C:\\b');
});

test('buildChildEnv 是正向白名单：注入变量与任意命名凭据都不透传', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'zh_CN.UTF-8',
    NODE_OPTIONS: '--require /tmp/evil.js',
    DSH_TOKEN: 'x', MY_CUSTOM_API_CREDENTIAL: 'sk-should-not-leak',
    ANTHROPIC_AUTH_TOKEN: 't', OPENAI_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's',
    RANDOM_SECRET_THING: 'r',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.MY_CUSTOM_API_CREDENTIAL, undefined);
  assert.equal(env.DSH_TOKEN, undefined);
});

test('buildChildEnv 净化 PATH 里的空段', () => {
  const env = buildChildEnv({ PATH: '/usr/bin::.', HOME: '/h' });
  assert.equal(env.PATH, '/usr/bin');
});

test('LF 分帧：U+2028/U+2029 在 JSON 字符串内不得当作行边界', () => {
  const frames = [];
  const sp = createFrameSplitter((t) => frames.push(t));
  const payload = JSON.stringify({ type: 'msg', text: 'a\u2028b\u2029c' });
  sp.push(Buffer.from(`${payload}\n`, 'utf8'));
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0]), { type: 'msg', text: 'a\u2028b\u2029c' });
});

test('LF 分帧：跨 chunk 半行、CRLF、空行', () => {
  const frames = [];
  const sp = createFrameSplitter((t) => frames.push(t));
  sp.push(Buffer.from('{"a":', 'utf8'));
  assert.equal(frames.length, 0);
  sp.push(Buffer.from('1}\r\n\n{"b":2}\n', 'utf8'));
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
});

test('LF 分帧：单帧超限走 overflow，flush 报截断', () => {
  const frames = [];
  const sp = createFrameSplitter((t) => frames.push(t), { maxFrameBytes: 32 });
  sp.push(Buffer.from('x'.repeat(100)));
  assert.equal(sp.overflow, true);
  assert.equal(frames.length, 0);
  assert.equal(sp.flush().truncated, true);
});

test('LF 分帧：残留半行按截断处理，不当完整帧', () => {
  const frames = [];
  const sp = createFrameSplitter((t) => frames.push(t));
  sp.push(Buffer.from('{"a":1}\n{"half":', 'utf8'));
  assert.deepEqual(frames, ['{"a":1}']);
  const flushed = sp.flush();
  assert.equal(flushed.truncated, true);
  assert.match(flushed.rest, /half/);
});

test('进程表解析与自底向上排序（先子后父），带 lstart 身份', () => {
  const table = [
    '  100     1 Wed Nov 19 09:00:00 2026',
    '  200   100 Wed Nov 19 09:00:01 2026',
    '  300   200 Wed Nov 19 09:00:02 2026',
    '  999     1 Wed Nov 19 09:00:03 2026',
  ].join('\n');
  const rows = parseProcessTable(table);
  assert.equal(rows.length, 4);
  const tree = treeFromTable(rows, 100);
  assert.deepEqual(tree.map((r) => r.pid), [300, 200, 100]);
  assert.equal(identityOf(tree[0]), '300:Wed Nov 19 09:00:02 2026');
  // 无关进程不进树
  assert.ok(!tree.some((r) => r.pid === 999));
});

test('resolveBin 只认 PATH 上的可执行文件，找不到返回 null', async () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const found = await resolveBin('node', env);
  assert.ok(found && found.startsWith('/'));
  assert.equal(await resolveBin('definitely-not-a-real-bin-xyz', env), null);
});

test('probeRuntime：真实可用 / 未安装 / 探测失败 三种枚举原因', async () => {
  clearProbeCache();
  const ok = await probeRuntime({ id: 'probe-ok', bin: 'node', probeArgs: ['--version'] });
  assert.equal(ok.available, true);
  assert.match(ok.version, /^v\d+/);
  assert.ok(!('bin' in ok) || typeof ok.bin === 'string'); // bin 只内部用，路由不回显
  clearProbeCache();
  const missing = await probeRuntime({ id: 'probe-missing', bin: 'definitely-not-a-real-bin-xyz' });
  assert.deepEqual(missing, { id: 'probe-missing', available: false, reason: 'not-installed' });
  clearProbeCache();
  const bad = await probeRuntime({ id: 'probe-bad', bin: 'node', probeArgs: ['--definitely-invalid-flag'] });
  assert.equal(bad.available, false);
  assert.equal(bad.reason, 'probe-failed');
  clearProbeCache();
});

test('probeRuntime 缓存命中不重复 spawn', async () => {
  clearProbeCache();
  const a = await probeRuntime({ id: 'probe-cache', bin: 'node', probeArgs: ['--version'] });
  const b = await probeRuntime({ id: 'probe-cache', bin: 'node', probeArgs: ['--version'] });
  assert.equal(a, b);
  clearProbeCache();
});

// 评审 §18.2 竞态：refresh 时旧 in-flight 探测不得被复用、完成后不得回写缓存。
// 用可控延迟的真实 node 进程：旧探测 250ms 后输出 old，新探测立即输出 new。
test('probeRuntime refresh generation：旧探测晚于新探测结束也不覆盖新缓存', async () => {
  clearProbeCache();
  const slow = { id: 'probe-race', bin: 'node', probeArgs: ['-e', 'setTimeout(()=>console.log("old-version"),250)'] };
  const pOld = probeRuntime(slow); // gen0 in-flight
  await sleep(30);
  const pDup = probeRuntime(slow); // 同代去重仍生效（复用同一 in-flight）
  clearProbeCache(); // gen1（refresh=1 语义）
  const fast = { id: 'probe-race', bin: 'node', probeArgs: ['-e', 'console.log("new-version")'] };
  const pNew = probeRuntime(fast); // 不得复用 gen0 的 in-flight
  const [oldR, dupR, newR] = await Promise.all([pOld, pDup, pNew]);
  assert.equal(oldR.version, 'old-version');
  assert.equal(dupR.version, 'old-version');
  assert.equal(newR.version, 'new-version');
  await sleep(300); // 等旧探测的 remember 时机过去
  assert.equal((await probeRuntime(fast)).version, 'new-version'); // 旧代结果未污染缓存
  clearProbeCache();
});

// 真实 POSIX 子孙进程集成测试：根 + 两个孙辈 sleep，取消后必须零残留。
// 注意：这只证明本场景无残留，不能推导 daemonize/改父链的后代也被收回。
test('terminateProcessTree 收干净根与孙辈（真实进程）', async () => {
  const child = spawn('sh', ['-c', 'sleep 31 & sleep 32 & wait'], { stdio: ['ignore', 'ignore', 'ignore'] });
  await sleep(700);
  const before = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout;
  assert.match(before, /sleep 31/);
  assert.match(before, /sleep 32/);
  const result = await terminateProcessTree(child.pid, { graceMs: 2500 });
  await sleep(300);
  const after = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout;
  assert.ok(!/sleep 31/.test(after), 'sleep 31 应已被回收');
  assert.ok(!/sleep 32/.test(after), 'sleep 32 应已被回收');
  assert.equal(result.uncertain, false);
  assert.equal(result.ok, true);
  assert.ok(result.killed.length >= 3);
});

test('terminateProcessTree 对已退出的根是幂等 no-op', async () => {
  const child = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
  await new Promise((r) => child.on('close', r));
  const result = await terminateProcessTree(child.pid, { graceMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.uncertain, false);
});

// 假适配器 + 真实 node 子进程：验证共享层的分帧、终态、取消、超时与清理
const fakeAdapter = {
  id: 'fake',
  bin: 'node',
  probeArgs: ['--version'],
  onFrame(ev, acc) {
    if (ev.type === 'msg') { acc.preview = ev.text; acc.finalText = ev.text; pushEntry(acc, { kind: 'assistant', text: ev.text }); }
    if (ev.type === 'turn') acc.turns += 1;
    if (ev.type === 'done') { acc.sawTerminal = true; acc.usage = { inputTokens: 1, outputTokens: 2 }; }
    if (ev.type === 'boom') acc.fatal = 'protocol boom';
  },
  finalize(acc, exit) {
    const fail = (code) => ({ text: '', usage: acc.usage, turns: acc.turns, error: Object.assign(new Error(code), { code }) });
    if (exit.code !== 0) return fail('RUNTIME_EXIT_NONZERO');
    if (acc.fatal) return fail('RUNTIME_PROTOCOL_ERROR');
    if (!acc.sawTerminal) return fail('RUNTIME_NO_TERMINAL');
    if (!acc.finalText) return fail('RUNTIME_EMPTY_RESULT');
    return { text: acc.finalText, usage: acc.usage, turns: acc.turns, error: null };
  },
};

const nodeBin = process.execPath;
const emitScript = (lines, tail = '') => ['-e', `${lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('')}${tail}`];

test('runExternalCli 正常路径：分帧→轨迹→终态→用量', async () => {
  const out = await runExternalCli({
    adapter: fakeAdapter, bin: nodeBin,
    argv: emitScript([{ type: 'turn' }, { type: 'msg', text: '你好' }, { type: 'done' }]),
    stdin: 'task', cwd: process.cwd(), timeoutMs: 15000,
  });
  assert.equal(out.error, null);
  assert.equal(out.text, '你好');
  assert.equal(out.turns, 1);
  assert.deepEqual(out.usage, { inputTokens: 1, outputTokens: 2 });
  assert.equal(out.entries.length, 1);
  assert.equal(out.exitCode, 0);
  assert.equal(out.cleanup.ok, true);
});

test('runExternalCli 缺终态帧即失败（exit=0 也不判绿）', async () => {
  const out = await runExternalCli({
    adapter: fakeAdapter, bin: nodeBin,
    argv: emitScript([{ type: 'msg', text: '看起来完成了' }]),
    stdin: 't', cwd: process.cwd(), timeoutMs: 15000,
  });
  assert.equal(out.error.code, 'RUNTIME_NO_TERMINAL');
  assert.equal(out.text, '');
});

test('runExternalCli 畸形帧不参与终态，未知帧不炸', async () => {
  const out = await runExternalCli({
    adapter: fakeAdapter, bin: nodeBin,
    argv: ['-e', 'console.log("not json");console.log(JSON.stringify({type:"msg",text:"ok"}));console.log(JSON.stringify({type:"done"}));'],
    stdin: 't', cwd: process.cwd(), timeoutMs: 15000,
  });
  assert.equal(out.error, null);
  assert.equal(out.text, 'ok');
});

test('runExternalCli 用户取消：分类为 canceled，进程树收干净', async () => {
  const ac = new AbortController();
  const task = runExternalCli({
    adapter: fakeAdapter, bin: nodeBin,
    argv: ['-e', 'console.log(JSON.stringify({type:"msg",text:"partial"}));setTimeout(()=>{},60000);'],
    stdin: 't', cwd: process.cwd(), signal: ac.signal, timeoutMs: 30000,
  });
  await sleep(600);
  ac.abort();
  const out = await task;
  assert.equal(out.error.code, 'RUNTIME_CANCELED');
  assert.equal(out.canceled, true);
  assert.equal(out.cleanup.ok, true);
});

test('runExternalCli 总超时：分类为 timeout 而非取消', async () => {
  const out = await runExternalCli({
    adapter: fakeAdapter, bin: nodeBin,
    argv: ['-e', 'setTimeout(()=>{},60000);'],
    stdin: 't', cwd: process.cwd(), timeoutMs: 500,
  });
  assert.equal(out.error.code, 'RUNTIME_TIMEOUT');
  assert.equal(out.timedOut, true);
  assert.equal(out.canceled, false);
  assert.equal(out.cleanup.ok, true);
});

test('runExternalCli 已 abort 的 signal 直接拒绝，不 spawn', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    runExternalCli({ adapter: fakeAdapter, bin: nodeBin, argv: ['-e', ''], stdin: '', cwd: process.cwd(), signal: ac.signal }),
    (e) => e.code === 'RUNTIME_CANCELED',
  );
});

test('runExternalCli 非零退出带上 stderr 尾部', async () => {
  const out = await runExternalCli({
    adapter: fakeAdapter, bin: nodeBin,
    argv: ['-e', 'console.error("diagnostic tail");process.exit(3);'],
    stdin: 't', cwd: process.cwd(), timeoutMs: 15000,
  });
  assert.equal(out.error.code, 'RUNTIME_EXIT_NONZERO');
  assert.equal(out.exitCode, 3);
  assert.match(out.stderrTail, /diagnostic tail/);
});

test('轨迹条数超限只标记截断，不无限增长', () => {
  const acc = newAcc();
  for (let i = 0; i < LIMITS.maxEntries + 50; i += 1) pushEntry(acc, { kind: 'assistant', text: `t${i}` });
  assert.equal(acc.entries.length, LIMITS.maxEntries);
  assert.equal(acc.entriesTruncated, true);
});

test('redactSecrets 抹掉常见凭据形状，保留可诊断文本', async () => {
  const { redactSecrets } = await import('../lib/runtime-cli.js');
  const src = 'Authorization: Bearer abcdef1234567890abcdef\napi_key=sk-abcdefghijklmnop1234\nexport OPENAI_API_KEY=sk-xyz123456789abc\nmodel gpt-x not found';
  const out = redactSecrets(src);
  assert.ok(!out.includes('abcdef1234567890abcdef'));
  assert.ok(!out.includes('sk-abcdefghijklmnop1234'));
  assert.ok(!out.includes('sk-xyz123456789abc'));
  assert.match(out, /model gpt-x not found/);
  assert.match(out, /\[REDACTED\]/);
});

// 回归：codex 启动期失败把原因写在 stdout 纯文本，stderr 只有 "Reading prompt from stdin..."。
// 旧实现静默丢弃非 JSONL 行 → 用户只看到 RUNTIME_EXIT_NONZERO，无法诊断。
test('runExternalCli 保留非 JSONL stdout 作诊断，并带进失败文案', async () => {
  const diagAdapter = {
    id: 'diag', bin: 'node', probeArgs: ['--version'],
    onFrame() {},
    finalize(acc, exit, { stderrTail, stdoutPlainTail }) {
      if (exit.code !== 0) {
        const error = new Error(`exit ${exit.code}: ${[stdoutPlainTail, stderrTail].filter(Boolean).join(' | ')}`);
        error.code = 'RUNTIME_EXIT_NONZERO';
        return { text: '', error };
      }
      return { text: 'ok', error: null };
    },
  };
  const out = await runExternalCli({
    adapter: diagAdapter, bin: nodeBin,
    argv: ['-e', 'console.log("Reading prompt from stdin...");console.log("ERROR: model definitely-not-a-real-model-xyz is not available");console.error("Reading prompt from stdin...");process.exit(1);'],
    stdin: 't', cwd: process.cwd(), timeoutMs: 15000,
  });
  assert.equal(out.error.code, 'RUNTIME_EXIT_NONZERO');
  assert.match(out.stdoutPlainTail, /not available/);
  assert.match(out.error.message, /not available/);
});
