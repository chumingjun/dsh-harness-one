// dsh-ccpg-larkauth：飞书账号授权独立插件。
// 包装官方 lark-cli 的 Device Flow 登录，让用户在官方 dsh Web UI 设置「飞书账号」里扫码完成授权，
// 授权后 agent 经 lark-cli 默认以用户身份（--as user）操作飞书。
// 端点挂 /wf1/api/lark-auth（GET 状态 / POST {action}）：
//   action=start    发起设备流 → {verificationUrl,userCode,deviceCode,expiresIn}
//   action=qrcode   {verificationUrl} → PNG dataURL
//   action=poll     {deviceCode} → 阻塞至用户扫码完成（≤60s），返回新状态
//   action=logout   清除本机 token
//   action=install  手动触发自动安装 lark-cli（未安装时）
//   action=renew    手动触发一轮 token 续约
// 普通 dsh 使用本机 lark-cli；Desktop 动态使用 desktopPnpm，不依赖系统 npm/node。
// 插件不落任何凭据文件：token 由 lark-cli 自己管（~/.lark-cli + keychain）。

import z from '@deepseek-ai/schemastery';
import {
  larkCliAvailable, larkCliInstalling, larkAuthStatus, larkLoginStart, larkLoginQrcode,
  larkLoginPoll, larkLogout, ensureLarkCli, setDefaultIdentityUser, renewUserToken,
  ensureSkillFiles, createDesktopLarkCliRuntime, RENEW_INTERVAL_MS,
} from './lark-auth.js';

export const name = 'dsh-ccpg-larkauth';
export const inject = ['webServer'];

export const Config = z.object({});

function mount(ctx, runtime, { desktop = false } = {}) {
  const log = (msg) => ctx.logger?.info?.(`[larkauth] ${msg}`);
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
  let first = null;
  let timer = null;
  let disposed = false;

  const startRenewal = async () => {
    if (disposed || timer || !larkCliAvailable(runtime)) return;
    const identity = await setDefaultIdentityUser(runtime);
    log(identity.ok ? '默认身份已固定为 user' : `设置默认身份失败：${identity.error}`);
    if (!identity.ok || disposed) return;
    first = setTimeout(() => {
      renewUserToken({ runtime }).then((result) => log(`token 续约：${JSON.stringify(result)}`));
    }, 15000);
    timer = setInterval(() => {
      renewUserToken({ runtime }).then((result) => { if (!result.skipped) log(`token 续约：${JSON.stringify(result)}`); });
    }, RENEW_INTERVAL_MS);
  };

  ctx.webServer.register({ kind: 'exact', path: '/wf1/api/lark-auth', async handler(req, res) {
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, status: await larkAuthStatus(runtime) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    if (body.action === 'install') {
      const result = await ensureLarkCli(runtime);
      if (result.ok) {
        ensureSkillFiles({ log, installOfficial: !desktop });
        await startRenewal();
      }
      return json(res, 200, { ...result, status: result.ok ? await larkAuthStatus(runtime) : undefined });
    }
    if (!larkCliAvailable(runtime)) {
      const hint = desktop ? '请点「自动安装」添加到当前 Desktop profile' : '可点「自动安装」，或手动 npm i -g @larksuite/cli';
      return json(res, 200, { ok: false, installing: larkCliInstalling(runtime), error: `本机未安装 lark-cli（${hint}）` });
    }
    switch (body.action) {
      case 'start': {
        const r = await larkLoginStart({ recommend: body.recommend !== false, domain: body.domain, runtime });
        return json(res, 200, r);
      }
      case 'qrcode': {
        if (!body.verificationUrl) return json(res, 400, { error: '需要 verificationUrl' });
        return json(res, 200, await larkLoginQrcode(body.verificationUrl, runtime));
      }
      case 'poll': {
        if (!body.deviceCode) return json(res, 400, { error: '需要 deviceCode' });
        return json(res, 200, await larkLoginPoll(body.deviceCode, runtime));
      }
      case 'renew':
        return json(res, 200, await renewUserToken({ force: true, runtime }));
      case 'logout':
        return json(res, 200, await larkLogout(runtime));
      default:
        return json(res, 400, { error: 'action 必须 start|qrcode|poll|logout|install|renew' });
    }
  } });

  try {
    const written = ensureSkillFiles({ log, installOfficial: !desktop });
    if (!written.length) log('feishu-cli 技能已就绪');
  } catch (e) { log(`技能种子失败：${e.message || e}`); }

  ctx.effect(() => {
    (async () => {
      if (desktop && !larkCliAvailable(runtime)) {
        log('Desktop 未安装 lark-cli，等待用户在飞书账号面板确认安装');
        return;
      }
      if (!larkCliAvailable(runtime)) {
        log('未检测到 lark-cli，开始自动安装（npm i -g @larksuite/cli → ~/.local/npm-global）…');
        const result = await ensureLarkCli();
        if (!result.ok) { log(`lark-cli 自动安装失败：${result.error}`); return; }
        log(`lark-cli 安装完成：${result.bin}`);
      }
      await startRenewal();
    })().catch((error) => log(`自举失败：${error.message || error}`));
    return async () => {
      disposed = true;
      clearTimeout(first);
      clearInterval(timer);
      await runtime?.dispose?.();
    };
  }, 'larkauth runtime');

  ctx.logger?.info?.(`dsh-ccpg-larkauth: /wf1/api/lark-auth 已注册（${desktop ? 'Desktop 受管 pnpm' : '普通 dsh'}）`);
}

export function apply(ctx, _config) {
  const profiles = ctx.get?.('desktopProfiles');
  if (profiles === undefined) {
    mount(ctx, null);
    return;
  }
  ctx.inject(['desktopPnpm'], (desktopCtx) => {
    const runtime = createDesktopLarkCliRuntime({
      desktopPnpm: desktopCtx.desktopPnpm,
      profileDir: profiles.current.dir,
    });
    mount(desktopCtx, runtime, { desktop: true });
  });
}
