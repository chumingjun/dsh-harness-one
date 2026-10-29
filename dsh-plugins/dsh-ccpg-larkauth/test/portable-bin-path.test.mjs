import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { larkCliBin, profileLarkBin } from '../lib/lark-auth.js';

const root = mkdtempSync(join(tmpdir(), 'lark-bin-path-'));
try {
  const winBin = join(root, 'node_modules/@larksuite/cli/bin/lark-cli.exe');
  mkdirSync(join(winBin, '..'), { recursive: true });
  writeFileSync(winBin, 'fixture');
  assert.equal(profileLarkBin(root, 'win32'), winBin);
  assert.equal(larkCliBin({ platform: 'win32', env: { Path: root } }), winBin);

  const posixBin = join(root, 'lark-cli');
  writeFileSync(posixBin, 'fixture');
  assert.equal(larkCliBin({ platform: 'darwin', env: { PATH: root } }), posixBin);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ platform-aware lark-cli binary lookup');
