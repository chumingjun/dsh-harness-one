import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDesktopLarkCliRuntime,
  LARK_CLI_VERSION,
  larkAuthStatus,
  larkLoginQrcode,
  larkLoginStart,
  profileContextOf,
} from '../lib/lark-auth.js';

const PLACEHOLDER_YAML = `packages:\n  - .\n\nallowBuilds:\n  '@larksuite/cli': set this to true or false\n`;
const FALSE_YAML = `packages:\n  - .\n\nallowBuilds:\n  '@larksuite/cli': false\n`;

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

const FAKE_CLI = `#!/bin/sh
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
`;

function writeProfileCli(profileDir) {
  const bin = join(profileDir, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli');
  mkdirSync(join(bin, '..'), { recursive: true });
  writeFileSync(bin, FAKE_CLI);
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

  // pnpm 拦截 CLI postinstall（yaml 写成占位符或 false）：修复 profile 配置并让 install 下载二进制。
  for (const blockedYaml of [PLACEHOLDER_YAML, FALSE_YAML]) {
    const healDir = mkdtempSync(join(tmpdir(), 'wf1-desktop-heal-'));
    try {
      writeFileSync(join(healDir, 'package.json'), JSON.stringify({ name: 'heal', dependencies: { '@larksuite/cli': LARK_CLI_VERSION } }));
      writeFileSync(join(healDir, 'pnpm-workspace.yaml'), blockedYaml);
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
  }

  // add/install 都“成功”但二进制始终未落盘：返回明确中文错误，而不是让 available()
  // 永远 false、所有授权动作笼统报「本机未安装 lark-cli」。
  const stuckDir = mkdtempSync(join(tmpdir(), 'wf1-desktop-stuck-'));
  try {
    const stuckPkg = join(stuckDir, 'package.json');
    writeFileSync(stuckPkg, JSON.stringify({ name: 'stuck', dependencies: {} }));
    writeFileSync(join(stuckDir, 'pnpm-workspace.yaml'), FALSE_YAML);
    let stuckRuns = 0;
    const stuck = createDesktopLarkCliRuntime({
      profileDir: stuckDir,
      desktopPnpm: { run(args) {
        stuckRuns += 1;
        if (args[0] === 'add') {
          const pkg = JSON.parse(readFileSync(stuckPkg, 'utf8'));
          pkg.dependencies['@larksuite/cli'] = LARK_CLI_VERSION;
          writeFileSync(stuckPkg, JSON.stringify(pkg));
        }
        return completedHandle(); // pnpm 一切正常，但二进制从未出现
      } },
    });
    const stuckResult = await stuck.install();
    assert.equal(stuckResult.ok, false);
    assert.match(stuckResult.error, /二进制下载失败（构建许可或网络）/);
    assert.equal(stuckRuns, 2, 'add 成功但二进制缺失时应补跑一次 install');
    assert.equal(stuck.available(), false);
    assert.match(readFileSync(join(stuckDir, 'pnpm-workspace.yaml'), 'utf8'), /'@larksuite\/cli': true/);
    await stuck.dispose();
  } finally {
    rmSync(stuckDir, { recursive: true, force: true });
  }

  console.log('desktop lark runtime: ok');
} finally {
  rmSync(profileDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 官方 Electron 壳：没有 desktopPnpm，只有内核 profileContext 里的包管理器调用。
// 这一条路上「已装却报未装」的历史故障就是漏了这条路（GUI 进程 PATH 上没有 npm，
// 探测面也从不看 profile 目录）。
// ---------------------------------------------------------------------------
{
  const hostDir = mkdtempSync(join(tmpdir(), 'wf1-official-host-'));
  const binTemplate = join(hostDir, 'lark-cli.template');
  const fakePnpm = join(hostDir, 'pnpm.mjs');
  writeFileSync(binTemplate, FAKE_CLI);
  writeFileSync(fakePnpm, `import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const profile = process.env.WF1_FAKE_PROFILE;
if (!profile) { console.error('宿主调用没有带上 profile 目录'); process.exit(2); }
if (process.env.CI !== 'true') { console.error('宿主调用没有强制 CI'); process.exit(3); }
if (!process.env.WF1_FAKE_PATH_PREFIX) { console.error('宿主自带的 Node 目录没有进 PATH'); process.exit(4); }
const [command, ...rest] = process.argv.slice(2);
writeFileSync(join(profile, 'pnpm-calls.log'), command + ' ' + rest.join(' ') + '\\n', { flag: 'a' });
if (process.env.WF1_FAKE_FAIL === '1') { console.error('network unreachable'); process.exit(1); }
if (command === 'add') {
  const manifest = join(profile, 'package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  pkg.dependencies['@larksuite/cli'] = rest[rest.length - 1].split('@').pop();
  writeFileSync(manifest, JSON.stringify(pkg));
  const bin = join(profile, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli');
  mkdirSync(join(bin, '..'), { recursive: true });
  copyFileSync(process.env.WF1_FAKE_BIN, bin);
  chmodSync(bin, 0o755);
}
`);
  try {
    const dir = join(hostDir, 'profile');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'desktop', dependencies: {} }));
    const packageManager = {
      command: process.execPath,
      args: [fakePnpm],
      env: { WF1_FAKE_PROFILE: dir, WF1_FAKE_BIN: binTemplate, WF1_FAKE_PATH_PREFIX: hostDir, PATH: hostDir },
    };

    const runtime = createDesktopLarkCliRuntime({ profileDir: dir, packageManager });
    assert.equal(runtime.kind, 'desktop', '官方壳仍走 Desktop 分支，前端文案与装包提示才对得上');
    assert.equal(runtime.available(), false, 'profile 里没装就是没装');
    assert.equal((await runtime.install()).ok, true);
    assert.equal(
      readFileSync(join(dir, 'pnpm-calls.log'), 'utf8').trim(),
      `add --save-exact @larksuite/cli@${LARK_CLI_VERSION}`,
    );
    assert.equal(runtime.available(), true, '装完必须立刻认得出 profile 里的二进制');

    // 授权动作一律直连 profile 内的二进制，不经包管理器
    const status = await larkAuthStatus(runtime);
    assert.equal(status.installed, true);
    assert.equal(status.runtime, 'desktop');
    assert.equal(status.user.tokenStatus, 'valid');
    assert.equal(readFileSync(join(dir, 'pnpm-calls.log'), 'utf8').trim().split('\n').length, 1);

    // profile 声明了依赖、二进制却不在：CLI 直连路径要报出真实原因，不是笼统的「未安装」
    const failDir = join(hostDir, 'broken');
    mkdirSync(failDir, { recursive: true });
    writeFileSync(join(failDir, 'package.json'), JSON.stringify({
      name: 'broken', dependencies: { '@larksuite/cli': LARK_CLI_VERSION },
    }));
    const broken = createDesktopLarkCliRuntime({
      profileDir: failDir,
      packageManager: { ...packageManager, env: { ...packageManager.env, WF1_FAKE_PROFILE: failDir } },
    });
    assert.equal(broken.available(), false);
    const missing = await broken.run(['auth', 'status', '--json']);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /ENOENT/);

    // 宿主包管理器装不上：说清是二进制没落盘，并把退出码带出来，不能只留一个「未安装」
    const neverDir = join(hostDir, 'never');
    mkdirSync(neverDir, { recursive: true });
    writeFileSync(join(neverDir, 'package.json'), JSON.stringify({ name: 'never', dependencies: {} }));
    const failing = createDesktopLarkCliRuntime({
      profileDir: neverDir,
      packageManager: { ...packageManager, env: { ...packageManager.env, WF1_FAKE_PROFILE: neverDir, WF1_FAKE_FAIL: '1' } },
    });
    const failed = await failing.install();
    assert.equal(failed.ok, false);
    assert.match(failed.error, /二进制下载失败（构建许可或网络）/);
    assert.match(failed.error, /exit=1/);
    await failing.dispose();
    await broken.dispose();
    await runtime.dispose();

    // 两条装包通道都没有：构造期就拒，不给「看起来能装其实装不了」的 runtime
    assert.throws(() => createDesktopLarkCliRuntime({ profileDir: dir }), /desktopPnpm or packageManager/);
    assert.throws(() => createDesktopLarkCliRuntime({ packageManager }), /profileDir/);
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
  }
}

