import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'wf1-lark-home-'));
const profileDir = mkdtempSync(join(tmpdir(), 'wf1-lark-profile-'));
const originalHome = process.env.HOME;
process.env.HOME = home;
mkdirSync(join(home, '.agents', 'skills', 'lark-shared'), { recursive: true });
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'desktop', dependencies: {} }));

try {
  const { larkCliBin } = await import('../lib/lark-auth.js');
  const { apply, inject } = await import(`../lib/index.js?test=${Date.now()}`);
  assert.deepEqual(inject, ['webServer']);

  const ordinaryRoutes = [];
  apply({
    get: () => undefined,
    webServer: { register: (route) => ordinaryRoutes.push(route) },
    effect: () => {},
    logger: { info() {} },
  });
  assert.equal(ordinaryRoutes[0].path, '/wf1/api/lark-auth');

  const desktopRoutes = [];
  const requested = [];
  let pnpmCalls = 0;
  const desktopCtx = {
    desktopPnpm: { run() { pnpmCalls += 1; throw new Error('must wait for user action'); } },
    webServer: { register: (route) => desktopRoutes.push(route) },
    effect: () => {},
    logger: { info() {} },
  };
  apply({
    get: (name) => name === 'desktopProfiles' ? { current: { name: 'desktop', dir: profileDir } } : undefined,
    inject(dependencies, callback) {
      requested.push(...dependencies);
      callback(desktopCtx);
    },
  });
  assert.deepEqual(requested, ['desktopPnpm']);
  assert.equal(desktopRoutes[0].path, '/wf1/api/lark-auth');
  assert.equal(pnpmCalls, 0);

  // 官方 Electron 壳：没有 desktopProfiles，也没有 desktopPnpm，只有内核 profileContext。
  // 过去这里会退回普通 dsh 分支——GUI 进程 PATH 上没有 npm，探测面也从不看 profile 目录，
  // 于是 profile 里明明装好的 lark-cli 被判成「未安装」，所有授权动作被挡。
  const officialRoutes = [];
  const officialRequested = [];
  apply({
    get: (name) => (name === 'profileContext' ? {
      name: 'desktop',
      dir: profileDir,
      packageManager: { command: '/host/node', args: ['--expose-internals', '/host/pnpm.mjs'], env: { CI: '1' } },
    } : undefined),
    inject(...dependencies) { officialRequested.push(...dependencies); },
    webServer: { register: (route) => officialRoutes.push(route) },
    effect: () => {},
    logger: { info() {} },
  });
  assert.deepEqual(officialRequested, [], '官方壳里不存在 desktopPnpm，不能去 inject 它');
  assert.equal(officialRoutes[0].path, '/wf1/api/lark-auth');

  // 同理，profileContext 有目录但没发布包管理器 = 普通 dsh：装包仍走 npm -g，
  // 但探测面必须认得 profile 目录（否则装在 profile 里的 lark-cli 会被判成未安装）。
  const plainProfileRoutes = [];
  apply({
    get: (name) => (name === 'profileContext' ? { name: 'default', dir: profileDir } : undefined),
    webServer: { register: (route) => plainProfileRoutes.push(route) },
    effect: () => {},
    logger: { info() {} },
  });
  assert.equal(plainProfileRoutes[0].path, '/wf1/api/lark-auth');
  const profileBin = join(profileDir, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli');
  mkdirSync(join(profileBin, '..'), { recursive: true });
  writeFileSync(profileBin, '#!/bin/sh\nexit 0\n');
  assert.equal(larkCliBin(), profileBin, '装在 profile 里的 lark-cli 必须能被探测到，不能只看全局 bin 目录');

  console.log('lark plugin environments: ok');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}
