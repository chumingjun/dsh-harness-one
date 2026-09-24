import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AGGREGATE,
  clip,
  collectInstallReport,
  compareSemver,
  executePlan,
  gitRootOf,
  LEGACY_PACKAGES,
  PACKAGE,
  planUpgrade,
  PNPM_LAX_PEERS,
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
  // p-npm：纯 registry 老聚合包（迁移场景）+ install.js + bundles 无 sidebar（NO_SIDEBAR 用户）
  const npmOneDir = join(profilesDir, 'p-npm', 'node_modules', 'dsh-ccpg-one');
  mkdirSync(join(npmOneDir, 'bin'), { recursive: true });
  writePkg(npmOneDir, '0.3.0');
  writeFileSync(join(npmOneDir, 'bin', 'install.js'), '// fixture installer\n');
  writeFileSync(join(profilesDir, 'p-npm', 'package.json'), JSON.stringify({
    name: 'dsh-profile-p-npm',
    dependencies: { 'dsh-ccpg-one': '0.3.0', [SIDEBAR]: '^0.15.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }));
  // p-residue：remove 中断后依赖表和实体都没了，但 .bin 留下悬空软链。
  const residueDir = join(profilesDir, 'p-residue');
  mkdirSync(join(residueDir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(residueDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-p-residue' }));
  symlinkSync('../../nowhere', join(residueDir, 'node_modules', '.bin', 'dsh-ccpg-one'));
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
    assert.deepEqual([...byName.keys()].sort(), ['p-npm', 'p-rel', 'p-residue', 'p-src']);

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

  await test('planner：老包 registry 形态产出 npm-migrate 并保持 NO_SIDEBAR 关闭态', () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const npmProfile = report.find((p) => p.name === 'p-npm');
    const plan = planUpgrade([npmProfile]);
    assert.deepEqual(plan.warnings, []);
    assert.equal(plan.actions[0].type, 'npm-migrate');
    assert.equal(plan.actions[0].installerDir, npmOneDir);
    assert.equal(plan.actions[0].profile, 'p-npm');
    assert.equal(plan.actions[0].bootstrapSidebar, false, '依赖表已有 sidebar → 不需兜底');
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

  await test('planner：残局（.bin 残留但依赖表空）同样产出重装动作', () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const residue = report.find((p) => p.name === 'p-residue');
    assert.ok(residue);
    assert.equal(residue.packages[0].name, 'dsh-ccpg-one');
    assert.equal(residue.packages[0].broken, true);
    const plan = planUpgrade([residue]);
    assert.equal(plan.actions[0].type, 'npm-migrate');
    assert.equal(plan.actions[0].installerDir, null);
    assert.equal(plan.actions[0].bootstrapSidebar, true);
    assert.match(plan.actions[0].title, /修复|迁移/);
  });

  await test('executePlan：残局依赖表为空时使用 add 重新落表', async () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const residue = report.find((p) => p.name === 'p-residue');
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.5.0' } }) });
    try {
      await executePlan(planUpgrade([residue]), {
        dshBin: '/fake/dsh',
        runCmd: async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: null }; },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(calls[0].slice(0, 5), ['/fake/dsh', 'plugin', '--profile', 'p-residue', 'add']);
    assert.equal(calls[0][5], `${PACKAGE}@0.5.0`);
    assert.ok(!calls.some((c) => c.includes('remove') && c.includes(AGGREGATE)), '残局修复不 remove 聚合包');
  });

  await test('executePlan：迁移 prewrite→add 新包→remove 老包（装新在前）', async () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const npmProfile = report.find((p) => p.name === 'p-npm');
    const calls = [];
    // 依赖表随 add/remove 演进：模拟 dsh plugin 的真实落表行为
    const profileManifest = join(profilesDir, 'p-npm', 'package.json');
    const originalManifest = readFileSync(profileManifest, 'utf8');
    const depsState = new Map([
      ['dsh-ccpg-one', '0.3.0'], [SIDEBAR, '^0.15.2'],
    ]);
    const flushDeps = () => writeFileSync(profileManifest, JSON.stringify({
      name: 'dsh-profile-p-npm',
      dependencies: Object.fromEntries(depsState),
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.5.0' } }) });
    try {
      await executePlan(planUpgrade([npmProfile]), {
        dshBin: '/fake/dsh',
        runCmd: async (cmd, args) => {
          calls.push([cmd, ...args]);
          if (cmd === '/fake/dsh' && args[3] === 'add') {
            depsState.set(PACKAGE, '0.5.0'); flushDeps(); // add 落表
          }
          if (cmd === '/fake/dsh' && args[3] === 'remove') {
            depsState.delete(String(args[4])); flushDeps(); // remove 摘表
          }
          return { ok: true, out: '', err: null };
        },
      });
    } finally {
      globalThis.fetch = realFetch;
      writeFileSync(profileManifest, originalManifest); // 还原 fixture
    }
    const prewrite = calls[0];
    assert.equal(prewrite[0], process.execPath);
    assert.equal(prewrite[1], join(npmOneDir, 'bin', 'install.js'));
    assert.equal(prewrite[2], 'p-npm');
    assert.equal(prewrite[3], '--prewrite');
    const add = calls[1];
    assert.equal(add[4], 'add');
    assert.equal(add[5], `${PACKAGE}@0.5.0`);
    const rmIdx = calls.findIndex((c) => c[4] === 'remove');
    const addIdx = calls.findIndex((c) => c[4] === 'add');
    assert.ok(addIdx >= 0 && rmIdx > addIdx, '先 add 新包再 remove 旧包');
    assert.ok(calls.some((c) => c.includes('remove') && c.includes('dsh-ccpg-one')), '老聚合包被移除');
    assert.ok(!depsState.has('dsh-ccpg-one'), '迁移后依赖表无老包');
    assert.ok(depsState.has(PACKAGE), '迁移后依赖表有新包');
    assert.ok(!depsState.has('dsh-ccpg-one'), '迁移后依赖表无老包');
    assert.ok(depsState.has(PACKAGE), '迁移后依赖表有新包');
    assert.ok(!calls.some((c) => c[4] === 'add' && String(c[5] || '').startsWith(SIDEBAR)), '依赖表已有 sidebar 不重复兜底 add');
    assert.ok(!calls.some((c) => c[4] === 'remove' && c[5] === SIDEBAR), 'sidebar 不再被自动移除');
  });

  await test('executePlan：新包在场走 up 原地更新，不触发迁移', async () => {
    const root2 = mkdtempSync(join(tmpdir(), 'ccpg-sysupd-new-'));
    try {
      const pdir = join(root2, 'p-new');
      mkdirSync(join(pdir, 'node_modules', PACKAGE, 'bin'), { recursive: true });
      writeFileSync(join(pdir, 'node_modules', PACKAGE, 'bin', 'install.js'), '// fixture\n');
      writeFileSync(join(pdir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-p-new',
        dependencies: { [PACKAGE]: '0.5.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PACKAGE] } },
      }));
      const report = collectInstallReport({ profilesRoot: root2 });
      const plan = planUpgrade(report);
      assert.equal(plan.actions[0].type, 'npm-reinstall');
      assert.match(plan.actions[0].title, /更新/);
      const calls = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.8.0' } }) });
      try {
        await executePlan(plan, {
          dshBin: '/fake/dsh',
          runCmd: async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: null }; },
        });
      } finally {
        globalThis.fetch = realFetch;
      }
      const up = calls.find((c) => c[4] === 'up');
      assert.ok(up, '在装用户用 up 原地更新');
      assert.equal(up[5], `${PACKAGE}@0.8.0`);
      assert.ok(up.includes(PNPM_LAX_PEERS), 'CLI 路径显式放宽 strict-peer-dependencies（Desktop 强制 CI=true）');
      assert.ok(!calls.some((c) => c[4] === 'remove'), 'up 路径不 remove 任何包');
      assert.ok(calls.some((c) => c[4] === 'add' && String(c[5] || '').startsWith(SIDEBAR)), '纯净安装兜底：依赖表无 sidebar 时补 add 注册 bundle');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  await test('executePlan：Desktop 受管 profile 的 up 走 desktopPnpm 服务，不 spawn dsh CLI', async () => {
    const rootD = mkdtempSync(join(tmpdir(), 'ccpg-sysupd-desk-'));
    try {
      const pdir = join(rootD, 'desktop');
      mkdirSync(pdir, { recursive: true });
      const manifestFile = join(pdir, 'package.json');
      writeFileSync(manifestFile, JSON.stringify({
        name: 'dsh-profile-desktop', dependencies: { [PACKAGE]: '0.11.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PACKAGE] } },
      }));
      const plan = planUpgrade(collectInstallReport({ profilesRoot: rootD }));
      assert.equal(plan.actions[0].type, 'npm-reinstall');
      const serviceCalls = [];
      const cliCalls = [];
      const depsState = new Map([[PACKAGE, '0.11.0']]);
      const desktopPnpm = {
        run(args) {
          serviceCalls.push([...args]);
          if (args[0] === 'add' && args[1].startsWith(PACKAGE)) depsState.set(PACKAGE, args[1].split('@').pop());
          if (args[0] === 'add' && args[1] === SIDEBAR) depsState.set(SIDEBAR, '0.0.0');
          updateDeps(manifestFile, depsState); // 真实 pnpm 只动 dependencies，保留其余字段
          return serviceHandle();
        },
      };
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.11.2' } }) });
      try {
        const log = await executePlan(plan, {
          dshBin: '/fake/dsh',
          desktopPnpm,
          desktopProfile: { name: 'desktop', dir: pdir },
          runCmd: async (cmd, args) => { cliCalls.push([cmd, ...args]); return { ok: true, out: '', err: null }; },
        });
        assert.ok(!cliCalls.some((c) => c[0] === '/fake/dsh'), 'desktop profile 绝不 spawn dsh CLI（会被硬拒）');
        assert.deepEqual(serviceCalls[0], ['add', `${PACKAGE}@0.11.2`, '--save-exact', PNPM_LAX_PEERS]);
        assert.ok(serviceCalls.some((c) => c[0] === 'add' && c[1] === SIDEBAR), 'sidebar 兜底也走服务');
        const after = JSON.parse(readFileSync(manifestFile, 'utf8'));
        assert.ok(after.dsh.profile.bundles.includes(SIDEBAR), 'bundles 自行维护：sidebar 补登记');
        assert.ok(log.some((l) => l.includes('Desktop 受管 pnpm')), '日志标注受管通道');
        assert.match(log.at(-1), /DSH Desktop/);
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      rmSync(rootD, { recursive: true, force: true });
    }
  });

  await test('executePlan：Desktop 受管 profile 的迁移走服务并自行维护 bundles 清单', async () => {
    const rootM = mkdtempSync(join(tmpdir(), 'ccpg-sysupd-deskm-'));
    try {
      const pdir = join(rootM, 'desktop');
      const legacyAgg = LEGACY_PACKAGES.at(-1); // dsh-ccpg-one
      mkdirSync(join(pdir, 'node_modules', legacyAgg, 'bin'), { recursive: true });
      writeFileSync(join(pdir, 'node_modules', legacyAgg, 'bin', 'install.js'), '// fixture\n');
      const manifestFile = join(pdir, 'package.json');
      const depsState = new Map([[legacyAgg, '0.3.0']]);
      const flush = () => {
        const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
        m.dependencies = Object.fromEntries(depsState);
        writeFileSync(manifestFile, JSON.stringify(m));
      };
      writeFileSync(manifestFile, JSON.stringify({
        name: 'dsh-profile-desktop', dependencies: Object.fromEntries(depsState),
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', legacyAgg] } },
      }));
      const plan = planUpgrade(collectInstallReport({ profilesRoot: rootM }));
      assert.equal(plan.actions[0].type, 'npm-migrate');
      const serviceCalls = [];
      const cliCalls = [];
      const desktopPnpm = {
        run(args) {
          serviceCalls.push([...args]);
          if (args[0] === 'add') depsState.set(PACKAGE, '0.11.2');
          if (args[0] === 'remove') depsState.delete(args[1]);
          flush();
          return serviceHandle();
        },
      };
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.11.2' } }) });
      try {
        const log = await executePlan(plan, {
          dshBin: '/fake/dsh',
          desktopPnpm,
          desktopProfile: { name: 'desktop', dir: pdir },
          runCmd: async (cmd, args) => { cliCalls.push([cmd, ...args]); return { ok: true, out: '', err: null }; },
        });
        assert.ok(!cliCalls.some((c) => c[0] === '/fake/dsh'), 'desktop profile 绝不 spawn dsh CLI');
        const addIdx = serviceCalls.findIndex((c) => c[0] === 'add' && c[1]?.startsWith(PACKAGE));
        const rmIdx = serviceCalls.findIndex((c) => c[0] === 'remove');
        assert.ok(addIdx >= 0 && rmIdx > addIdx, '先装新包再拆旧包');
        assert.ok(serviceCalls.some((c) => c[0] === 'remove' && c[1] === legacyAgg), '老聚合包经服务移除');
        const after = JSON.parse(readFileSync(manifestFile, 'utf8'));
        assert.ok(after.dsh.profile.bundles.includes(PACKAGE), 'bundles 补登记新包');
        assert.ok(!after.dsh.profile.bundles.includes(legacyAgg), 'bundles 摘除老包');
        assert.ok(log.some((l) => l.includes('迁移完成')));
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      rmSync(rootM, { recursive: true, force: true });
    }
  });

  await test('clip：长输出保头保尾（错误集中在输出末尾）', () => {
    assert.equal(clip(''), '（无输出）');
    assert.equal(clip('short'), 'short');
    const long = `${'x'.repeat(500)}\nERR_PNPM_PEER_CONFLICT`;
    const clipped = clip(long);
    assert.ok(clipped.startsWith('x'), '保留头部定位命令');
    assert.ok(clipped.endsWith('ERR_PNPM_PEER_CONFLICT'), '保留尾部定位原因');
    assert.ok(clipped.length < 400, '总长受控');
  });

  await test('executePlan：迁移中途 add 失败则保留老包（可重试）', async () => {
    const report = collectInstallReport({ profilesRoot: profilesDir });
    const npmProfile = report.find((p) => p.name === 'p-npm');
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.5.0' } }) });
    try {
      const log = await executePlan(planUpgrade([npmProfile]), {
        dshBin: '/fake/dsh',
        runCmd: async (cmd, args) => {
          calls.push([cmd, ...args]);
          if (cmd === '/fake/dsh' && args[3] === 'add') return { ok: false, out: 'ERR_PNPM_NET', err: null };
          return { ok: true, out: '', err: null };
        },
      });
      assert.ok(log.some((l) => l.includes('旧安装未动')), '失败提示老包未动');
      assert.ok(!calls.some((c) => c[3] === 'remove'), 'add 失败不 remove 任何包');
    } finally {
      globalThis.fetch = realFetch;
    }
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

// desktopPnpm 服务句柄（形状与 larkauth 的 desktopPnpm.run 返回一致）
function serviceHandle({ stdout = '' } = {}) {
  const out = new PassThrough();
  const err = new PassThrough();
  const done = Promise.resolve().then(() => {
    if (stdout) out.write(stdout);
    out.end();
    err.end();
    return { exitCode: 0, signal: null };
  });
  return { stdout: out, stderr: err, done, cancel() {} };
}

// 模拟真实 pnpm 的落表行为：只改 dependencies，保留 manifest 其余字段（含 bundles）
function updateDeps(manifestFile, depsState) {
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  m.dependencies = Object.fromEntries(depsState);
  writeFileSync(manifestFile, JSON.stringify(m));
}
