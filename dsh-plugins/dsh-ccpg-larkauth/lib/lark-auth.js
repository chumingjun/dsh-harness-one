// lark-cli 授权集成：Device Flow 登录（--no-wait 发起 → 用户扫码 → --device-code 轮询完成）。
// 只包装官方 CLI 子进程，不碰 ~/.lark-cli/config.json 与 keychain；status 摘要供前端展示。
// 另含四块自维护能力，让 dsh 开箱即用：
//   1) ensureLarkCli        未安装时自动 npm 全局安装到 ~/.local/npm-global
//   2) setDefaultIdentityUser  默认身份固定为 user（config default-as user）
//   3) renewUserToken       后台定时触发 uat-client 刷新（refresh_token 轮换=授权永久续期）
//   4) ensureSkillFiles     feishu-cli 技能种子到 ~/.dsh/skills（dsh 原生技能根）

import { spawn, spawnSync } from 'node:child_process';
import { statSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const NPM_GLOBAL = join(homedir(), '.local', 'npm-global');
export const LARK_CLI_VERSION = '1.0.96';
const MAX_OUTPUT = 64 * 1024;

const CANDIDATES = [
  join(NPM_GLOBAL, 'bin', 'lark-cli'),
  '/usr/local/bin/lark-cli',
  '/opt/homebrew/bin/lark-cli',
];

const LARK_BIN_NAME = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli';

/** profile 内那一份 lark-cli 的二进制路径（装在 profile 里的 @larksuite/cli） */
export function profileLarkBin(profileDir) {
  return profileDir ? join(profileDir, 'node_modules', '@larksuite', 'cli', 'bin', LARK_BIN_NAME) : null;
}

// 装进 profile 的 lark-cli 既不在任何全局 bin 目录里，PATH 上通常也没有软链——
// 桌面版就是这样（Electron 自带 runtime/bin，PATH 上只有 node/pnpm 壳）。
// 不显式看 profile 目录就会把「已经装好、还登过录」判成「未安装」，所有授权动作被挡住。
// 由 apply() 从内核的 profileContext 登记；普通 dsh 手动把包装进 profile 时同样受益。
let _profileLarkDir = '';
export function setLarkProfileDir(dir) {
  _profileLarkDir = typeof dir === 'string' ? dir.trim() : '';
}

/**
 * 内核 profileContext 里本插件能用的部分：profile 目录，以及宿主随 profile 一起发布的
 * 包管理器调用 {command,args,env}。逐字段校验、缺一即弃——半截的调用跑不起来，
 * 那正是它要修的失败（与 dshmarket 的 hostPackageManagerOf 同一判据）。
 *
 * 官方 Electron 壳只发布这个服务：GUI 启动的进程不继承终端 PATH，没有 npm，
 * `npm i -g` 必然失败；宿主给的这条调用是唯一能在该 profile 里装包的路径。
 */
export function profileContextOf(context) {
  if (context === undefined || context === null || typeof context !== 'object') return null;
  const dir = typeof context.dir === 'string' ? context.dir.trim() : '';
  if (dir === '' || !isAbsolute(dir)) return null;
  const published = context.packageManager;
  let packageManager = null;
  if (published !== null && typeof published === 'object' && !Array.isArray(published)) {
    const command = typeof published.command === 'string' ? published.command.trim() : '';
    const args = Array.isArray(published.args) && published.args.every((arg) => typeof arg === 'string')
      ? [...published.args]
      : null;
    if (command !== '' && args) {
      // 只留字符串值：子进程环境是 Record<string,string>，混进数字或对象只会被悄悄丢掉
      const env = {};
      for (const [key, value] of Object.entries(published.env ?? {})) {
        if (typeof value === 'string') env[key] = value;
      }
      packageManager = { command, args, env };
    }
  }
  return {
    name: typeof context.name === 'string' ? context.name.trim() : '',
    dir,
    packageManager,
  };
}

// config init 输出的应用创建链接。user_code 是 XXXX-XXXX 形态的连字符串，
// 后面还跟 lpv/ocv/from 等 query 参数，一并捕获后由调用方 trim。
const LARK_INIT_URL_RE = /https:\/\/open\.feishu\.cn\/page\/cli\?user_code=[A-Za-z0-9-]+[^\s]*/;

// lark-cli 的 bin 是个 Node wrapper，内部再拉起真正的二进制——所以它有两层进程。
// 只结束 wrapper 会把二进制留成孤儿：config init 会一直阻塞到用户完成或超时，
// 反复点「重新获取链接」就逐个累积僵尸。故统一走「整棵进程树一起结束」。
const LARK_POSIX = process.platform !== 'win32';

/** 收集 root 及其所有后代 pid（自底向上，先子后父，避免先杀父进程丢失父子关系） */
function larkProcessTree(rootPid) {
  if (!LARK_POSIX) return [rootPid];
  try {
    const out = spawnSync('ps', ['-o', 'pid=,ppid=', '-ax'], { encoding: 'utf8', timeout: 3000 }).stdout || '';
    const children = new Map();
    for (const line of out.split('\n')) {
      const hit = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!hit) continue;
      const ppid = Number(hit[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(hit[1]));
    }
    const collected = [];
    const walk = (pid) => {
      for (const kid of children.get(pid) || []) { walk(kid); collected.push(kid); }
    };
    walk(rootPid);
    return [...collected, rootPid];
  } catch {
    return [rootPid]; // ps 不可用则只结束自身
  }
}

function terminateLark(child) {
  if (!child?.pid) return;
  for (const pid of larkProcessTree(child.pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
}

export function larkCliBin() {
  const found = [profileLarkBin(_profileLarkDir), ...CANDIDATES]
    .find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  if (found) return found;
  try {
    const r = spawnSync('which', ['lark-cli'], { timeout: 3000 });
    const p = r.status === 0 ? String(r.stdout).trim() : '';
    if (p && statSync(p).isFile()) return p;
  } catch { /* PATH 无 lark-cli */ }
  return null;
}

function localLarkCliAvailable() {
  return Boolean(larkCliBin());
}

function parseResult(out, err, ok) {
  const text = (out || err || '').trim();
  try {
    const parsed = JSON.parse(text);
    return parsed.ok !== undefined ? { ...parsed, ok: ok && parsed.ok !== false } : { ok, ...parsed };
  } catch {
    return { ok, raw: text.slice(0, 2000) };
  }
}

function runLocal(args, { timeoutMs = 20000 } = {}) {
  const bin = larkCliBin();
  if (!bin) return Promise.resolve({ ok: false, error: 'lark-cli not installed' });
  return new Promise((resolve) => {
    const child = spawn(bin, args, { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    child.on('close', (code) => {
      resolve(parseResult(out, err, code === 0));
    });
  });
}

function runtimeAvailable(runtime) {
  return runtime ? runtime.available() : localLarkCliAvailable();
}

function runtimeRun(runtime, args, options) {
  return runtime ? runtime.run(args, options) : runLocal(args, options);
}

/**
 * lark-cli 的 error 是 {type,subtype,message,hint}，message 往往只有 "not configured"
 * 这种天书短句，而 hint 才带可执行指引。统一优先吐 hint。
 */
export function formatCliError(error, fallback = '操作失败') {
  if (!error) return fallback;
  if (typeof error === 'string') return error.trim() || fallback;
  const hint = typeof error.hint === 'string' ? error.hint.trim() : '';
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  return hint || message || fallback;
}

/** CLI 的 JSON 错误体里带 subtype === 'not_configured' 表示还没绑定飞书应用 */
function isNotConfigured(res) {
  const e = res?.error;
  return Boolean(e && typeof e === 'object' && e.subtype === 'not_configured');
}

export function larkCliAvailable(runtime) {
  return runtimeAvailable(runtime);
}

/** 授权状态摘要：installed / installing / appId / defaultIdentity / user{...} / bot{status} / autoRenew{...} */
export async function larkAuthStatus(runtime) {
  const runtimeKind = runtime?.kind || 'local';
  if (!runtimeAvailable(runtime)) return { installed: false, installing: larkCliInstalling(runtime), runtime: runtimeKind };
  const res = await runtimeRun(runtime, ['auth', 'status', '--json'], { timeoutMs: 15000 });
  if (!res.ok && !res.appId) {
    // 未绑定飞书应用：不是「已安装待登录」，而是「扫码登录必然失败」，
    // 前端要据此改走 config init 引导，否则用户只会看到 not configured。
    if (isNotConfigured(res)) {
      return { installed: true, configured: false, runtime: runtimeKind, error: formatCliError(res.error, 'not configured') };
    }
    return { installed: true, error: formatCliError(res.error, res.raw || 'auth status 失败') };
  }
  const user = res.identities?.user || {};
  const bot = res.identities?.bot || {};
  return {
    installed: true,
    configured: true,
    runtime: runtimeKind,
    appId: res.appId,
    defaultIdentity: res.defaultAs || 'auto',
    user: user.available ? {
      userName: user.userName,
      openId: user.openId,
      tokenStatus: user.tokenStatus,
      expiresAt: user.expiresAt,
      refreshExpiresAt: user.refreshExpiresAt,
    } : { tokenStatus: user.status || 'none' },
    bot: { status: bot.status || 'unknown' },
    autoRenew: larkRenewState(),
  };
}

/** 发起设备流登录：返回 verification_url / user_code / device_code / expires_in */
export async function larkLoginStart({ recommend = true, domain, runtime } = {}) {
  const args = ['auth', 'login', '--no-wait', '--json'];
  if (recommend) args.push('--recommend');
  if (domain) args.push('--domain', String(domain));
  const res = await runtimeRun(runtime, args, { timeoutMs: 20000 });
  if (!res.verification_url) {
    // 未配置应用时 message 只有 "not configured"，hint 才说明要先 config init
    const needsInit = isNotConfigured(res);
    return {
      ok: false,
      needsInit,
      error: needsInit ? '尚未配置飞书应用，请先完成应用创建' : formatCliError(res.error, res.raw || '发起登录失败'),
    };
  }
  return {
    ok: true,
    verificationUrl: res.verification_url,
    userCode: res.user_code || '',
    deviceCode: res.device_code,
    expiresIn: res.expires_in || 600,
  };
}

// 更换应用：config init 不带 --new 是交互式向导（无 TTY 直接报错），必须配伪终端。
// node-pty 由宿主提供（dsh 主安装与 DSH Desktop 都自带），插件不引依赖；
// 通过 createRequire 以「插件自身位置 → 宿主 dsh 主安装」的解析链加载，
// 两处都解析不到时降级为可读报错（不打断其余功能）。
function loadNodePty() {
  // node-pty 不是本插件的依赖，靠宿主注入：先按普通包名解析（宿主 bundle 场景），
  // 再按「node 可执行文件同级的 dsh 主安装」物理路径兜底（独立 node 直跑场景）。
  const req = createRequire(import.meta.url);
  const candidates = ['node-pty'];
  try {
    const globalRoot = join(dirname(process.execPath), '..', 'lib', 'node_modules');
    candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', 'node-pty'));
  } catch { /* 非 node 直跑 */ }
  for (const candidate of candidates) {
    try { return req(candidate); } catch { /* 下一处候选 */ }
  }
  return null;
}

/** 从 PTY 原始输出里剥 ANSI 转义序列，供 URL 正则匹配（含 OSC 块与 CSI 参数） */
function stripAnsi(s) {
  return s
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
}

/**
 * 伪终端里跑交互式「config init」（不带 --new）——更换应用的入口。
 * bin 由调用方解析（本地装在 PATH，Desktop 装在 profileDir/node_modules）。
 *
 * 向导菜单依次是 语言 → 一键配置应用(推荐)/手动输入凭证 → 平台 → 浏览器授权页。
 * 三个菜单的默认项即所需路径（中文 / 一键配置 / 飞书），统一策略 =
 * 等屏幕静止后按回车确认默认项，不做方向键选择。
 * 浏览器页里才真正决定「选已有应用还是建新的」。
 *
 * 其余行为与 --new 模式一致：URL 命中即 resolve，PTY 留着等浏览器结果，
 * cancel()/dispose() 时按进程树结束（wrapper + 二进制两层）。
 *
 * 用户在浏览器里点「确认」后向导进程自行退出——这是「更换完成」的权威信号
 * （比对比 appId 可靠：用户可能重选了同一个应用，appId 不变但配置已重写）。
 * 结果经 done 回调交付；done 不会因 cancel()/超时触发，调用方自行处理这两种路径。
 */
function larkConfigInitSwitchPty({ bin, cwd, timeoutMs = 60000, onDone } = {}) {
  const Pty = loadNodePty();
  if (!Pty) {
    return Promise.resolve({ ok: false, error: '更换应用需要伪终端支持（node-pty），当前环境不可用；可改用「创建飞书应用」或在终端执行 lark-cli config init' });
  }
  return new Promise((resolve) => {
    let proc;
    try {
      proc = Pty.spawn(bin, ['config', 'init'], {
        name: 'xterm-256color', cols: 100, rows: 40, cwd: cwd || homedir(),
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
      return;
    }
    let out = '';
    let urlSeen = false;
    let settled = false;
    let answered = 0;
    let lastLen = -1;
    let sameCount = 0;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(nudge);
      resolve(r);
    };
    const onData = (d) => {
      out += d;
      const m = stripAnsi(out.slice(-16384)).match(LARK_INIT_URL_RE);
      if (m) {
        urlSeen = true;
        finish({
          ok: true,
          verificationUrl: m[0].trim(),
          cancel: () => terminateLark({ pid: proc.pid }),
        });
      }
    };
    // 屏幕静止 ≥1.6s 且仍在等菜单确认 → 按回车选默认项（最多 5 屏，防失控）
    const nudge = setInterval(() => {
      if (settled) return;
      if (out.length === lastLen) sameCount += 1; else { sameCount = 0; lastLen = out.length; }
      if (sameCount >= 2 && /enter submit/.test(stripAnsi(out.slice(-1500)))) {
        answered += 1;
        if (answered > 5) return;
        try { proc.write('\r'); } catch { /* 已退出 */ }
        sameCount = 0;
        lastLen = out.length;
      }
    }, 800);
    const timer = setTimeout(() => {
      try { terminateLark({ pid: proc.pid }); } catch { /* 已退出 */ }
      finish({ ok: false, error: '获取应用更换链接超时，请重试' });
    }, timeoutMs);
    proc.onData(onData);
    // URL 抓到后进程自然退出 = 用户在浏览器完成更换（重选同一个应用也会走到这）
    proc.onExit(() => {
      if (urlSeen && onDone) onDone();
      finish({ ok: false, error: '未获取到应用更换链接，请重试' });
    });
  });
}

/**
 * 创建/绑定飞书应用（lark-cli config init --new）——所有授权动作的前置条件。
 * switchApp=true 走上面的伪终端向导（浏览器里可选已有应用或建新的）。
 *
 * 该命令阻塞到用户在浏览器完成应用创建为止，用户不配置就一直挂着，因此：
 *   - URL 只能「边跑边抓」，不能等 close（等不到）
 *   - 实测二维码与 URL 全部走 **stderr**，stdout 全空；只听 stdout 会永远抓不到
 *   - 输出被缓冲成整块吐出，但跨 chunk 累积更稳（分块方式随版本/平台可能变）
 *   - Windows 下输出是 CRLF，正则后必须 trim 掉 \r，否则前端 <a href> 带尾字符
 *
 * 返回 {ok, verificationUrl, cancel}；URL 一旦命中即 resolve，进程继续在后台等用户。
 */
// 用户在浏览器完成更换后向导进程退出、配置整体重写（换同一应用 appId 也不变），
// 完成信号只能由进程退出给出——把回调透传给 PTY 实现
export function larkConfigInit({ runtime, timeoutMs = 60000, switchApp = false, onDone } = {}) {
  // 更换应用（交互式向导）：本地与 Desktop 都走 PTY，只是 bin 与 cwd 来源不同
  if (switchApp) {
    if (!runtimeAvailable(runtime)) return Promise.resolve({ ok: false, error: 'lark-cli not installed' });
    if (runtime) return runtime.configInit({ timeoutMs, switchApp: true, onDone });
    const bin = larkCliBin();
    if (!bin) return Promise.resolve({ ok: false, error: 'lark-cli not installed' });
    return larkConfigInitSwitchPty({ bin, timeoutMs, onDone });
  }
  if (!runtimeAvailable(runtime)) return Promise.resolve({ ok: false, error: 'lark-cli not installed' });
  if (runtime) return runtime.configInit({ timeoutMs });

  const bin = larkCliBin();
  if (!bin) return Promise.resolve({ ok: false, error: 'lark-cli not installed' });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['config', 'init', '--new'], { detached: LARK_POSIX });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
      return;
    }
    let buf = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const onData = (d) => {
      buf = (buf + String(d)).slice(-MAX_OUTPUT);
      const m = buf.match(LARK_INIT_URL_RE);
      if (m) finish({ ok: true, verificationUrl: m[0].trim(), cancel: () => terminateLark(child) });
    };
    const timer = setTimeout(() => {
      terminateLark(child);
      finish({ ok: false, error: '获取应用创建链接超时，请重试' });
    }, timeoutMs);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish({ ok: false, error: String(e.message || e) }));
    child.on('close', (code) => finish({
      ok: false,
      error: code === 0 ? '未获取到应用创建链接，请重试' : `应用创建失败（退出码 ${code}）`,
    }));
  });
}

/**
 * 生成登录二维码 PNG（data URL）。qrcode 子命令要求 --output 为相对路径，
 * 故在临时目录执行后读回、清理。
 */
export async function larkLoginQrcode(verificationUrl, runtime) {
  if (!runtimeAvailable(runtime)) return { ok: false, error: 'lark-cli not installed' };
  if (runtime) return runtime.qrcode(verificationUrl);
  const dir = mkdtempSync(join(tmpdir(), 'wf1-qr-'));
  const bin = larkCliBin();
  return new Promise((resolve) => {
    const child = spawn(bin, ['auth', 'qrcode', verificationUrl, '--output', 'qr.png'], {
      cwd: dir, timeout: 15000,
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { rmSync(dir, { recursive: true, force: true }); resolve({ ok: false, error: String(e.message || e) }); });
    child.on('close', () => {
      try {
        const buf = readFileSync(join(dir, 'qr.png'));
        rmSync(dir, { recursive: true, force: true });
        resolve({ ok: true, dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
      } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        resolve({ ok: false, error: err || String(e.message || e) });
      }
    });
  });
}

/** 用 device_code 轮询完成授权（用户扫码确认后调用；CLI 阻塞至成功/超时） */
export async function larkLoginPoll(deviceCode, runtime) {
  const res = await runtimeRun(runtime, ['auth', 'login', '--device-code', String(deviceCode), '--json'], { timeoutMs: 60000 });
  if (res.ok) {
    // 用户此刻正盯着面板等结果：固定默认身份与取授权状态两个 CLI 往返并行跑，
    // 确认到界面刷新能省一半时间；两者各写各的文件，无先后依赖。
    // 万一状态读取恰好撞上配置写入的瞬间（配置没读到），补读一次即可。
    const [, status] = await Promise.all([
      setDefaultIdentityUser(runtime),
      larkAuthStatus(runtime),
    ]);
    return { ok: true, status: (!status.configured || status.error) ? await larkAuthStatus(runtime) : status };
  }
  return { ok: false, error: formatCliError(res.error, '授权未完成') };
}

/** 退出登录（清 token） */
export async function larkLogout(runtime) {
  const res = await runtimeRun(runtime, ['auth', 'logout', '--json'], { timeoutMs: 20000 });
  return { ok: Boolean(res.ok), error: formatCliError(res.error) };
}

// ---------- 自动安装 ----------

let _installing = null; // 进行中的安装 Promise（防并发）
export function larkCliInstalling(runtime) { return runtime ? runtime.installing() : Boolean(_installing); }

/** 未安装时自动 npm 全局安装到 ~/.local/npm-global（bin 落在 CANDIDATES[0]） */
export function ensureLarkCli(runtime) {
  if (runtime) return runtime.install();
  if (localLarkCliAvailable()) return Promise.resolve({ ok: true, already: true, bin: larkCliBin() });
  if (_installing) return _installing;
  mkdirSync(join(NPM_GLOBAL, 'bin'), { recursive: true });
  _installing = new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', '@larksuite/cli', '--prefix', NPM_GLOBAL], { timeout: 300000 });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { _installing = null; resolve({ ok: false, error: `npm 不可用：${e.message || e}` }); });
    child.on('close', (code) => {
      _installing = null;
      const bin = larkCliBin();
      if (code === 0 && bin) resolve({ ok: true, installed: true, bin });
      else resolve({ ok: false, error: (err || `npm 退出码 ${code}`).slice(-1500) });
    });
  });
  return _installing;
}

// ---------- 默认用户身份 ----------

/** 把 CLI 级默认身份固定为 user（agent 不加 --as 时也以用户身份执行） */
export async function setDefaultIdentityUser(runtime) {
  if (!runtimeAvailable(runtime)) return { ok: false, error: 'lark-cli not installed' };
  const res = await runtimeRun(runtime, ['config', 'default-as', 'user'], { timeoutMs: 15000 });
  const ok = res.ok !== false;
  return { ok, error: ok ? undefined : formatCliError(res.error, res.raw) };
}

// ---------- token 自动续约 ----------

// 飞书 user_access_token 约 2h 过期、refresh_token 约 7 天且每次刷新轮换重计。
// 周期性发一次真实用户 API 调用（uat-client 只在真正调 OpenAPI 时才自动刷新并轮换 refresh_token；
// whoami 只读本地状态、不触发刷新，不能用作续约探针）。
// 只要 dsh 在 refresh 窗口内运行过，授权就永久有效。
export const RENEW_INTERVAL_MS = 20 * 60 * 1000;
const RENEW_SOON_MS = 45 * 60 * 1000; // access token 剩余不足 45min 才触发刷新

const _renew = { lastAt: null, lastResult: null, running: false };
export function larkRenewState() { return { ..._renew, intervalMs: RENEW_INTERVAL_MS }; }

/** 续约一轮：临期/失效则发一次真实用户 API 调用触发 uat-client 刷新；返回最新状态摘要 */
export async function renewUserToken({ force = false, runtime } = {}) {
  if (!runtimeAvailable(runtime)) return { ok: false, skipped: 'not-installed' };
  if (_renew.running) return { ok: true, skipped: 'running' };
  _renew.running = true;
  try {
    const st = await runtimeRun(runtime, ['auth', 'status', '--json'], { timeoutMs: 15000 });
    const u = st.identities?.user || {};
    if (!u.available) {
      _renew.lastAt = new Date().toISOString();
      _renew.lastResult = 'no-user';
      return { ok: false, skipped: 'no-user' };
    }
    const refreshExp = Date.parse(u.refreshExpiresAt || '');
    if (refreshExp && refreshExp < Date.now()) {
      _renew.lastAt = new Date().toISOString();
      _renew.lastResult = 'refresh-expired';
      return { ok: false, expired: true }; // refresh 窗口已过，只能重新扫码
    }
    const exp = Date.parse(u.expiresAt || '');
    const soon = !exp || exp - Date.now() < RENEW_SOON_MS;
    if (!force && !soon && u.tokenStatus === 'valid') {
      _renew.lastAt = new Date().toISOString();
      _renew.lastResult = 'fresh';
      return { ok: true, skipped: 'fresh' };
    }
    const call = await runtimeRun(runtime, ['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user'], { timeoutMs: 30000 });
    const after = await runtimeRun(runtime, ['auth', 'status', '--json'], { timeoutMs: 15000 });
    const au = after.identities?.user || {};
    _renew.lastAt = new Date().toISOString();
    const callError = call.ok === false ? (call.error?.message || call.error || call.raw) : null;
    _renew.lastResult = au.tokenStatus === 'valid' ? 'renewed' : `failed:${au.tokenStatus || 'unknown'}${callError ? `:${String(callError).slice(0, 200)}` : ''}`;
    return { ok: au.tokenStatus === 'valid', tokenStatus: au.tokenStatus, expiresAt: au.expiresAt, refreshExpiresAt: au.refreshExpiresAt, ...(callError ? { error: callError } : {}) };
  } finally {
    _renew.running = false;
  }
}

// ---------- feishu-cli 技能种子 ----------

const SKILL_ID = 'feishu-cli';
const SKILL_MARKER = 'managed-by: dsh-ccpg-larkauth';
const BUNDLED_SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'feishu-cli.md');

