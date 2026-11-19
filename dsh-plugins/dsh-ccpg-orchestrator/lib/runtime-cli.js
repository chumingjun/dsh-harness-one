// 外部 runtime（codex / claude / pi）共享执行层。
// 职责边界：spawn、LF 字节分帧、有界输出、进程树清理、总超时、取消、探测。
// 协议语义（事件→轨迹/终值/用量）一律在各 runtime-<id>.js 适配器里，本文件不认识任何 CLI 协议。
//
// 为什么不用 ctx.subprocess：实测（dsh 0.2.2-rc.5 / macOS）它的 terminate() 会漏掉 codex
// 自建的进程组子孙，而 waitForExit() 仍 resolved（假称已静默）；且它不暴露 pid，无法自己收树。
// 为什么不用进程组 kill：实测 detached + process.kill(-pid) 同样漏孤儿。
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as FS_CONSTANTS, realpathSync } from 'node:fs';
import { join, isAbsolute, sep, win32, posix } from 'node:path';

export const LIMITS = Object.freeze({
  maxFrameBytes: 1024 * 1024,      // 单帧上限（pi 的 system 消息实测约 51KB）
  maxStderrBytes: 64 * 1024,       // stderr 只留尾部
  maxEntries: 400,                 // 轨迹条数上限
  maxAssistantChars: 6000,         // 与 foldTraceEvent 同口径
  maxToolChars: 4000,
  maxPreviewChars: 4096,
  probeTimeoutMs: 4000,
  probeTtlMs: 60_000,
  killGraceMs: 3000,
  killScanIntervalMs: 200,
});

// 正向白名单：从空 env 构造，只传宿主可信变量。
// 不用 denylist——实测 dsh 的 scrubbedParentEnv 也是 /KEY|PASSWORD|SECRET|TOKEN/i 名字过滤，
// 漏掉任意命名的凭据与 NODE_OPTIONS（claude/pi 都是 node CLI，可被注入）。
const ENV_ALLOW = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
]);

/** 诊断文本脱敏：stderr/stdout 尾部可能带凭据，进错误文案与运行记录前先抹掉。 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|apikey|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}{)]{6,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/(export\s+[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)[^\s]+/gi, '$1[REDACTED]');
}

/** PATH 列表分隔符（注意不是 path.sep —— 那是路径段分隔符 '/'）。 */
export function pathListSep(platform = process.platform) { return platform === 'win32' ? ';' : ':'; }

/** 只保留绝对路径段：空段、'.'、'./' 与任何相对段都会让子进程从 cwd 解析可执行文件。 */
export function sanitizePath(value, platform = process.platform) {
  const listSep = pathListSep(platform);
  const pathApi = platform === 'win32' ? win32 : posix;
  return String(value || '').split(listSep).filter((p) => p && pathApi.isAbsolute(p)).join(listSep);
}

export function buildChildEnv(base = process.env, platform = process.platform) {
  const env = {};
  for (const key of ENV_ALLOW) {
    if (base[key] === undefined) continue;
    env[key] = key === 'PATH' ? sanitizePath(base[key], platform) : base[key];
  }
  return env;
}

/** 在净化后的 PATH 上解析绝对可执行文件；找不到返回 null。 */
export async function resolveBin(bin, env = buildChildEnv()) {
  if (isAbsolute(bin)) {
    try { await access(bin, FS_CONSTANTS.X_OK); return bin; } catch { return null; }
  }
  for (const dir of String(env.PATH || '').split(pathListSep()).filter(Boolean)) {
    const full = join(dir, bin);
    try { await access(full, FS_CONSTANTS.X_OK); return full; } catch { /* 继续找 */ }
  }
  return null;
}

/**
 * LF 字节分帧器。
 * 不能用 readline：pi 官方文档明确它把 U+2028/U+2029 也当行边界，会劈开 JSON 字符串。
 * 这里只认 0x0A，多字节字符内部不可能出现该字节。
 */
export function createFrameSplitter(onFrame, { maxFrameBytes = LIMITS.maxFrameBytes } = {}) {
  let buf = Buffer.alloc(0);
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let idx;
      while ((idx = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        const text = line.toString('utf8').replace(/\r$/, '');
        if (text.trim()) onFrame(text);
      }
      if (buf.length > maxFrameBytes) { overflow = true; buf = Buffer.alloc(0); }
    },
    /** 收尾：残留半行按截断处理，不参与终态。 */
    flush() {
      const rest = buf.length ? buf.toString('utf8').trim() : '';
      buf = Buffer.alloc(0);
      return { truncated: overflow || Boolean(rest), rest: rest.slice(0, 200) };
    },
    get overflow() { return overflow; },
  };
}

