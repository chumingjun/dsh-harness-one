import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDesktopLarkCliRuntime,
  LARK_CLI_VERSION,
  larkAuthStatus,
  larkLoginQrcode,
  larkLoginStart,
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

function writeProfileCli(profileDir) {
  const bin = join(profileDir, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli');
  mkdirSync(join(bin, '..'), { recursive: true });
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "qrcode" ]; then
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--output" ]; then printf 'png' > "$arg"; fi
    previous="$arg"
  done
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  printf '%s' '{"verification_url":"https://example.com/device","device_code":"device","expires_in":600}'
  exit 0
fi
if [ "$1" = "fail" ]; then echo 'bad' >&2; exit 7; fi
if [ "$1" = "wait" ]; then sleep 30; exit 0; fi
printf '%s' '{"ok":true,"appId":"cli_app","defaultAs":"user","identities":{"user":{"available":true,"tokenStatus":"valid"},"bot":{"status":"ready"}}}'
`);
  chmodSync(bin, 0o755);
  return bin;
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
          writeProfileCli(profileDir);
        } });
      }
      return completedHandle();
    },
  };

  const runtime = createDesktopLarkCliRuntime({ desktopPnpm, profileDir });
  assert.equal(runtime.available(), false);
  assert.equal((await runtime.install()).ok, true);
  assert.deepEqual(calls[0].args, ['add', '--save-exact', `@larksuite/cli@${LARK_CLI_VERSION}`]);
  assert.equal(runtime.available(), true);

  const status = await larkAuthStatus(runtime);
  assert.equal(status.user.tokenStatus, 'valid');
  assert.equal(calls.length, 1, 'runtime status must bypass desktopPnpm');

  const start = await larkLoginStart({ runtime });
  assert.equal(start.ok, true);
  assert.equal(start.deviceCode, 'device');
  assert.equal(calls.length, 1, 'runtime login must bypass desktopPnpm');

  const qr = await larkLoginQrcode('https://example.com/device', runtime);
  assert.equal(qr.dataUrl, 'data:image/png;base64,cG5n');
  assert.equal(calls.length, 1, 'runtime qrcode must bypass desktopPnpm');
  assert.equal(existsSync(join(profileDir, '.dsh-ccpg-larkauth-qr-does-not-exist.png')), false);
  await runtime.dispose();

  const failed = createDesktopLarkCliRuntime({ profileDir, desktopPnpm: { run: () => { throw new Error('pnpm should not run'); } } });
  const failure = await failed.run(['fail']);
  assert.equal(failure.ok, false);
  assert.match(failure.error, /exit=7/);
  await failed.dispose();

  const pending = createDesktopLarkCliRuntime({ profileDir, desktopPnpm: { run: () => { throw new Error('pnpm should not run'); } } });
  const running = pending.run(['wait']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await pending.dispose();
  assert.equal((await running).ok, false);

  // pnpm ignores the CLI postinstall: repair the profile config and let install download the binary.
  const healDir = mkdtempSync(join(tmpdir(), 'wf1-desktop-heal-'));
  try {
    writeFileSync(join(healDir, 'package.json'), JSON.stringify({ name: 'heal', dependencies: { '@larksuite/cli': LARK_CLI_VERSION } }));
    writeFileSync(join(healDir, 'pnpm-workspace.yaml'), PLACEHOLDER_YAML);
    let installRuns = 0;
    const healed = createDesktopLarkCliRuntime({
      profileDir: healDir,
      desktopPnpm: { run(args) {
        if (args[0] === 'install') {
          installRuns += 1;
          writeProfileCli(healDir);
        }
        return completedHandle();
      } },
    });
    assert.equal(healed.available(), false);
    assert.equal((await healed.install()).ok, true);
    assert.equal(installRuns, 1);
    assert.equal(healed.available(), true);
    assert.match(readFileSync(join(healDir, 'pnpm-workspace.yaml'), 'utf8'), /'@larksuite\/cli': true/);
    const status = await larkAuthStatus(healed);
    assert.equal(status.appId, 'cli_app');
    await healed.dispose();
  } finally {
    rmSync(healDir, { recursive: true, force: true });
  }

  console.log('desktop lark runtime: ok');
} finally {
  rmSync(profileDir, { recursive: true, force: true });
}
