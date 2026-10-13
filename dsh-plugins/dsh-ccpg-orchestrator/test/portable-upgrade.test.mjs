import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectInstallReport, executePlan } from '../lib/system-upgrade.js';

const root = mkdtempSync(join(tmpdir(), 'portable-upgrade-'));
try {
  const source = join(root, 'source'); const profile = join(root, 'profiles', 'test');
  mkdirSync(source); mkdirSync(profile, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-harness-one': 'link:../../source' } }));
  assert.equal(collectInstallReport({ profilesRoot: join(root, 'profiles') })[0].packages[0].target, realpathSync(source));
  const calls = [];
  const log = await executePlan({ actions: [{ type: 'source-pull', title: 'source', root: source, pluginsDir: source }], restartRequired: true }, {
    platform: 'win32',
    runCmd: async (...args) => { calls.push(args); return { ok: true, out: '' }; },
    runSh: async () => { throw new Error('Windows must not invoke POSIX build scripts or modify the checkout'); },
  });
  assert.equal(calls.length, 0, 'unsupported source build must be rejected before git pull');
  assert(log.some((line) => /Windows.*安装包/.test(line)));
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('✓ relative source links and Windows source-upgrade boundary');