function seedSkillFile(targetDir) {
  const src = readFileSync(BUNDLED_SKILL, 'utf8');
  const target = join(targetDir, `${SKILL_ID}.md`);
  // 不覆盖用户改过的文件：只写缺失的，或仍带管理标记（上一轮我们写的）的
  if (existsSync(target)) {
    const cur = readFileSync(target, 'utf8');
    if (!cur.includes(SKILL_MARKER)) return null;
    if (cur === src) return null;
  }
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, src);
  return target;
}

/**
 * 把 feishu-cli 技能种子到 dsh 的用户级技能发现根 ~/.dsh/skills/
 * （dsh-skill-filesystem 自动发现，官方聊天 agent 与画布 agent 共用）。
 * 另：~/.agents/skills 缺官方 lark-* 技能时后台 npx skills add 补齐（best-effort，不阻塞）。
 */
export function ensureSkillFiles({ log, installOfficial = true } = {}) {
  const written = [];
  const dirs = [join(homedir(), '.dsh', 'skills')];
  for (const dir of dirs) {
    try {
      const w = seedSkillFile(dir);
      if (w) { written.push(w); log?.(`技能已种子: ${w}`); }
    } catch (e) { log?.(`技能种子失败 ${dir}: ${e.message || e}`); }
  }
  // 官方 lark-* 技能（lark-doc/lark-im/lark-base 等）：装到 ~/.agents/skills，dsh 同为发现根
  const agentsSkills = join(homedir(), '.agents', 'skills');
  if (installOfficial && !existsSync(join(agentsSkills, 'lark-shared'))) {
    const child = spawn('npx', ['-y', 'skills', 'add', 'larksuite/cli', '-g', '-y'], { timeout: 300000 });
    child.on('error', (e) => log?.(`官方 lark 技能安装跳过：${e.message || e}`));
    child.on('close', (code) => log?.(code === 0 ? '官方 lark-* 技能已安装到 ~/.agents/skills' : `官方 lark 技能安装退出码 ${code}`));
  }
  return written;
}

