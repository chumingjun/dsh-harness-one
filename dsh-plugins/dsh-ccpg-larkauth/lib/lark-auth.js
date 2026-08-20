// lark-cli 授权集成：Device Flow 登录（--no-wait 发起 → 用户扫码 → --device-code 轮询完成）。
// 只包装官方 CLI 子进程，不碰 ~/.lark-cli/config.json 与 keychain；status 摘要供前端展示。

import { spawn } from 'node:child_process';
import { statSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  join(homedir(), '.local', 'npm-global', 'bin', 'lark-cli'),
  '/usr/local/bin/lark-cli',
  '/opt/homebrew/bin/lark-cli',
];

export function larkCliBin() {
  return CANDIDATES.find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) || null;
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

/** 授权状态摘要：installed / appId / user{userName,openId,tokenStatus,expiresAt} / bot{status} */
export async function larkAuthStatus() {
  if (!larkCliAvailable()) return { installed: false };
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