/**
 * ps 快照收集 root 及其后代，自底向上（先子后父，避免先杀父丢失父子关系）。
 * 带 lstart 作进程身份，防 PID 复用后误杀无关进程。
 * 注意：快照不是原子操作，快照后新 fork 或 daemonize 改父链的进程可能逃逸——
 * 所以本模块只承诺「已跟踪后代」，清理不确定时显式上报，不声称绝对零孤儿。
 */
export function parseProcessTable(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    const hit = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!hit) continue;
    rows.push({ pid: Number(hit[1]), ppid: Number(hit[2]), start: hit[3] });
  }
  return rows;
}

export function treeFromTable(rows, rootPid) {
  const kids = new Map();
  const byPid = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (!kids.has(row.ppid)) kids.set(row.ppid, []);
    kids.get(row.ppid).push(row.pid);
  }
  const acc = [];
  const walk = (pid) => {
    for (const kid of kids.get(pid) || []) walk(kid);
    const row = byPid.get(pid);
    if (row) acc.push(row);
  };
  walk(rootPid);
  return acc; // 自底向上，末尾是 root
}

export function identityOf(row) { return `${row.pid}:${row.start}`; }

function readTable() {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    let ps;
    try {
      ps = spawn('ps', ['-o', 'pid=,ppid=,lstart=', '-ax'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { finish(null); return; }
    const timer = setTimeout(() => { try { ps.kill('SIGKILL'); } catch { /* 已退出 */ } finish(null); }, LIMITS.probeTimeoutMs);
    ps.stdout.on('data', (d) => { out += d; if (out.length > 8 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024); });
    ps.on('error', () => { clearTimeout(timer); finish(null); });
    ps.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 清理整棵已跟踪进程树：快照 → 自底向上 SIGTERM → 宽限内重复扫描 → 身份仍匹配者 SIGKILL。
 * 返回 { ok, killed, survived, uncertain }；uncertain=true 时调用方不得判成功或重试。
 */
export async function terminateProcessTree(rootPid, { graceMs = LIMITS.killGraceMs } = {}) {
  const killed = new Set();
  const known = new Map(); // identity → row
  if (!rootPid) return { ok: true, killed: [], survived: [], uncertain: false };

  const scan = async () => {
    const raw = await readTable();
    if (raw === null) return null;
    const rows = parseProcessTable(raw);
    for (const row of treeFromTable(rows, rootPid)) known.set(identityOf(row), row);
    return rows;
  };

  let rows = await scan();
  if (rows === null) return { ok: false, killed: [], survived: [], uncertain: true };
  const signal = (row, sig) => {
    try { process.kill(row.pid, sig); killed.add(identityOf(row)); return true; } catch { return false; }
  };
  // 后代先于父代
  for (const row of treeFromTable(rows, rootPid)) signal(row, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  let survived = [];
  while (Date.now() < deadline) {
    await sleep(LIMITS.killScanIntervalMs); // eslint-disable-line no-await-in-loop
    rows = await scan(); // eslint-disable-line no-await-in-loop
    if (rows === null) return { ok: false, killed: [...killed], survived: [], uncertain: true };
    const live = new Map(rows.map((r) => [r.pid, r]));
    // 宽限期内新派生的后代也要收
    for (const row of treeFromTable(rows, rootPid)) if (!killed.has(identityOf(row))) signal(row, 'SIGTERM');
    survived = [...known.values()].filter((r) => {
      const now = live.get(r.pid);
      return now && now.start === r.start; // 身份仍匹配才算残留（PID 复用不误判）
    });
    if (!survived.length && !live.has(rootPid)) break;
  }

  rows = await scan();
  if (rows === null) return { ok: false, killed: [...killed], survived: survived.map((r) => r.pid), uncertain: true };
  const live = new Map(rows.map((r) => [r.pid, r]));
  survived = [...known.values()].filter((r) => { const n = live.get(r.pid); return n && n.start === r.start; });
  for (const row of survived) signal(row, 'SIGKILL');
  await sleep(LIMITS.killScanIntervalMs);
  const after = await readTable();
  if (after === null) return { ok: false, killed: [...killed], survived: survived.map((r) => r.pid), uncertain: true };
  const afterLive = new Map(parseProcessTable(after).map((r) => [r.pid, r]));
  const stillThere = survived.filter((r) => { const n = afterLive.get(r.pid); return n && n.start === r.start; });
  return {
    ok: stillThere.length === 0,
    killed: [...killed],
    survived: stillThere.map((r) => r.pid),
    uncertain: stillThere.length > 0,
  };
}

/** 有界探测 CLI 是否可用；异步、带 TTL 缓存与 in-flight 去重，不用 spawnSync 阻塞宿主。 */
const probeCache = new Map(); // id → { at, gen, value }
const probeInflight = new Map(); // `${id}:${gen}` → Promise
// refresh 语义（评审 §18.2）：清缓存必须同时让旧探测失效——否则进行中的旧 Promise
// 被复用、完成后还把安装前的旧结果回写缓存 60s。generation 计数解决竞态：
// 去重按 (id,gen)，旧代结果不得写缓存。
let probeGeneration = 0;

export async function probeRuntime(spec, { env = buildChildEnv(), now = Date.now() } = {}) {
  const gen = probeGeneration;
  const cached = probeCache.get(spec.id);
  if (cached && cached.gen === gen && now - cached.at < LIMITS.probeTtlMs) return cached.value;
  const inflightKey = `${spec.id}:${gen}`;
  if (probeInflight.has(inflightKey)) return probeInflight.get(inflightKey);
  const task = (async () => {
    // 失败结果同样进缓存：否则每次请求都重新解析 PATH / spawn，探测成了热路径开销
    const remember = (value) => { if (gen === probeGeneration) probeCache.set(spec.id, { at: Date.now(), gen, value }); return value; };
    if (process.platform === 'win32') return remember({ id: spec.id, available: false, reason: 'unsupported-platform' });
    const bin = await resolveBin(spec.bin, env);
    if (!bin) return remember({ id: spec.id, available: false, reason: 'not-installed' });
    const value = await new Promise((resolve) => {
      let out = '';
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      let child;
      try {
        child = spawn(bin, spec.probeArgs || ['--version'], { cwd: env.HOME || '/', env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { finish({ id: spec.id, available: false, reason: 'spawn-failed' }); return; }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } finish({ id: spec.id, available: false, reason: 'probe-timeout' }); }, LIMITS.probeTimeoutMs);
      child.stdout.on('data', (d) => { if (out.length < 4096) out += d; });
      child.on('error', () => { clearTimeout(timer); finish({ id: spec.id, available: false, reason: 'spawn-failed' }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const version = out.split('\n')[0].trim().slice(0, 120);
        finish(code === 0 && version
          ? { id: spec.id, available: true, version, bin }
          : { id: spec.id, available: false, reason: 'probe-failed' });
      });
    });
    return remember(value);
  })();
  probeInflight.set(inflightKey, task);
  try { return await task; } finally { probeInflight.delete(inflightKey); }
}

export function clearProbeCache() { probeGeneration += 1; probeCache.clear(); }

// ---- 节点级权限模式（设计 §17/§18：单点解析，适配器只做防御性复核）----
// 默认受限；全权限须节点显式选择 + 运行期授权（runtime-grants）。pi 无沙箱能力，
// 恒 full 且忽略携带值（准入由 enablePiRuntime 门禁单独管）。
export const RUNTIME_PERMISSION_MODES = Object.freeze({
  codex: ['sandbox', 'full'],
  claude: ['restricted', 'bash', 'full'],
  pi: [],
});
export const DEFAULT_RUNTIME_PERMISSION = Object.freeze({ codex: 'sandbox', claude: 'restricted', pi: 'full' });

export function resolveRuntimePermission(runtimeId, raw) {
  if (runtimeId === 'pi') return 'full';
  const modes = RUNTIME_PERMISSION_MODES[runtimeId];
  if (!modes) {
    const e = new Error(`未知 runtime「${runtimeId}」的权限模式`); e.code = 'RUNTIME_BAD_PERMISSION'; e.retryable = false; throw e;
  }
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RUNTIME_PERMISSION[runtimeId];
  if (typeof raw !== 'string' || !modes.includes(raw)) {
    const e = new Error(`runtime「${runtimeId}」的权限模式「${String(raw)}」无效（可选：${modes.join('/')}）`);
    e.code = 'RUNTIME_BAD_PERMISSION'; e.retryable = false; throw e;
  }
  return raw;
}

// elevated = 需要运行期显式授权的高权限（pi 走实例级门禁，不在此列）
export function isElevatedPermission(runtimeId, permission) {
  return (runtimeId === 'codex' && permission === 'full')
    || (runtimeId === 'claude' && (permission === 'bash' || permission === 'full'));
}

/** 轨迹 entry 构造（与 foldTraceEvent 的 kinds/上限同口径）。 */
export function pushEntry(acc, entry) {
  if (acc.entries.length >= LIMITS.maxEntries) { acc.entriesTruncated = true; return; }
  acc.entries.push(entry);
}

export function newAcc() {
  return {
    entries: [], entriesTruncated: false, preview: '', turns: 0, usage: null,
    finalText: '', fatal: null, sawTerminal: false, unknownEvents: new Set(),
    resultFileText: null,
  };
}

/**
 * 执行一次外部 CLI invocation。
 * 只承诺协议可观测条件；业务是否真履约由调用方按 schema / requireArtifact 验收。
 * 总超时是唯一硬上限（stall 看门狗需各 adapter 语义验证后才启用，P1 不开）。
 */
// 诊断插桩：WF1_RUNTIME_DEBUG=1 时把组件边界的数据流打到宿主日志，
// 用于定位「独立跑正常、内嵌挂起」这类只在特定宿主状态复现的问题。
const dbg = (...args) => { if (process.env.WF1_RUNTIME_DEBUG) console.error('[rt-debug]', ...args); };

export async function runExternalCli({
  adapter, bin, argv, stdin, cwd, env = buildChildEnv(), signal,
  timeoutMs, onProgress, files,
}) {
  const acc = newAcc();
  dbg(adapter.id, 'spawn', JSON.stringify({ bin, argv, cwd, envKeys: Object.keys(env), stdinLen: (stdin || '').length, timeoutMs, hasSignal: Boolean(signal), signalAborted: signal?.aborted === true }));
  dbg(adapter.id, 'stdin-content', JSON.stringify(String(stdin || '').slice(0, 500)));
  if (signal?.aborted) { const e = new Error('运行已取消'); e.code = 'RUNTIME_CANCELED'; throw e; }
  if (process.platform === 'win32') { const e = new Error('外部 runtime 暂不支持 Windows 原生平台'); e.code = 'RUNTIME_UNSUPPORTED_PLATFORM'; e.retryable = false; throw e; }

  let child;
  try {
    child = spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  } catch (error) {
    const e = new Error(`${adapter.id} 启动失败：${error.message}`); e.code = 'RUNTIME_SPAWN_FAILED'; e.retryable = false; throw e;
  }

  let stderrTail = '';
  let stdoutPlainTail = '';
  let stdoutBytes = 0;
  let frameError = null;
  const splitter = createFrameSplitter((text) => {
    let obj;
    try { obj = JSON.parse(text); } catch {
      // 非 JSONL 的 stdout 行不参与终态，但必须留作诊断：
      // 实测 codex 启动期失败（如模型不可用）把真正原因写在 stdout 纯文本里，
      // stderr 只有 "Reading prompt from stdin..."，丢掉它就只剩一个退出码可看。
      dbg(adapter.id, 'stdout-plain', text.slice(0, 160));
      stdoutPlainTail = redactSecrets(`${stdoutPlainTail}${text}\n`).slice(-4096);
      return;
    }
    dbg(adapter.id, 'frame', obj.type || '?', obj.subtype || '', obj.type === 'result' ? JSON.stringify({ subtype: obj.subtype, is_error: obj.is_error }).slice(0, 120) : '', obj.type === 'stream_event' ? JSON.stringify(obj.event?.delta || {}).slice(0, 140) : '');
    try { adapter.onFrame(obj, acc); } catch (error) { frameError = frameError || error; dbg(adapter.id, 'onFrame-throw', String(error && error.message)); }
    if (acc.preview.length > LIMITS.maxPreviewChars) acc.preview = acc.preview.slice(0, LIMITS.maxPreviewChars);
    onProgress?.(acc);
  });

  child.stdout.on('data', (d) => { stdoutBytes += d.length; splitter.push(d); });
  child.stderr.on('data', (d) => {
    dbg(adapter.id, 'stderr', d.toString('utf8').slice(0, 160));
    stderrTail = redactSecrets(stderrTail + d.toString('utf8')).slice(-LIMITS.maxStderrBytes);
  });
  // stdin 写失败（子进程早退）不能炸掉宿主
  child.stdin.on('error', (e) => { dbg(adapter.id, 'stdin-error', String(e && e.message)); /* EPIPE：由 close/终态判定收口 */ });
  if (stdin) { try { child.stdin.end(stdin); dbg(adapter.id, 'stdin-ended', (stdin || '').length); } catch (e) { dbg(adapter.id, 'stdin-end-throw', String(e && e.message)); } } else { try { child.stdin.end(); } catch { /* noop */ } }

  let timedOut = false;
  let canceled = false;
  let cleanup = null;
  const stop = async (reason) => {
    if (cleanup) return cleanup;
    if (reason === 'timeout') timedOut = true;
    if (reason === 'cancel') canceled = true;
    cleanup = terminateProcessTree(child.pid).then((r) => { cleanupResult = r; return r; });
    return cleanup;
  };
  let cleanupResult = null;

  const onAbort = () => { void stop('cancel'); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => { void stop('timeout'); }, timeoutMs) : null;

  const exit = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; dbg(adapter.id, 'exit', JSON.stringify(v)); resolve(v); } };
    child.on('error', (error) => finish({ code: null, signal: null, spawnError: error.message }));
    // close 而非 exit：等 stdio 关闭，避免尾帧丢失
    child.on('close', (code, sig) => finish({ code, signal: sig }));
  });

  if (timer) clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  // 自然退出也要核对已跟踪后代（CLI 可能留下后台子孙）
  if (!cleanup) cleanupResult = await terminateProcessTree(child.pid, { graceMs: 1000 });
  else await cleanup;

  const flushed = splitter.flush();
  const finalized = adapter.finalize(acc, exit, { stderrTail, stdoutPlainTail, files });

  const base = {
    entries: acc.entries, entriesTruncated: acc.entriesTruncated, preview: acc.preview,
    turns: finalized.turns ?? acc.turns, usage: finalized.usage ?? acc.usage,
    unknownEvents: [...acc.unknownEvents], stderrTail, stdoutPlainTail, stdoutBytes,
    exitCode: exit.code, exitSignal: exit.signal, cleanup: cleanupResult,
    timedOut, canceled,
  };
  if (frameError) {
    const e = new Error(`${adapter.id} 事件处理异常：${frameError.message}`); e.code = 'RUNTIME_PROTOCOL_ERROR'; e.retryable = false;
    return { ...base, text: '', error: e };
  }
  if (canceled) { const e = new Error('运行已取消'); e.code = 'RUNTIME_CANCELED'; return { ...base, text: '', error: e }; }
  if (timedOut) { const e = new Error(`${adapter.id} 节点执行超时`); e.code = 'RUNTIME_TIMEOUT'; return { ...base, text: '', error: e }; }
  if (flushed.truncated) {
    const e = new Error(`${adapter.id} 输出帧截断或超限，终态不可信`); e.code = 'RUNTIME_OUTPUT_LIMIT'; e.retryable = false;
    return { ...base, text: '', error: e };
  }
  if (cleanupResult && (cleanupResult.uncertain || !cleanupResult.ok)) {
    const e = new Error(`${adapter.id} 进程清理未确认（残留 ${cleanupResult.survived.join(',') || '未知'}），不判成功`);
    e.code = 'RUNTIME_CLEANUP_UNCONFIRMED'; e.retryable = false;
    return { ...base, text: '', error: e };
  }
  if (finalized.error) return { ...base, text: finalized.text || '', error: finalized.error };
  return { ...base, text: finalized.text || '', error: null };
}

/** 产物目录的物理归属校验：词法子路径不足以证明仍在宿主运行根内。 */
export function assertInsideRealRoot(dir, root) {
  const realRoot = realpathSync(root);
  const realDir = realpathSync(dir);
  return realDir === realRoot || realDir.startsWith(realRoot + sep);
}