// pnpm v10/11 默认拦截 @larksuite/cli 的 postinstall，会把占位值或 false 写进
// profile 的 pnpm-workspace.yaml（allowBuilds.'@larksuite/cli'），二进制永远不下载，
// 且后续每次 pnpm exec 都因 ignored-builds 失败（Desktop 的 pnpm 服务强制 CI=true，
// 报错被吞只剩 exit=1）。检测到就统一改为 true：lark-cli 的 postinstall 只下载
// 官方二进制且带校验和，可信。
function ensureAllowBuilds(profileDir) {
  const file = join(profileDir, 'pnpm-workspace.yaml');
  try {
    const before = readFileSync(file, 'utf8');
    const after = before
      .replace("'@larksuite/cli': set this to true or false", "'@larksuite/cli': true")
      .replace("'@larksuite/cli': false", "'@larksuite/cli': true");
    if (after === before) return false;
    writeFileSync(file, after);
    return true;
  } catch {
    return false;
  }
}

/**
 * profile 内的 lark-cli runtime。
 *
 * 装包通道有两种来源，装包能力因此是二选一而不是可有可无：
 *   - desktopPnpm.run(args)  第三方桌面壳（deepseek-harness-desktop）发布的受管 pnpm
 *   - packageManager         官方 Electron 壳随 profile 一起发布的 {command,args,env}
 *                            （内核 profileContext.packageManager）
 * 两者都没有时只保留「已装就能用」的能力，install() 直接报错——那种宿主里既没有受管
 * pnpm 也没有 npm（GUI 启动不继承终端 PATH），跑 `npm i -g` 只会留下一个假失败。
 */