// profileContext 的逐字段校验：缺一即弃，半截的调用跑不起来
{
  assert.equal(profileContextOf(undefined), null);
  assert.equal(profileContextOf({}), null);
  assert.equal(profileContextOf({ dir: 'relative/path' }), null, '相对路径不能当 profile 目录');
  assert.equal(profileContextOf({ dir: '/tmp/p' }).packageManager, null, '没发布包管理器 ≠ 有一个坏的');
  const full = profileContextOf({
    name: 'desktop',
    dir: '/tmp/p',
    packageManager: { command: '/host/node', args: ['--expose-internals', '/host/pnpm.mjs'], env: { CI: '1', N: 7 } },
  });
  assert.equal(full.name, 'desktop');
  assert.deepEqual(full.packageManager.args, ['--expose-internals', '/host/pnpm.mjs']);
  assert.deepEqual(full.packageManager.env, { CI: '1' }, '非字符串环境值必须丢掉，而不是原样丢给 spawn');
  assert.equal(profileContextOf({ dir: '/tmp/p', packageManager: { command: '', args: [] } }).packageManager, null);
  assert.equal(profileContextOf({ dir: '/tmp/p', packageManager: { command: '/host/node', args: [1] } }).packageManager, null);
  assert.equal(profileContextOf({ dir: '/tmp/p', packageManager: { command: '/host/node', args: [] } }).packageManager.command, '/host/node');
}

console.log('official desktop lark runtime: ok');
