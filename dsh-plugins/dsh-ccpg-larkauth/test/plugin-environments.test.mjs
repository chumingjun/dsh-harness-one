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

  console.log('lark plugin environments: ok');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}
