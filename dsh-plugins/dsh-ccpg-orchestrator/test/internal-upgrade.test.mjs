import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectInstallReport, planUpgrade, checkPackageUpdate, executePlan } from '../lib/system-upgrade.js';

test('internal installed package never receives public npm or source-pull upgrade actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheme-upgrade-'));
  try {
    const profile = join(root, 'desktop');
    const installed = join(profile, 'node_modules', 'dsh-harness-one');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-harness-one': '0.5.9' } }));
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-harness-one', version: '0.5.9', ccpg: { channel: 'internal' } }));
    const report = collectInstallReport({ profilesRoot: root });
    assert.equal(report[0].packages[0].channel, 'internal');
    const plan = planUpgrade(report);
    assert.ok(plan.actions.length);
    assert.ok(plan.actions.every((action) => action.type === 'manual-internal'));
    assert.equal(plan.restartRequired, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scheme in a source profile also protects the internal aggregation', () => {
  const plan = planUpgrade([{ name: 'local', path: '/fixture/profile', packages: [
    { name: 'dsh-ccpg-scheme', kind: 'link', target: '/fixture/repo/plugin', gitRoot: '/fixture/repo' },
    { name: 'dsh-harness-one', kind: 'registry', spec: '0.5.9' },
  ] }]);
  assert.ok(plan.actions.every((action) => action.type === 'manual-internal'));
  assert.equal(plan.restartRequired, false);
});

test('check-update returns internal channel without consulting registry; public behavior remains', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.6.0' } }) }; };
  const internal = await checkPackageUpdate({ version: '0.5.9', ccpg: { channel: 'internal' } }, { fetchImpl });
  assert.equal(calls, 0);
  assert.deepEqual(internal, { ok: true, current: '0.5.9', latest: null, updateAvailable: false, channel: 'internal', manualUpdate: true });
  const publicResult = await checkPackageUpdate({ version: '0.5.9' }, { fetchImpl });
  assert.equal(calls, 1);
  assert.equal(publicResult.updateAvailable, true);
});

test('executor rechecks internal channel even with a stale public plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheme-upgrade-race-'));
  try {
    const installed = join(root, 'node_modules', 'dsh-harness-one');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'dsh-harness-one': '0.5.9' } }));
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-harness-one', version: '0.5.9', ccpg: { channel: 'internal' } }));
    const log = await executePlan({ actions: [{ type: 'npm-reinstall', profile: 'desktop', profilePath: root, title: 'stale plan' }], restartRequired: false }, {
      runCmd: async () => { throw new Error('must not execute public upgrade'); },
    });
    assert.ok(log.some((line) => line.includes('内部')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
