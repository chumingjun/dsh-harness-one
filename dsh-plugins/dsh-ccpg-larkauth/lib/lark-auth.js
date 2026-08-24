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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_GLOBAL = join(homedir(), '.local', 'npm-global');
export const LARK_CLI_VERSION = '1.0.89';
const MAX_OUTPUT = 64 * 1024;

const CANDIDATES = [
  join(NPM_GLOBAL, 'bin', 'lark-cli'),
  '/usr/local/bin/lark-cli',
  '/opt/homebrew/bin/lark-cli',
];

export function larkCliBin() {
  const found = CANDIDATES.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
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

export function larkCliAvailable(runtime) {
  return runtimeAvailable(runtime);
}

/** 授权状态摘要：installed / installing / appId / defaultIdentity / user{...} / bot{status} / autoRenew{...} */
export async function larkAuthStatus(runtime) {
  const runtimeKind = runtime?.kind || 'local';
  if (!runtimeAvailable(runtime)) return { installed: false, installing: larkCliInstalling(runtime), runtime: runtimeKind };
  const res = await runtimeRun(runtime, ['auth', 'status', '--json'], { timeoutMs: 15000 });
  if (!res.ok && !res.appId) return { installed: true, error: res.error || res.raw || 'auth status 失败' };
  const user = res.identities?.user || {};
  const bot = res.identities?.bot || {};
  return {
    installed: true,
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
    return { ok: false, error: res.error?.message || res.error || res.raw || '发起登录失败' };
  }
  return {
    ok: true,
    verificationUrl: res.verification_url,
    userCode: res.user_code || '',
    deviceCode: res.device_code,
    expiresIn: res.expires_in || 600,
  };
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
    await setDefaultIdentityUser(runtime); // 授权成功即固定默认身份为 user
    const status = await larkAuthStatus(runtime);
    return { ok: true, status };
  }
  return { ok: false, error: res.error?.message || res.error || res.raw || '授权未完成' };
}

/** 退出登录（清 token） */
export async function larkLogout(runtime) {
  const res = await runtimeRun(runtime, ['auth', 'logout', '--json'], { timeoutMs: 20000 });
  return { ok: Boolean(res.ok), error: res.error?.message || res.error };
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
  return { ok, error: ok ? undefined : (res.error?.message || res.error || res.raw) };
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

// pnpm 11 忽略 @larksuite/cli 的 postinstall 时，会把占位值写进 profile 的
// pnpm-workspace.yaml（allowBuilds.'@larksuite/cli': set this to true or false）。
// 占位符不是合法 boolean，后续每次 pnpm exec 都因 ignored-builds 失败（Desktop 的
// pnpm 服务强制 CI=true，报错被吞只剩 exit=1）。检测到就替换为 true：lark-cli 的
// postinstall 只下载官方二进制，可信。
function repairAllowBuildsPlaceholder(profileDir) {
  const file = join(profileDir, 'pnpm-workspace.yaml');
  const PLACEHOLDER = "'@larksuite/cli': set this to true or false";
  try {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(PLACEHOLDER, "'@larksuite/cli': true");
    if (after === before) return false;
    writeFileSync(file, after);
    return true;
  } catch {
    return false;
  }
}

export function createDesktopLarkCliRuntime({ desktopPnpm, profileDir, version = LARK_CLI_VERSION }) {
  if (!desktopPnpm?.run || !profileDir) throw new TypeError('desktopPnpm and profileDir are required');
  const target = `@larksuite/cli@${version}`;
  let active = null;
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
    const ext = process.platform === 'win32' ? '.exe' : '';
    try {
      return statSync(join(profileDir, 'node_modules', '@larksuite', 'cli', 'bin', `lark-cli${ext}`)).isFile();
    } catch {
      return false;
    }
  };

  const enqueue = (task) => {
    const result = tail.then(task, task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const runPnpm = (args, { timeoutMs = 20000 } = {}) => enqueue(async () => {
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

  const runCli = (args, { cwd = profileDir, timeoutMs = 20000 } = {}) => enqueue(() => new Promise((resolve) => {
    if (disposed) {
      resolve({ ok: false, error: 'Desktop generation disposed' });
      return;
    }
    const bin = join(profileDir, 'node_modules', '@larksuite', 'cli', 'bin', `lark-cli${process.platform === 'win32' ? '.exe' : ''}`);
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

  const runtime = {
    kind: 'desktop',
    available,
    installing: () => Boolean(installing),
    run: runCli,
    install() {
      if (available()) return Promise.resolve({ ok: true, already: true, target });
      if (installing) return installing;
      installing = (async () => {
        const repaired = repairAllowBuildsPlaceholder(profileDir);
        const result = await runPnpm(['add', '--save-exact', target], { timeoutMs: 300000 });
        // add 完成但二进制不在（postinstall 被 pnpm 忽略/占位符拦截）时补 install。
        if (result.ok && !binReady()) {
          await runPnpm(['install'], { timeoutMs: 300000 });
        }
        return { ...result, target, ...(repaired ? { repairedAllowBuilds: true } : {}) };
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
      await active?.done.catch(() => {});
      await tail.catch(() => {});
    },
  };
  return runtime;
}
