import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDesktopLarkCliRuntime,
  LARK_CLI_VERSION,
  larkAuthStatus,
  larkLoginQrcode,
} from '../lib/lark-auth.js';

const PLACEHOLDER_YAML = `packages:\n  - .\n\nallowBuilds:\n  '@larksuite/cli': set this to true or false\n`;

function completedHandle({ stdout = '', stderr = '', exitCode = 0, signal = null, beforeDone } = {}) {
  const out = new PassThrough();
  const err = new PassThrough();
  const done = Promise.resolve().then(() => {
    beforeDone?.();
    if (stdout) out.write(stdout);
    if (stderr) err.write(stderr);
    out.end();
    err.end();
    return { exitCode, signal };
  });
  return { stdout: out, stderr: err, done, cancel() {} };
}

const profileDir = mkdtempSync(join(tmpdir(), 'wf1-desktop-lark-'));
const packageFile = join(profileDir, 'package.json');
writeFileSync(packageFile, JSON.stringify({ name: 'desktop-profile', dependencies: {} }));

try {
  const calls = [];
  const desktopPnpm = {
    run(args, signal) {
      calls.push({ args, signal });
      if (args[0] === 'add') {
        return completedHandle({ beforeDone() {
          const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
          pkg.dependencies['@larksuite/cli'] = LARK_CLI_VERSION;
          writeFileSync(packageFile, JSON.stringify(pkg));
        } });
      }
      if (args.includes('qrcode')) {
        const output = args[args.indexOf('--output') + 1];
        writeFileSync(join(profileDir, output), Buffer.from('png'));
        return completedHandle();
      }
      return completedHandle({ stdout: JSON.stringify({
        ok: true,
        appId: 'cli_app',
        defaultAs: 'user',
        identities: { user: { available: true, tokenStatus: 'valid' }, bot: { status: 'ready' } },
      }) });
    },
  };

  const runtime = createDesktopLarkCliRuntime({ desktopPnpm, profileDir });
  assert.equal(runtime.available(), false);
  assert.equal((await runtime.install()).ok, true);
  assert.deepEqual(calls[0].args, ['add', '--save-exact', `@larksuite/cli@${LARK_CLI_VERSION}`]);
  assert.equal(runtime.available(), true);

  const status = await larkAuthStatus(runtime);
  assert.equal(status.user.tokenStatus, 'valid');
  assert.deepEqual(calls[1].args.slice(0, 4), ['exec', 'lark-cli', 'auth', 'status']);

  const qr = await larkLoginQrcode('https://example.com/device', runtime);
  assert.equal(qr.dataUrl, 'data:image/png;base64,cG5n');
  const output = calls[2].args[calls[2].args.indexOf('--output') + 1];
  assert.throws(() => readFileSync(join(profileDir, output)), /ENOENT/);
  await runtime.dispose();

  const failed = createDesktopLarkCliRuntime({
    profileDir,
    desktopPnpm: { run: () => completedHandle({ stderr: 'bad', exitCode: 7 }) },
  });
  const failure = await failed.run(['auth', 'status']);
  assert.equal(failure.ok, false);
  assert.match(failure.error, /exit=7/);
  await failed.dispose();

  let cancelled = false;
  let finish;
  const pending = createDesktopLarkCliRuntime({
    profileDir,
    desktopPnpm: { run() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        stdout,
        stderr,
        done: new Promise((resolve) => { finish = resolve; }),
        cancel() { cancelled = true; finish({ exitCode: null, signal: 'SIGTERM' }); },
      };
    } },
  });
  const running = pending.run(['auth', 'status']);
  await new Promise((resolve) => setImmediate(resolve));
  await pending.dispose();
  assert.equal(cancelled, true);
  assert.equal((await running).ok, false);

  // pnpm 忽略构建时写入的占位符：exec 失败 → 修复 allowBuilds → 补 install → 重试成功
  const healDir = mkdtempSync(join(tmpdir(), 'wf1-desktop-heal-'));
  try {
    writeFileSync(join(healDir, 'package.json'), JSON.stringify({ name: 'heal', dependencies: { '@larksuite/cli': LARK_CLI_VERSION } }));
    writeFileSync(join(healDir, 'pnpm-workspace.yaml'), PLACEHOLDER_YAML);
    const binPath = join(healDir, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli');
    let installRuns = 0;
    const healed = createDesktopLarkCliRuntime({
      profileDir: healDir,
      desktopPnpm: { run(args) {
        if (args[0] === 'install') {
          installRuns += 1;
          mkdirSync(join(binPath, '..'), { recursive: true });
          writeFileSync(binPath, 'bin');
          return completedHandle();
        }
        if (args[0] === 'exec' && !existsSync(binPath)) return completedHandle({ exitCode: 1 });
        return completedHandle({ stdout: JSON.stringify({ ok: true, appId: 'heal' }) });
      } },
    });
    const status = await larkAuthStatus(healed);
    assert.equal(status.installed, true);
    assert.equal(status.appId, 'heal');
    assert.equal(installRuns, 1);
    assert.match(readFileSync(join(healDir, 'pnpm-workspace.yaml'), 'utf8'), /'@larksuite\/cli': true/);
    await healed.dispose();
  } finally {
    rmSync(healDir, { recursive: true, force: true });
  }

  console.log('desktop lark runtime: ok');
} finally {
  rmSync(profileDir, { recursive: true, force: true });
}
