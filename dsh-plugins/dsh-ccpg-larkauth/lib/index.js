// dsh-ccpg-larkauth：飞书账号授权独立插件。
// 包装官方 lark-cli 的 Device Flow 登录，让用户在画布 ⚙ 设置里扫码完成飞书授权，
// 授权后 agent 经 lark-cli 默认以用户身份（--as user）操作飞书。
// 端点挂 /wf1/api/lark-auth（GET 状态 / POST {action}）：
//   action=start   发起设备流 → {verificationUrl,userCode,deviceCode,expiresIn}
//   action=qrcode  {verificationUrl} → PNG dataURL
//   action=poll    {deviceCode} → 阻塞至用户扫码完成（≤60s），返回新状态
//   action=logout  清除本机 token
// 插件不落任何凭据文件：token 由 lark-cli 自己管（~/.lark-cli + keychain）。

import z from '@deepseek-ai/schemastery';
import {
  larkCliAvailable, larkAuthStatus, larkLoginStart, larkLoginQrcode, larkLoginPoll, larkLogout,
} from './lark-auth.js';

export const name = 'dsh-ccpg-larkauth';
export const inject = ['webServer'];

export const Config = z.object({});

export function apply(ctx, _config) {
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
    if (!larkCliAvailable()) {
      return json(res, 200, { ok: false, error: '本机未安装 lark-cli（npm i -g @larksuite/cli）' });
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
      case 'logout':
        return json(res, 200, await larkLogout());
      default:
        return json(res, 400, { error: 'action 必须 start|qrcode|poll|logout' });
    }
  } });

  ctx.logger?.info?.('dsh-ccpg-larkauth: /wf1/api/lark-auth 已注册');
}
