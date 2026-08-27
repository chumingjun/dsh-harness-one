// 系统级升级支持：安装来源探测（settings「Workflow One」版本中心的后端）。
// v0.5.0 起套件合并为单包 dsh-harness-one（旧 8 包 dsh-ccpg-* 停更）。
// 三种来源形态（profile dependencies 里逐一判定）：
//   link:<路径> 且路径上方存在 .git      → 源码安装（git pull + 双构建重建）
//   link:<路径> 且无 .git                → release 离线包解包目录（原地上包覆盖指引）
//   纯 semver                            → npm 安装（up 到 latest / 老包迁移到新包）
// 迁移语义（老包 dsh-ccpg-one → 新包 dsh-harness-one）：
//   装新在前、拆旧在后，中途失败老包仍在位可重试；reconcile 自动维护 bundles 层。
// planner（planUpgrade）纯函数零副作用，单测直测；执行器（executePlan）只做进程编排，
// 不做业务判断——动作合法性全部在 planner 定型。

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// 单包时代：唯一装载点名。老 8 包仅作迁移探测目标。
export const PACKAGE = 'dsh-harness-one';
export const AGGREGATE = PACKAGE;
export const SIDEBAR = 'dsh-better-sidebar';
// v0.5.0 之前的 8 包形态（升级器据此识别并迁移到 PACKAGE）
export const LEGACY_PACKAGES = [
  'dsh-ccpg-tools',
  'dsh-ccpg-orchestrator',
  'dsh-ccpg-web',
  'dsh-ccpg-canvasui',
  'dsh-ccpg-document-preview',
  'dsh-ccpg-larkauth',
  'dsh-ccpg-llm-guard',
  'dsh-ccpg-one',
];
export const PACKAGES = [PACKAGE, ...LEGACY_PACKAGES, SIDEBAR];

export function profilesRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'profiles');
}

