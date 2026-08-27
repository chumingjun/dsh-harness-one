import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGGREGATE,
  collectInstallReport,
  compareSemver,
  executePlan,
  gitRootOf,
  planUpgrade,
  SIDEBAR,
} from '../lib/system-upgrade.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

console.log('system-upgrade tests:');

  const root = mkdtempSync(join(tmpdir(), 'ccpg-sysupd-'));
  // macOS /var 是 /private/var 软链：link 目标经 realpath 记录，期望值同口径归一
  const norm = (p) => realpathSync(p);
  try {
  // ---- fixture：三种来源形态 ----
  const srcRepo = join(root, 'src-repo');
  mkdirSync(join(srcRepo, '.git'), { recursive: true });
  mkdirSync(join(srcRepo, 'dsh-plugins'), { recursive: true });
  writeFileSync(join(srcRepo, 'dsh-plugins', 'setup.sh'), '#!/bin/sh\n');
  writePkg(join(srcRepo, 'dsh-plugins', 'dsh-ccpg-orchestrator'), '0.3.1');

  const releaseTree = join(root, 'wf-one-release');
  mkdirSync(join(releaseTree, 'dsh-plugins', 'dsh-ccpg-canvasui'), { recursive: true });
  writePkg(join(releaseTree, 'dsh-plugins', 'dsh-ccpg-canvasui'), '0.3.0');

  const profilesDir = join(root, 'profiles');
  // p-npm：纯 registry 版本号 + 已装聚合包的 install.js + bundles 无 sidebar（NO_SIDEBAR 用户）
  const npmOneDir = join(profilesDir, 'p-npm', 'node_modules', AGGREGATE);
  mkdirSync(join(npmOneDir, 'bin'), { recursive: true });
  writePkg(npmOneDir, '0.3.0');
  writeFileSync(join(npmOneDir, 'bin', 'install.js'), '// fixture installer\n');
  writeFileSync(join(profilesDir, 'p-npm', 'package.json'), JSON.stringify({
    name: 'dsh-profile-p-npm',
    dependencies: { [AGGREGATE]: '0.3.0', [SIDEBAR]: '^0.15.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }));
  // p-src：link 进 git 仓库
  mkdirSync(join(profilesDir, 'p-src'), { recursive: true });
  writeFileSync(join(profilesDir, 'p-src', 'package.json'), JSON.stringify({
    name: 'dsh-profile-p-src',
    dependencies: { 'dsh-ccpg-orchestrator': `link:${join(srcRepo, 'dsh-plugins', 'dsh-ccpg-orchestrator')}` },
  }));
  // p-rel：link 进无 .git 的解包目录
  mkdirSync(join(profilesDir, 'p-rel'), { recursive: true });
  writeFileSync(join(profilesDir, 'p-rel', 'package.json'), JSON.stringify({
    name: 'dsh-profile-p-rel',
    dependencies: { 'dsh-ccpg-canvasui': `link:${join(releaseTree, 'dsh-plugins', 'dsh-ccpg-canvasui')}` },
  }));
  // p-empty：与套件无关，不应收录
  mkdirSync(join(profilesDir, 'p-empty'), { recursive: true });
  writeFileSync(join(profilesDir, 'p-empty', 'package.json'), JSON.stringify({
    name: 'dsh-profile-p-empty', dependencies: { sharp: '^0.35.0' },
  }));

  await test('来源探测：三种形态逐包分类、无关 profile 排除', () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const byName = new Map(report.map((p) => [p.name, p]));
    assert.deepEqual([...byName.keys()].sort(), ['p-npm', 'p-rel', 'p-src']);

    assert.equal(gitRootOf(join(srcRepo, 'dsh-plugins')), srcRepo);
    assert.equal(gitRootOf(join(releaseTree)), null);

    const srcEntry = byName.get('p-src').packages[0];
    assert.equal(srcEntry.kind, 'link');
    assert.equal(srcEntry.gitRoot, norm(srcRepo));
    assert.equal(srcEntry.version, '0.3.1');

    const relEntry = byName.get('p-rel').packages[0];
    assert.equal(relEntry.kind, 'link');
    assert.equal(relEntry.gitRoot, null);
    assert.equal(relEntry.version, '0.3.0');

    assert.ok(byName.get('p-npm').packages.every((p) => p.kind === 'registry'));
  });

  await test('planner：源码形态产出 source-pull 并定位 dsh-plugins 目录', () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const srcProfile = report.find((p) => p.name === 'p-src');
    const plan = planUpgrade([srcProfile]);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, 'source-pull');
    assert.equal(plan.actions[0].root, norm(srcRepo));
    assert.equal(plan.actions[0].pluginsDir, norm(join(srcRepo, 'dsh-plugins')));
    assert.equal(plan.restartRequired, true);
  });

  await test('planner：离线包形态给原地上包覆盖指引', () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const relProfile = report.find((p) => p.name === 'p-rel');
    const plan = planUpgrade([relProfile]);
    assert.equal(plan.actions[0].type, 'manual-overlay');
    assert.match(plan.actions[0].instruction, /覆盖/);
  });

  await test('planner：npm 形态复用已装安装器并保持 NO_SIDEBAR 关闭态', () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const npmProfile = report.find((p) => p.name === 'p-npm');
    const plan = planUpgrade([npmProfile]);
    assert.deepEqual(plan.warnings, []);
    assert.equal(plan.actions[0].type, 'npm-reinstall');
    assert.equal(plan.actions[0].installerDir, npmOneDir);
    assert.equal(plan.actions[0].profile, 'p-npm');
    assert.equal(plan.actions[0].keepSidebarRemoved, true);
  });

  await test('executePlan：脏工作树跳过该仓库且不重建，仍提示重启', async () => {
    const calls = [];
    const log = await executePlan(
      planOfSource(),
      {
        runCmd: async (cmd, args) => {
          calls.push([cmd, ...args]);
          if (cmd === 'git' && args[0] === 'status') return { ok: true, out: ' M local-edit\n', err: null };
          return { ok: true, out: '', err: null };
        },
        runSh: async () => ({ ok: true, out: '', err: null }),
      },
    );
    assert.ok(!calls.some((c) => c[1] === 'pull'), '脏树不 pull');
    assert.ok(log.some((l) => l.includes('跳过该仓库')));
    assert.ok(log.at(-1).includes('重启'));
  });

  await test('executePlan：干净树按 pull→双构建→依赖 顺序执行', async () => {
    const order = [];
    const log = await executePlan(
      planOfSource(),
      {
        runCmd: async (cmd, args) => {
          order.push(`${cmd} ${args.join(' ')}`);
          if (cmd === 'git' && args[0] === 'status') return { ok: true, out: '', err: null };
          return { ok: true, out: cmd === 'git' ? 'Already up to date.' : '', err: null };
        },
        runSh: async (script) => {
          order.push(`sh:${script}`);
          return { ok: true, out: '', err: null };
        },
      },
    );
    const pullIdx = order.findIndex((c) => c.startsWith('git pull'));
    const webIdx = order.findIndex((c) => c.startsWith('sh:./build-web.sh'));
    assert.ok(pullIdx >= 0 && webIdx > pullIdx, '先 pull 后构建');
    assert.ok(order.some((c) => c.includes('build-canvasui')));
    assert.ok(order.some((c) => c.includes('quickjs-emscripten')));
    assert.ok(log.some((l) => l.includes('画布双构建完成')));
  });

  await test('executePlan：npm 路径 remove→install.js→按先前配置补移 sidebar', async () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const npmProfile = report.find((p) => p.name === 'p-npm');
    const calls = [];
    await executePlan(planUpgrade([npmProfile]), {
      dshBin: '/fake/dsh',
      runCmd: async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: null }; },
    });
    assert.ok(calls[0].join(' ').includes(`remove ${AGGREGATE}`));
    assert.equal(calls[1][0], process.execPath);
    assert.equal(calls[1][1], join(npmOneDir, 'bin', 'install.js'));
    assert.equal(calls[1][2], 'p-npm');
    assert.ok(calls[2].join(' ').includes(`remove ${SIDEBAR}`), 'bundles 无 sidebar ⇒ 升级后补移');
  });

  await test('compareSemver 数字段比较、容忍前缀与缺参', () => {
    assert.equal(compareSemver('0.3.10', '0.3.9'), 1);
    assert.equal(compareSemver('^0.3.0', 'v0.4.0'), -1);
    assert.equal(compareSemver('0.3.0', '0.3.0'), 0);
    assert.equal(compareSemver(null, '0.1.0'), -1);
    assert.equal(compareSemver('1.0', '1.0.1'), -1);
  });

  function planOfSource() {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    return planUpgrade([report.find((p) => p.name === 'p-src')]);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} tests passed`);

function writePkg(dir, version) {
  mkdirSync(dir, { recursive: true });
  const name = dir.split(/[\\/]/).pop();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
}
