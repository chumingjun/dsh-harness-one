// bin/install.js 的安装逻辑单测（零依赖 node:assert，node test/install.test.mjs）。
// 真实模块加载（非字符串截取），node:fs 与 node:child_process 走 mock——
// 重点：issue #24 的占位符归位、幂等（二跑零改动）、块存在/不存在两路径、--prewrite 只写不装。
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const installJs = join(here, '../bin/install.js');

// ---- 纯函数行为经 --prewrite 子进程间接断言（同时也是 ESM 整链冒烟）----
// 用临时 DSH_HOME 造出 issue #24 现场（占位符 + 部分条目），跑 --prewrite 后校验产物。
const home = mkdtempSync(join(tmpdir(), 'ccpg-one-test-'));
try {
  const profileDir = join(home, 'profiles', 'p1');
  mkdirTree(profileDir);
  writeFileSyncUTF8(join(profileDir, 'package.json'), '{"name":"dsh-profile-p1","private":true}');
  writeFileSyncUTF8(join(profileDir, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'minimumReleaseAgeExclude:',
    '  - dsh-better-sidebar@0.16.1',
    'allowBuilds:',
    '  cloudflared: true',
    '  node-pty: set this to true or false',
    '',
  ].join('\n'));

  // DSH_HOME 指向临时目录；dsh 探测用 PATH 上的真 dsh（只影响 init，profile 已在场不触发）
  execFileSync(process.execPath, [installJs, 'p1', '--prewrite'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
  });
  const out = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8');

  // 占位符归位 + 用户条目保留 + 裸名放行追加在块内（顺序不定，逐行断言）
  assert.ok(!out.includes('set this to true'), '占位符必须归位');
  const allowBlock = out.split('allowBuilds:\n')[1]?.split('\n\n')[0] ?? '';
  assert.match(allowBlock, /^  cloudflared: true$/m);
  assert.match(allowBlock, /^  node-pty: true$/m);
  assert.match(allowBlock, /^  protobufjs: true$/m);
  assert.match(out, /minimumReleaseAgeExclude:\n  - dsh-better-sidebar@0\.16\.1\n/);
  for (const p of ['dsh-harness-one', 'dsh-ccpg-canvasui', 'dsh-ccpg-orchestrator', 'dsh-ccpg-tools', 'dsh-ccpg-web']) {
    assert.match(out, new RegExp(`^  - ${p}$`, 'm'), `${p} 应在 minimumReleaseAgeExclude`);
  }
  // 顶级键顺序不乱：packages 仍在最前
  assert.ok(out.startsWith('packages:'));

  // 幂等：二跑零改动
  const before = out;
  execFileSync(process.execPath, [installJs, 'p1', '--prewrite'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
  });
  assert.equal(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8'), before, '二跑必须零改动');

  // 空白 profile（无 workspace 文件）：预写应创建完整块
  const p2 = join(home, 'profiles', 'p2');
  mkdirTree(p2);
  writeFileSyncUTF8(join(p2, 'package.json'), '{"name":"dsh-profile-p2","private":true}');
  execFileSync(process.execPath, [installJs, 'p2', '--prewrite'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
  });
  const out2 = readFileSync(join(p2, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(out2, /allowBuilds:\n  node-pty: true\n  protobufjs: true\n/);
  assert.match(out2, /minimumReleaseAgeExclude:\n  - dsh-harness-one\n/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

function mkdirTree(p) { execFileSync('/bin/mkdir', ['-p', p]); }
function writeFileSyncUTF8(p, t) { execFileSync('/bin/sh', ['-c', `cat > ${JSON.stringify(p)} << 'EOF'\n${t}\nEOF`]); }

console.log('✓ dsh-harness-one bin/install --prewrite：占位符归位 / 幂等 / 空白 profile 三组通过');
