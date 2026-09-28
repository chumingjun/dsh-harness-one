// config init（首次创建飞书应用）链路单测。
//
// 三个用例都对应真机踩过的坑，改动请配合实测：
//   1. URL 走 stderr 而非 stdout —— 只监听 stdout 会永远抓不到，界面永远空白
//   2. Windows 输出 CRLF —— 不 trim 会把 \r 带进 <a href>
//   3. 输出分块方式随版本/平台可能变 —— 必须跨 chunk 累积匹配
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopLarkCliRuntime, formatCliError, larkAuthStatus, larkConfigInit, larkLoginStart } from '../lib/lark-auth.js';

const URL = 'https://open.feishu.cn/page/cli?user_code=AX79-5ARL&lpv=1.0.96&ocv=1.0.96&from=cli';
const QR = '█'.repeat(8);

const OK_STATUS = '{"ok":true,"appId":"cli_app","defaultAs":"user","identities":{"user":{"available":false,"status":"none"},"bot":{"status":"unknown"}}}';
const NOT_CONFIGURED_STATUS = '{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured","hint":"run lark-cli config init --new"}}';

/** 写一个假 lark-cli：按 initMode 决定 config init 的输出形态 */
function writeFakeCli(dir, { initMode = 'stderr-once', statusJson = OK_STATUS } = {}) {
  // runtime 从 profileDir/node_modules/@larksuite/cli/bin/lark-cli 取二进制
  const binDir = join(dir, 'node_modules', '@larksuite', 'cli', 'bin');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'lark-cli');
  const initBody = {
    // 真机形态：二维码 + URL + 等待提示 一起 flush 到 stderr
    'stderr-once': `printf '%s\\n\\n%s\\n\\n%s\\n' '${QR}' '${URL}' '等待配置应用...' >&2\nexit 0\n`,
    // Windows 形态：CRLF 行尾
    crlf: `printf '${QR}\\r\\n\\r\\n${URL}\\r\\n' >&2\nexit 0\n`,
    // 分块形态：URL 被拆成两段写，中间有延迟
    split: `printf '%s' '${QR}\\nhttps://open.feishu.cn/page/cli?user_' >&2\nsleep 0.15\nprintf '%s\\n' 'code=SPL-1T2X&lpv=1.0.96' >&2\nexit 0\n`,
    // 永远不给 URL，一直阻塞（模拟网络不通）
    silent: `printf '%s\\n' '${QR}' >&2\nsleep 30\nexit 0\n`,
    // 直接失败退出
    fail: `printf '%s\\n' 'config init failed: agent workspace' >&2\nexit 3\n`,
    // 先给 URL，稍后自然退出（模拟用户在浏览器完成了更换，向导进程结束）
    'switch-done': `printf '%s\\n' '${URL}' >&2\nsleep 0.3\nexit 0\n`,
  }[initMode];
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "init" ]; then
  # 记录完整参数，供「更换应用不带 --new」断言
  printf '%s\\n' "config init $*" >> '${join(dir, 'init-args.log')}'