export function createDesktopLarkCliRuntime({ desktopPnpm, packageManager, profileDir, version = LARK_CLI_VERSION }) {
  if (!profileDir) throw new TypeError('profileDir is required');
  if (!desktopPnpm?.run && !packageManager?.command) throw new TypeError('desktopPnpm or packageManager is required');
  const target = `@larksuite/cli@${version}`;
  let active = null;
  let initChild = null;
  let disposed = false;
  let installing = null;
  let tail = Promise.resolve();

  const available = () => {
    try {
      const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
      return Boolean(pkg.dependencies?.['@larksuite/cli'] || pkg.devDependencies?.['@larksuite/cli']) && binReady();
    } catch {
      return false;
    }
  };

  const binReady = () => {
    try {
      return statSync(profileLarkBin(profileDir)).isFile();
    } catch {
      return false;
    }
  };

  const enqueue = (task) => {
    const result = tail.then(task, task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const runManagedPnpm = (args, { timeoutMs = 20000 } = {}) => enqueue(async () => {
    if (disposed) return { ok: false, error: 'Desktop generation disposed' };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      active?.cancel();
    }, timeoutMs);
    let out = '';
    let err = '';
    try {
      active = desktopPnpm.run(args, controller.signal);
      const append = (current, chunk) => (current + String(chunk)).slice(-MAX_OUTPUT);
      active.stdout?.on?.('data', (chunk) => { out = append(out, chunk); });
      active.stderr?.on?.('data', (chunk) => { err = append(err, chunk); });
      const outcome = await active.done;
      const ok = outcome.exitCode === 0 && outcome.signal == null;
      const parsed = parseResult(out, err, ok);
      if (!ok) {
        parsed.ok = false;
        parsed.error ||= timedOut
          ? `lark-cli operation timed out after ${timeoutMs}ms`
          : `lark-cli operation failed: exit=${String(outcome.exitCode)} signal=${String(outcome.signal)}`;
      }
      return parsed;
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
      active = null;
    }
  });

  /**
   * 宿主发布的包管理器（官方 Electron 壳：profileContext.packageManager = 内置 node +
   * pnpm.mjs + 它自己的 PATH）。自己 spawn，不用 desktopPnpm——那个 service 在官方壳里
   * 根本不存在，等它等于让整条装包路径永远走不通。
   * 环境合并规则照抄 dshmarket 的 spawnEnv：宿主那份 env 在前（GUI 进程的 PATH 上通常什么
   * 都没有，内置 Node 必须赢），CI=true 压过一切（pnpm v10+ 没有 TTY 会永远等在交互提示上）。
   */
  const runPublishedPnpm = (args, { timeoutMs = 20000 } = {}) => enqueue(() => new Promise((resolve) => {
    if (disposed) {
      resolve({ ok: false, error: 'Desktop generation disposed' });
      return;
    }
    const separator = process.platform === 'win32' ? ';' : ':';
    const hostEnv = packageManager.env ?? {};
    const env = {
      ...process.env,
      ...hostEnv,
      PATH: [hostEnv.PATH, process.env.PATH].filter((part) => part !== '').join(separator),
      CI: 'true',
    };
    let child;
    try {
      child = spawn(packageManager.command, [...packageManager.args, ...args], {
        cwd: profileDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const append = (current, chunk) => (current + String(chunk)).slice(-MAX_OUTPUT);
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active?.child === child) active = null;
      if (error) {
        resolve({ ok: false, error: String(error.message || error) });
        return;
      }
      const ok = code === 0 && signal == null;
      const parsed = parseResult(out, err, ok);
      if (!ok) {
        parsed.ok = false;
        parsed.error ||= timedOut
          ? `lark-cli operation timed out after ${timeoutMs}ms`
          : `lark-cli operation failed: exit=${String(code)} signal=${String(signal)}`;
      }
      resolve(parsed);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    active = {
      child,
      cancel: () => child.kill(),
      done: new Promise((done) => child.once('close', done)),
    };
    child.stdout.on('data', (chunk) => { out = append(out, chunk); });
    child.stderr.on('data', (chunk) => { err = append(err, chunk); });
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  }));

  const runPnpm = (args, options) => (
    desktopPnpm?.run ? runManagedPnpm(args, options) : runPublishedPnpm(args, options)
  );

  const runCli = (args, { cwd = profileDir, timeoutMs = 20000 } = {}) => enqueue(() => new Promise((resolve) => {
    if (disposed) {
      resolve({ ok: false, error: 'Desktop generation disposed' });
      return;
    }
    const bin = profileLarkBin(profileDir);
    let child;
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const append = (current, chunk) => (current + String(chunk)).slice(-MAX_OUTPUT);
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active?.child === child) active = null;
      if (error) {
        resolve({ ok: false, error: String(error.message || error) });
        return;
      }
      const ok = code === 0 && signal == null;
      const parsed = parseResult(out, err, ok);
      if (!ok) {
        parsed.ok = false;
        parsed.error ||= timedOut
          ? `lark-cli operation timed out after ${timeoutMs}ms`
          : `lark-cli operation failed: exit=${String(code)} signal=${String(signal)}`;
      }
      resolve(parsed);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
    }, timeoutMs);
    try {
      child = spawn(bin, args, { cwd });
      active = {
        child,
        cancel: () => child.kill(),
        done: new Promise((done) => child.once('close', done)),
      };
      child.stdout.on('data', (chunk) => { out = append(out, chunk); });
      child.stderr.on('data', (chunk) => { err = append(err, chunk); });
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
    } catch (error) {
      finish(null, null, error);
    }
  }));

  /**
   * config init 与其它命令不同：它阻塞到用户在浏览器完成应用创建为止（可能数分钟）。
   * 刻意绕开 enqueue 队列——否则它会把 status 轮询一起堵死，前端拿不到配置完成的信号。
   * URL 命中即 resolve，进程留在后台等用户，直到 cancel()/dispose()。
   * switchApp=true 走伪终端向导（不带 --new，浏览器里可选已有应用）。
   */
  const configInit = ({ timeoutMs = 60000, switchApp = false, onDone } = {}) => {
    if (!binReady()) return Promise.resolve({ ok: false, error: 'lark-cli not installed' });
    const bin = profileLarkBin(profileDir);
    if (switchApp) return larkConfigInitSwitchPty({ bin, cwd: profileDir, timeoutMs, onDone });
    const initArgs = ['config', 'init', '--new'];
    return new Promise((resolve) => {
      if (disposed) {
        resolve({ ok: false, error: 'Desktop generation disposed' });
        return;
      }
      let child;
      try {
        child = spawn(bin, initArgs, { cwd: profileDir, detached: LARK_POSIX });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
        return;
      }
      initChild = child; // initArgs 固定为 ['config','init','--new']（switchApp 走 PTY 分流）
      let buf = '';
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (initChild === child) initChild = null;
        resolve(r);
      };
      const onData = (chunk) => {
        buf = (buf + String(chunk)).slice(-MAX_OUTPUT);
        const m = buf.match(LARK_INIT_URL_RE);
        if (m) finish({ ok: true, verificationUrl: m[0].trim(), cancel: () => terminateLark(child) });
      };
      const timer = setTimeout(() => {
        terminateLark(child);
        finish({ ok: false, error: '获取应用创建链接超时，请重试' });
      }, timeoutMs);
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (error) => finish({ ok: false, error: String(error.message || error) }));
      child.once('close', (code) => finish({
        ok: false,
        error: code === 0 ? '未获取到应用创建链接，请重试' : `应用创建失败（退出码 ${code}）`,
      }));
    });
  };

  const runtime = {
    kind: 'desktop',
    available,
    installing: () => Boolean(installing),
    run: runCli,
    configInit,
    install() {
      if (available()) return Promise.resolve({ ok: true, already: true, target });
      if (installing) return installing;
      installing = (async () => {
        ensureAllowBuilds(profileDir);
        // 49MB 官方二进制走 GitHub/npmmirror，国内链路常见慢下载，超时放宽到 15 分钟
        const result = await runPnpm(['add', '--save-exact', target], { timeoutMs: 900000 });
        // add 完成但二进制不在（postinstall 被 pnpm 拦截，或 add 把 pnpm-workspace.yaml
        // 重置回占位符/false）时补一次许可修复 + install。
        if (result.ok && !binReady()) {
          ensureAllowBuilds(profileDir);
          await runPnpm(['install'], { timeoutMs: 900000 });
        }
        if (binReady()) return { ...result, ok: true, target };
        const detail = result.ok === false && result.error ? `：${result.error}` : '';
        return { ok: false, target, error: `lark-cli 二进制下载失败（构建许可或网络），请稍后重试自动安装${detail}` };
      })().finally(() => { installing = null; });
      return installing;
    },
    async qrcode(verificationUrl) {
      const output = `.dsh-ccpg-larkauth-qr-${process.pid}-${Date.now().toString(36)}.png`;
      const file = join(profileDir, output);
      try {
        const result = await runtime.run(['auth', 'qrcode', verificationUrl, '--output', output], { timeoutMs: 15000 });
        if (!result.ok) return result;
        const buf = readFileSync(file);
        return { ok: true, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      } finally {
        rmSync(file, { force: true });
      }
    },
    async dispose() {
      disposed = true;
      active?.cancel();
      terminateLark(initChild);
      initChild = null;
      await active?.done.catch(() => {});
      await tail.catch(() => {});
    },
  };
  return runtime;
}
