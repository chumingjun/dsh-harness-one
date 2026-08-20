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
// 启动时自举（不阻塞加载）：
//   1) 未安装 lark-cli → 后台 npm 全局安装到 ~/.local/npm-global
//   2) 默认身份固定为 user（config default-as user）
//   3) feishu-cli 技能种子到 ~/.dsh/skills 与 workflow-one-skills；官方 lark-* 技能缺则 npx 补装
//   4) 后台定时续约 user token（20min 一轮，临期才真正刷新；refresh_token 轮换=授权永久续期）
// 插件不落任何凭据文件：token 由 lark-cli 自己管（~/.lark-cli + keychain）。

import z from '@deepseek-ai/schemastery';
import {
  larkCliAvailable, larkCliInstalling, larkAuthStatus, larkLoginStart, larkLoginQrcode,
  larkLoginPoll, larkLogout, ensureLarkCli, setDefaultIdentityUser, renewUserToken,
  ensureSkillFiles, RENEW_INTERVAL_MS,
} from './lark-auth.js';

export const name = 'dsh-ccpg-larkauth';
export const inject = ['webServer'];

export const Config = z.object({});

export function apply(ctx, _config) {
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

  ctx.webServer.register({ kind: 'exact', path: '/wf1/api/lark-auth', async handler(req, res) {
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, status: await larkAuthStatus() });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req);
    if (body.action === 'install') {
      const r = await ensureLarkCli();
      if (r.ok) { await setDefaultIdentityUser(); ensureSkillFiles({ log }); }
      return json(res, 200, { ...r, status: r.ok ? await larkAuthStatus() : undefined });
    }
    if (!larkCliAvailable()) {
      return json(res, 200, { ok: false, installing: larkCliInstalling(), error: '本机未安装 lark-cli（可点「自动安装」，或手动 npm i -g @larksuite/cli）' });
    }
    switch (body.action) {
      case 'start': {
        const r = await larkLoginStart({ recommend: body.recommend !== false, domain: body.domain });
        return json(res, 200, r);
      }
      case 'qrcode': {
        if (!body.verificationUrl) return json(res, 400, { error: '需要 verificationUrl' });
        return json(res, 200, await larkLoginQrcode(body.verificationUrl));
      }
      case 'poll': {
        if (!body.deviceCode) return json(res, 400, { error: '需要 deviceCode' });
        return json(res, 200, await larkLoginPoll(body.deviceCode));
      }
      case 'renew':
        return json(res, 200, await renewUserToken({ force: true }));
      case 'logout':
        return json(res, 200, await larkLogout());
      default:
        return json(res, 400, { error: 'action 必须 start|qrcode|poll|logout|install|renew' });
    }
  } });

  // ---- 启动自举（异步，不阻塞插件加载）----
  // 技能种子同步先行（文件极小）：无论 lark-cli 是否已装，dsh 都默认带 feishu-cli 技能
  try {
    const written = ensureSkillFiles({ log });
    if (!written.length) log('feishu-cli 技能已就绪');
  } catch (e) { log(`技能种子失败：${e.message || e}`); }

  (async () => {
    if (!larkCliAvailable()) {
      log('未检测到 lark-cli，开始自动安装（npm i -g @larksuite/cli → ~/.local/npm-global）…');
      const r = await ensureLarkCli();
      if (!r.ok) { log(`lark-cli 自动安装失败：${r.error}`); return; }
      log(`lark-cli 安装完成：${r.bin}`);
      ensureSkillFiles({ log }); // 装完补一轮（官方 lark-* 技能需要时已补装）
    }
    const d = await setDefaultIdentityUser();
    log(d.ok ? '默认身份已固定为 user' : `设置默认身份失败：${d.error}`);
    // 首轮续约延迟 15s（避开启动高峰），之后每 20min 一轮
    const first = setTimeout(() => { renewUserToken().then((r) => log(`token 续约：${JSON.stringify(r)}`)); }, 15000);
    const timer = setInterval(() => { renewUserToken().then((r) => { if (!r.skipped) log(`token 续约：${JSON.stringify(r)}`); }); }, RENEW_INTERVAL_MS);
    try { ctx.on?.('dispose', () => { clearTimeout(first); clearInterval(timer); }); } catch { /* 宿主无 dispose 事件 */ }
  })().catch((e) => log(`自举失败：${e.message || e}`));

  ctx.logger?.info?.('dsh-ccpg-larkauth: /wf1/api/lark-auth 已注册（默认身份 user + 自动续约 + 自动安装/技能种子）');
}