${initBody}
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s' '${statusJson}'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  printf '%s' '{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured","hint":"run lark-cli config init --new"}}'
  exit 1
fi
exit 0
`);
  chmodSync(bin, 0o755);
  return bin;
}

async function withProfile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1-init-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { '@larksuite/cli': '1.0.96' } }));
    writeFakeCli(dir, fn.opts || {});
    const runtime = createDesktopLarkCliRuntime({
      profileDir: dir,
      desktopPnpm: { run: () => { throw new Error('pnpm should not run'); } },
    });
    return await fn.run(runtime, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  // 1) URL 在 stderr，且与二维码同块吐出 —— 必须抓得到
  await withProfile({
    opts: { initMode: 'stderr-once' },
    async run(runtime, dir) {
      const r = await larkConfigInit({ runtime });
      assert.equal(r.ok, true, 'URL 走 stderr 也必须抓到');
      assert.equal(r.verificationUrl, URL);
      assert.ok(!r.verificationUrl.includes('\r'), 'URL 不应含 CR');
      r.cancel?.();
      await runtime.dispose();
    },
  });

  // 2) CRLF（Windows）行尾 —— trim 掉尾部 \r
  await withProfile({
    opts: { initMode: 'crlf' },
    async run(runtime, dir) {
      const r = await larkConfigInit({ runtime });
      assert.equal(r.ok, true);
      assert.equal(r.verificationUrl, URL, 'CRLF 下 URL 必须干净');
      assert.ok(!/[\r\n]/.test(r.verificationUrl), 'URL 不得残留换行');
      r.cancel?.();
      await runtime.dispose();
    },
  });

  // 3) URL 跨 chunk 分片 —— 累积缓冲后仍能还原完整 URL
  await withProfile({
    opts: { initMode: 'split' },
    async run(runtime, dir) {
      const r = await larkConfigInit({ runtime });
      assert.equal(r.ok, true, 'URL 被拆成两块也应拼回');
      assert.equal(r.verificationUrl, 'https://open.feishu.cn/page/cli?user_code=SPL-1T2X&lpv=1.0.96');
      r.cancel?.();
      await runtime.dispose();
    },
  });

  // 4) 一直没 URL —— 超时后必须清理子进程，不能泄漏
  await withProfile({
    opts: { initMode: 'silent' },
    async run(runtime, dir) {
      const t0 = Date.now();
      const r = await larkConfigInit({ runtime, timeoutMs: 800 });
      assert.equal(r.ok, false);
      assert.match(r.error, /超时|未获取到/);
      assert.ok(Date.now() - t0 < 5000, '超时必须按时返回');
      await runtime.dispose();
    },
  });

  // 5) init 直接失败退出 —— 报可读中文错误
  await withProfile({
    opts: { initMode: 'fail' },
    async run(runtime, dir) {
      const r = await larkConfigInit({ runtime });
      assert.equal(r.ok, false);
      assert.match(r.error, /退出码 3/);
      await runtime.dispose();
    },
  });

  // 6) init 阻塞期间 status 轮询不能被堵死（init 刻意不入 enqueue 队列）
  await withProfile({
    opts: { initMode: 'silent' },
    async run(runtime, dir) {
      const init = larkConfigInit({ runtime, timeoutMs: 3000 });
      const st = await larkAuthStatus(runtime);
      assert.equal(st.configured, true, 'init 阻塞时 status 仍应立即返回');
      (await init).cancel?.();
      await runtime.dispose();
    },
  });

  // 7) 未配置应用的状态：configured=false，而不是笼统的「已安装待登录」
  await withProfile({
    opts: { statusJson: NOT_CONFIGURED_STATUS },
    async run(runtime, dir) {
      const st = await larkAuthStatus(runtime);
      assert.equal(st.installed, true);
      assert.equal(st.configured, false, '未绑定应用必须报 configured=false');
      assert.match(st.error, /config init/, '错误应带官方 hint 指引');

      const start = await larkLoginStart({ runtime });
      assert.equal(start.ok, false);
      assert.equal(start.needsInit, true, '登录前应提示需要先建应用');
      assert.match(start.error, /尚未配置飞书应用/);
      await runtime.dispose();
    },
  });

  // 8) dispose 必须杀掉还在阻塞的 init 子进程
  await withProfile({
    opts: { initMode: 'silent' },
    async run(runtime, dir) {
      larkConfigInit({ runtime, timeoutMs: 5000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      await runtime.dispose();
      await new Promise((r) => setTimeout(r, 100));
    },
  });

  // 9) 更换应用：switch 模式不带 --new（CLI 走选择/绑定已有应用路径），URL 同样从 stderr 抓取
  await withProfile({
    opts: { initMode: 'stderr-once' },
    async run(runtime, dir) {
      const r = await larkConfigInit({ runtime, switchApp: true });
      assert.equal(r.ok, true, 'switch 模式也必须抓到 URL');
      assert.equal(r.verificationUrl, URL);
      await runtime.dispose();
      const logged = readFileSync(join(dir, 'init-args.log'), 'utf8');
      assert.ok(!/--new/.test(logged), 'switch 模式不得带 --new（否则只会创建新应用）');
    },
  });

  // 10) 更换完成信号：URL 抓到后向导进程自然退出（用户在浏览器确认），onDone 必须触发；
  //     用户可能重选同一个应用（appId 不变），完成只能靠进程退出判定
  await withProfile({
    opts: { initMode: 'switch-done' },
    async run(runtime) {
      let done = false;
      const r = await larkConfigInit({ runtime, switchApp: true, onDone: () => { done = true; } });
      assert.equal(r.ok, true, 'switch-done 模式必须先抓到 URL');
      await new Promise((w) => setTimeout(w, 600)); // 等向导退出（sleep 0.3 后 exit 0）
      assert.equal(done, true, '向导自然退出必须触发 onDone（换同一应用也要算完成）');
      await runtime.dispose();
    },
  });

  // formatCliError 优先级
  assert.equal(formatCliError({ message: 'not configured', hint: 'run init' }), 'run init');
  assert.equal(formatCliError({ message: 'boom' }), 'boom');
  assert.equal(formatCliError('plain'), 'plain');
  assert.equal(formatCliError(null, 'fb'), 'fb');

  console.log('lark config init: ok');
} finally {
  // noop
}