// 从 startPath 逐级向上找 .git；到根没有返回 null（离线包解包目录即此形态）。
export function gitRootOf(startPath) {
  let cur = resolve(startPath);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function readPackageVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// 扫描 profiles 根下所有 profile 的 dependencies ∩ 本套件包名，输出逐来源分类报告。
// 结构：[{ name, path, packages:[{name,kind,spec,target?,version?,gitRoot?}] }]
export function collectInstallReport({ profilesRoot: root = profilesRoot() } = {}) {
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const report = [];
  for (const name of dirs) {
    const path = join(root, name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const deps = manifest.dependencies || {};
    const packages = [];
    for (const pkg of PACKAGES) {
      const spec = deps[pkg];
      if (!spec || typeof spec !== 'string') continue;
      if (spec.startsWith('link:')) {
        const raw = spec.slice(5);
        let target = null;
        try {
          target = isAbsolute(raw) ? realpathSync(raw) : null;
        } catch {
          target = null;
        }
        packages.push({
          name: pkg,
          kind: 'link',
          spec,
          target,
          version: target ? readPackageVersion(target) : null,
          gitRoot: target ? gitRootOf(target) : null,
        });
      } else {
        packages.push({ name: pkg, kind: 'registry', spec, version: spec.replace(/^[^\d]*/, '') || null });
      }
    }
    // 残局探测：升级中断的 profile 被 dsh plugin remove 全量回收——依赖表与
    // bundles 都不再挂包，但 node_modules/.bin/<pkg> 链接残留（悬空软链，
    // existsSync 会跟链判 false，须 lstat 看链接本身）。以它为「曾装过」
    // 信号标记空壳，planner 走 add/migrate 自愈重装。
    if (!packages.length) {
      for (const agg of [PACKAGE, 'dsh-ccpg-one']) {
        let binResidue = false;
        try { binResidue = lstatSync(join(path, 'node_modules', '.bin', agg)).isSymbolicLink(); } catch { /* 无残留 */ }
        if (binResidue) {
          packages.push({ name: agg, kind: 'registry', spec: 'latest', version: null, broken: true });
          break;
        }
      }
    }
    if (packages.length) report.push({ name, path, packages });
  }
  return report;
}

// 由报告生成升级计划。所有合法性判断在这里：脏工作树不 pull、混装场景拆成多条动作、
// registry 模式需要已装包的 install.js 在场（卸载前抓取其路径）。
export function planUpgrade(report) {
  const actions = [];
  const warnings = [];
  const seenSourceRoots = new Set();

  for (const profile of report) {
    const byName = new Map(profile.packages.map((p) => [p.name, p]));
    const hasNew = byName.get(PACKAGE);
    const legacyEntry = byName.get('dsh-ccpg-one');

    // ---- 源码安装：每个独立仓库一条 拉取+重建 链 ----
    for (const pkg of profile.packages) {
      if (pkg.kind !== 'link' || !pkg.gitRoot || seenSourceRoots.has(pkg.gitRoot)) continue;
      seenSourceRoots.add(pkg.gitRoot);
      const pluginsDir = findPluginsDir(pkg.gitRoot, pkg.target);
      actions.push({
        type: 'source-pull',
        title: `源码更新 ${shorten(pkg.gitRoot)}（git pull --ff-only）`,
        root: pkg.gitRoot,
        pluginsDir,
      });
    }
    // ---- 离线包解包目录：不给自动动作，给原地覆盖指引 ----
    for (const pkg of profile.packages) {
      if (pkg.kind === 'link' && pkg.target && !pkg.gitRoot) {
        actions.push({
          type: 'manual-overlay',
          title: `离线包目录需手动覆盖：${shorten(dirname(pkg.target))}`,
          target: pkg.target,
          instruction:
            '下载新版 dsh-harness-one 发布包，解包覆盖该目录（保留原目录路径），完成后回到本页再点一次「检查并修复环境」收尾重链。',
        });
        break;
      }
    }
    // ---- npm 安装：三分支 ----
    // ① 老包在场、新包不在 → 迁移：add 新包 → remove 老包（装新在前，失败可重试）
    // ② 新包在场 → 原地 up latest（成熟包管理器路径，无卸载空窗）
    // ③ 老包残局（broken）→ 同迁移分支（老包依赖表已空，remove 为 no-op 跳过）
    const hasRegistry = profile.packages.some((p) => p.kind === 'registry');
    if (hasRegistry) {
      const bundles = readProfileBundles(profile.path);
      const installerDir = locateInstalledInstaller(profile.path, hasNew ? PACKAGE : 'dsh-ccpg-one');
      if ((legacyEntry || profile.packages.some((p) => p.broken)) && !hasNew) {
        actions.push({
          type: 'npm-migrate',
          title: legacyEntry
            ? `迁移到单包 ${PACKAGE}（profile: ${profile.name}）：安装新包并移除旧 8 包`
            : `修复旧安装并迁移到 ${PACKAGE}（profile: ${profile.name}）`,
          profile: profile.name,
          profilePath: profile.path,
          installerDir,
          keepSidebarRemoved: bundles.includes(SIDEBAR) ? false : true,
        });
      } else if (hasNew) {
        actions.push({
          type: 'npm-reinstall',
          title: hasNew.broken
            ? `修复未完成的安装：重装 ${PACKAGE}@latest（profile: ${profile.name}）`
            : `npm 更新 ${PACKAGE}@${hasNew.spec || '?'} → latest（profile: ${profile.name}）`,
          profile: profile.name,
          profilePath: profile.path,
          installerDir,
          keepSidebarRemoved: bundles.includes(SIDEBAR) ? false : true,
        });
        if (legacyEntry) {
          warnings.push(`profile ${profile.name} 同时装有 ${PACKAGE} 与旧包 dsh-ccpg-one，升级时建议移除旧包`);
        }
      }
    }
  }
  if (!actions.length) {
    return { actions, warnings: [...warnings, '未发现可自动升级的安装（可能尚未安装本套件）'], restartRequired: false };
  }
  return { actions, warnings, restartRequired: true };
}

// npm 渠道实体落在 profile node_modules 里；link 渠道此路径不存在。
// 迁移场景优先新包安装器，老包安装器兜底（预写键名幂等，版本无关）。
function locateInstalledInstaller(profilePath, pkgName) {
  const candidate = join(profilePath, 'node_modules', pkgName, 'bin', 'install.js');
  return existsSync(candidate) ? dirname(dirname(candidate)) : null;
}

function readProfileBundles(profilePath) {
  try {
    const m = JSON.parse(readFileSync(join(profilePath, 'package.json'), 'utf8'));
    return m.dsh?.profile?.bundles || [];
  } catch {
    return [];
  }
}

// gitRoot 下定位 dsh-plugins/ 目录；异构布局按目标包真实路径回溯兜底。
function findPluginsDir(gitRoot, target) {
  const direct = join(gitRoot, 'dsh-plugins');
  if (existsSync(join(direct, 'setup.sh'))) return direct;
  let cur = resolve(target);
  const floor = resolve(gitRoot);
  while (cur.length > floor.length) {
    if (cur.endsWith('dsh-plugins')) return cur;
    cur = dirname(cur);
  }
  return direct;
}

function shorten(p) {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// 只比 x.y.z 数字段；前缀（v/^）与预发布标签不参与——发版口径是同版本号列车。
export function compareSemver(a, b) {
  const pa = String(a || '').replace(/^[^\d]*/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^[^\d]*/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// ---------------- 执行器 ----------------

function run(cmd, args, cwd) {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      res({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim(), err: err ? String(err.message || err) : null });
    });
  });
}

async function sh(script, cwd) {
  return run('/bin/sh', ['-c', script], cwd);
}

// 顺序执行计划；每步产出一行日志。失败不中断整体（后续步骤按各自前置再判），
// 但 source-pull 的任何子步失败会终止该仓库后续重建步骤。
export async function executePlan(plan, { dshBin, runCmd = run, runSh = sh } = {}) {
  const log = [];
  const push = (line) => {
    log.push(line);
    return line;
  };
  for (const action of plan.actions) {
    push(`▶ ${action.title}`);
    if (action.type === 'source-pull') {
      const dirty = await runCmd('git', ['status', '--porcelain'], action.root);
      if (!dirty.ok) {
        push(`  ✗ git status 失败：${dirty.err}`);
        continue;
      }
      if (dirty.out.trim()) {
        push('  ⚠ 工作树有未提交改动，跳过该仓库（请手动 stash/commit 后重试）');
        continue;
      }
      const pulled = await runCmd('git', ['pull', '--ff-only'], action.root);
      push(pulled.ok ? `  ${pulled.out.split('\n').pop() || '已是最新'}` : `  ✗ pull 失败：${pulled.out || pulled.err}`);
      if (!pulled.ok) continue;
      const webBuild = await runSh('./build-web.sh', action.pluginsDir);
      if (!webBuild.ok) push(`  ✗ build-web.sh：${webBuild.out}`);
      else push('  ✓ 画布双构建完成');
      const canvasBuild = await runSh('./build-canvasui.sh --check || ./build-canvasui.sh', action.pluginsDir);
      push(canvasBuild.ok ? '  ✓ canvasui bundle 就绪' : `  ✗ canvasui bundle：${canvasBuild.out}`);
      const orchDeps = await runSh(
        '[ -d dsh-ccpg-orchestrator/node_modules/quickjs-emscripten ] || npm install --no-audit --no-fund --prefix dsh-ccpg-orchestrator',
        action.pluginsDir,
      );
      if (!orchDeps.ok) push(`  ✗ orchestrator 依赖：${orchDeps.out}`);
      else push('  ✓ orchestrator 依赖就绪');
    } else if (action.type === 'npm-migrate' || action.type === 'npm-reinstall') {
      const dsh = dshBin || await resolveDshBin(runCmd);
      if (!dsh) {
        push('  ✗ 未找到 dsh 可执行文件');
        continue;
      }
      // pnpm 11 放行预写（node-pty 原生构建，issue #24）：包内安装器幂等，新旧包皆可。
      if (action.installerDir) {
        await runCmd(process.execPath, [join(action.installerDir, 'bin', 'install.js'), action.profile, '--prewrite']);
        push('  pnpm 构建放行已预写');
      }
      const latest = await latestVersion();
      if (!latest) {
        push('  ✗ 查询 npm registry 最新版失败（网络？），跳过该 profile');
        continue;
      }
      if (action.type === 'npm-migrate') {
        // 装新在前：失败则老包仍在位，可整段重试。
        const add = await runCmd(dsh, ['plugin', '--profile', action.profile, 'add', `${PACKAGE}@${latest}`]);
        if (!add.ok) {
          push(`  ✗ 安装 ${PACKAGE} 失败：${add.out}（旧安装未动，可重试）`);
          continue;
        }
        push(`  ✓ ${PACKAGE}@${latest} 已安装`);
        // 校验依赖表确实落了新包（reconcile 后），再拆旧——防 add 报成功但未落表。
        if (!readDep(action.profilePath, PACKAGE)) {
          push('  ⚠ 依赖表未见新包（安装异常？），保留旧包不动，请检查后重试');
          continue;
        }
        // 拆旧在后：老聚合包 remove 会级联回收 7 个子包；逐个判在场再拆。
        for (const legacy of LEGACY_PACKAGES) {
          if (!readDep(action.profilePath, legacy)) continue;
          const rm = await runCmd(dsh, ['plugin', '--profile', action.profile, 'remove', legacy]);
          push(rm.ok ? `  ✓ 已移除旧包 ${legacy}` : `  ✗ 移除 ${legacy} 失败：${rm.out}（可手动 remove）`);
        }
        push(`  ✓ 迁移完成：${PACKAGE}@${latest}`);
      } else {
        // 原地更新到 latest 精确版本，失败时旧版仍在位（pnpm 原子性），无卸载空窗。
        // pnpm up 对依赖表里没有的包是 no-op 且报成功——残局（依赖表被清）必须
        // 用 add 重新落表；在装用户用 up 原地覆盖。up 前先核依赖表，不凭 planner
        // 快照（探测与执行之间状态可能变了）。
        const currentSpec = readDep(action.profilePath, PACKAGE);
        const verb = currentSpec ? 'up' : 'add';
        const up = await runCmd(dsh, ['plugin', '--profile', action.profile, verb, `${PACKAGE}@${latest}`]);
        push(up.ok ? `  ✓ ${PACKAGE} → ${latest}（${verb === 'up' ? '原地更新' : '重装落表'}）` : `  ✗ ${verb} 失败：${up.out}`);
      }
      if (action.keepSidebarRemoved) {
        const sidebar = await readDep(action.profilePath, SIDEBAR);
        if (sidebar) {
          await runCmd(dsh, ['plugin', '--profile', action.profile, 'remove', SIDEBAR]);
          push('  按先前配置保持 better-sidebar 关闭');
        } else {
          push('  better-sidebar 保持未安装（沿用先前配置）');
        }
      }
    } else if (action.type === 'manual-overlay') {
      push(`  ${action.instruction}`);
    }
  }
  if (plan.restartRequired) push('⚠ 改动生效需要彻底重启 dsh（HMR 缓存模块）：结束进程后重新 start.sh');
  return log;
}

async function resolveDshBin(runCmd = run) {
  for (const probe of [
    ['dsh', ['--version']],
    [join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles/node_modules/@deepseek-ai/dsh/lib/bin.js'), ['--version']],
  ]) {
    const r = await runCmd(probe[0], probe[1]);
    if (r.ok) return probe[0];
  }
  return null;
}

// npm registry dist-tags（带 8s 超时；离线时 up/migrate 步骤直接跳过，不动现状）。
// 优先新包；新包未到 0.5.0（迁移窗口未开）时返回 null——迁移分支不会误触发。
async function latestVersion() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://registry.npmjs.org/${PACKAGE}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const latest = (await r.json())['dist-tags']?.latest || null;
    return latest && compareSemver(latest, '0.5.0') >= 0 ? latest : null;
  } catch {
    return null;
  }
}

// 读 profile 依赖表里某个包的 spec（不在则 null）
function readDep(profilePath, name) {
  try {
    return JSON.parse(readFileSync(join(profilePath, 'package.json'), 'utf8')).dependencies?.[name] || null;
  } catch {
    return null;
  }
}
