// lark-cli 授权集成：Device Flow 登录（--no-wait 发起 → 用户扫码 → --device-code 轮询完成）。
// 只包装官方 CLI 子进程，不碰 ~/.lark-cli/config.json 与 keychain；status 摘要供前端展示。
// 另含四块自维护能力，让 dsh 开箱即用：
//   1) ensureLarkCli        未安装时自动 npm 全局安装到 ~/.local/npm-global
//   2) setDefaultIdentityUser  默认身份固定为 user（config default-as user）
//   3) renewUserToken       后台定时触发 uat-client 刷新（refresh_token 轮换=授权永久续期）
//   4) ensureSkillFiles     feishu-cli 技能种子到 ~/.dsh/skills 与 workflow-one-skills

import { spawn, spawnSync } from 'node:child_process';
import { statSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_GLOBAL = join(homedir(), '.local', 'npm-global');

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

export function larkCliAvailable() {
  return Boolean(larkCliBin());
}

function run(args, { timeoutMs = 20000 } = {}) {
  const bin = larkCliBin();
  if (!bin) return Promise.resolve({ ok: false, error: 'lark-cli not installed' });
  return new Promise((resolve) => {
    const child = spawn(bin, args, { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    child.on('close', (code) => {
      const text = (out || err || '').trim();
      try {
        const parsed = JSON.parse(text);
        resolve(parsed.ok !== undefined ? parsed : { ok: code === 0, ...parsed });
      } catch {
        resolve({ ok: code === 0, raw: text.slice(0, 2000) });
      }
    });
  });
}

/** 授权状态摘要：installed / installing / appId / defaultIdentity / user{...} / bot{status} / autoRenew{...} */
export async function larkAuthStatus() {
  if (!larkCliAvailable()) return { installed: false, installing: larkCliInstalling() };
  const res = await run(['auth', 'status', '--json'], { timeoutMs: 15000 });
  if (!res.ok && !res.appId) return { installed: true, error: res.error || res.raw || 'auth status 失败' };
  const user = res.identities?.user || {};
  const bot = res.identities?.bot || {};
  return {
    installed: true,
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
export async function larkLoginStart({ recommend = true, domain } = {}) {
  const args = ['auth', 'login', '--no-wait', '--json'];
  if (recommend) args.push('--recommend');
  if (domain) args.push('--domain', String(domain));
  const res = await run(args, { timeoutMs: 20000 });
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
export async function larkLoginQrcode(verificationUrl) {
  if (!larkCliAvailable()) return { ok: false, error: 'lark-cli not installed' };
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
export async function larkLoginPoll(deviceCode) {
  const res = await run(['auth', 'login', '--device-code', String(deviceCode), '--json'], { timeoutMs: 60000 });
  if (res.ok) {
    await setDefaultIdentityUser(); // 授权成功即固定默认身份为 user
    const status = await larkAuthStatus();
    return { ok: true, status };
  }
  return { ok: false, error: res.error?.message || res.error || res.raw || '授权未完成' };
}

/** 退出登录（清 token） */
export async function larkLogout() {
  const res = await run(['auth', 'logout', '--json'], { timeoutMs: 20000 });
  return { ok: Boolean(res.ok), error: res.error?.message || res.error };
}

// ---------- 自动安装 ----------

let _installing = null; // 进行中的安装 Promise（防并发）
export function larkCliInstalling() { return Boolean(_installing); }

/** 未安装时自动 npm 全局安装到 ~/.local/npm-global（bin 落在 CANDIDATES[0]） */
export function ensureLarkCli() {
  if (larkCliAvailable()) return Promise.resolve({ ok: true, already: true, bin: larkCliBin() });
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
export async function setDefaultIdentityUser() {
  if (!larkCliAvailable()) return { ok: false, error: 'lark-cli not installed' };
  const res = await run(['config', 'default-as', 'user'], { timeoutMs: 15000 });
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
export async function renewUserToken({ force = false } = {}) {
  if (!larkCliAvailable()) return { ok: false, skipped: 'not-installed' };
  if (_renew.running) return { ok: true, skipped: 'running' };
  _renew.running = true;
  try {
    const st = await run(['auth', 'status', '--json'], { timeoutMs: 15000 });
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
    const call = await run(['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user'], { timeoutMs: 30000 });
    const after = await run(['auth', 'status', '--json'], { timeoutMs: 15000 });
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
 * 把 feishu-cli 技能种子到 dsh 的技能发现根：
 *   ~/.dsh/skills/            官方 UI 聊天 agent 与所有 preset 的全局根
 *   ~/.dsh/workflow-one-skills/  画布 agent 节点的技能索引目录
 * 另：~/.agents/skills 缺官方 lark-* 技能时后台 npx skills add 补齐（best-effort，不阻塞）。
 */
export function ensureSkillFiles({ log } = {}) {
  const written = [];
  const dirs = [join(homedir(), '.dsh', 'skills')];
  dirs.push(process.env.WF1_SKILLS_DIR || join(homedir(), '.dsh', 'workflow-one-skills'));
  for (const dir of dirs) {
    try {
      const w = seedSkillFile(dir);
      if (w) { written.push(w); log?.(`技能已种子: ${w}`); }
    } catch (e) { log?.(`技能种子失败 ${dir}: ${e.message || e}`); }
  }
  // 官方 lark-* 技能（lark-doc/lark-im/lark-base 等）：装到 ~/.agents/skills，dsh 同为发现根
  const agentsSkills = join(homedir(), '.agents', 'skills');
  if (!existsSync(join(agentsSkills, 'lark-shared'))) {
    const child = spawn('npx', ['-y', 'skills', 'add', 'larksuite/cli', '-g', '-y'], { timeout: 300000 });
    child.on('error', (e) => log?.(`官方 lark 技能安装跳过：${e.message || e}`));
    child.on('close', (code) => log?.(code === 0 ? '官方 lark-* 技能已安装到 ~/.agents/skills' : `官方 lark 技能安装退出码 ${code}`));
  }
  return written;
}
