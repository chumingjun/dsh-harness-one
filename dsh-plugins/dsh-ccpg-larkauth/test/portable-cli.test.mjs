import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { larkCliBin, createCurrentUserLarkCliService, profileLarkBin } from '../lib/lark-auth.js';

const root = mkdtempSync(join(tmpdir(), 'lark-portable-'));
try {
  const bin = join(root, 'node_modules/@larksuite/cli/bin/lark-cli.exe');
  mkdirSync(join(bin, '..'), { recursive: true });
  writeFileSync(bin, 'fixture');
  assert.equal(profileLarkBin(root, 'win32'), bin);
  assert.equal(larkCliBin({ platform: 'win32', env: { Path: root } }), bin);
  let installed = false; let installs = 0; let calls = 0;
  const service = createCurrentUserLarkCliService({
    available: () => installed,
    async install() { installs++; installed = true; return { ok: true }; },
    async run(args) { calls++; assert(args.includes('user')); return { ok: true }; },
  });
  await service.run(['docs', '+fetch']); await service.run(['docs', '+fetch']);
  assert.equal(installs, 1, 'first actual Feishu operation supplies the missing managed CLI once');
  assert.equal(calls, 2);
  installed = false;
  await assert.rejects(() => service.run(['docs', '+fetch', '--as', 'bot']), /current user/);
  assert.equal(installs, 1, 'invalid identity must not cause an installation');
  const broken = createCurrentUserLarkCliService({
    available: () => false,
    async install() { return { ok: false, error: 'download failed' }; },
    async run() { throw new Error('missing CLI must not run'); },
  });
  assert.deepEqual(await broken.run(['docs', '+fetch']), { ok: false, error: 'download failed' });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('✓ platform CLI lookup and on-demand managed installation');
