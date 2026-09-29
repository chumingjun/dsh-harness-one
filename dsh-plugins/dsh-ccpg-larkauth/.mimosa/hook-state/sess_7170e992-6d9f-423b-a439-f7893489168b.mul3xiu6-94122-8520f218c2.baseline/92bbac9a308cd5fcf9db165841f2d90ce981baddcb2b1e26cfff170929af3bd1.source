// dsh-ccpg-larkauth：飞书账号授权独立插件。
// 包装官方 lark-cli 的 Device Flow 登录，让用户在官方 dsh Web UI 设置「飞书账号」里扫码完成授权，
// 授权后 agent 经 lark-cli 默认以用户身份（--as user）操作飞书。
// 端点挂 /wf1/api/lark-auth（GET 状态 / POST {action}）：
//   action=start    发起设备流 → {verificationUrl,userCode,deviceCode,expiresIn}
//   action=init     创建/绑定飞书应用（config init）→ {verificationUrl}（应用创建是前置条件）
//                    body.switch=true 为「更换应用」模式：不带 --new，浏览器里可选已有应用
//   action=init-cancel  中止进行中的应用创建
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
  ensureSkillFiles, createDesktopLarkCliRuntime, larkConfigInit, RENEW_INTERVAL_MS,
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
  // 进行中的 config init 子进程句柄（用户在浏览器完成前可随时取消；面板关闭/插件卸载时兜底清理）
  let initCancel = null;
  let initUrl = null;
  // 更换应用完成时刻（向导进程自然退出）：GET status 据此告知前端「已完成，来取新状态」。
  // 不用对比 appId——用户可能重选同一个应用，appId 不变但配置已整体重写
  let initDoneAt = 0;

  const cancelInit = () => {
    if (!initCancel) return false;
    try { initCancel(); } catch { /* 进程可能已退出 */ }
    initCancel = null;
    return true;
  };

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
      const status = await larkAuthStatus(runtime);
      // 应用创建进行中：把已有链接回给前端，关掉面板再打开能接着扫码，不必重新创建
      if (initCancel) return json(res, 200, { ok: true, status: { ...status, initInProgress: true, initUrl } });
      // 向导刚自然退出（用户在浏览器完成更换）：告知前端流程已结束（含换同一应用的情况）。
      // 信号 2 分钟内有效，首个看到它的轮询即收尾；过期视作陈旧历史，不再干扰
      if (initDoneAt && Date.now() - initDoneAt < 120000) {
        return json(res, 200, { ok: true, status: { ...status, initDone: true } });
      }
      return json(res, 200, { ok: true, status });
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
      case 'init': {
        // 已有进行中的流程时默认复用旧链接（防连点建出多个应用）；
        // 但用户显式点「重新获取链接」时必须丢弃旧进程重开，否则链接和二维码不会刷新。
        if (initCancel && !body.refresh) {
          return json(res, 200, { ok: true, verificationUrl: initUrl, inProgress: true });
        }
        cancelInit(); // 丢弃上一次未完成的应用创建（可能残留孤儿进程）
        // switch=true 走「更换应用」：不带 --new，浏览器里可选已有应用而非强制新建
        const r = await larkConfigInit({
          runtime, switchApp: Boolean(body.switch),
          // 用户在浏览器确认后向导进程自然退出：记录完成时刻并清掉「进行中」标记
          // （cancel 句柄留着会让 GET 一直报 initInProgress，完成信号被吞）
          onDone: body.switch
            ? () => { initDoneAt = Date.now(); initUrl = null; initCancel = null; }
            : undefined,
        });
        if (r.ok) { initUrl = r.verificationUrl; initCancel = r.cancel || null; }
        return json(res, 200, r.ok ? { ok: true, verificationUrl: r.verificationUrl } : { ok: false, error: r.error });
      }
      case 'init-cancel': {
        const cancelled = cancelInit();
        initUrl = null;
        initDoneAt = 0; // 用户主动取消：完成信号作废
        return json(res, 200, { ok: true, cancelled });
      }
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
        return json(res, 400, { error: 'action 必须 init|init-cancel|start|qrcode|poll|logout|install|renew' });
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
      cancelInit();
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
