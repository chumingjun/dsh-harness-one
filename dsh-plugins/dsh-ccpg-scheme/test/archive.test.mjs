import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const packScript = readFileSync(join(root, 'dsh-plugins/pack.sh'), 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'ccpg-archive-test-'));
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', ...options });

try {
  const listingCheck = packScript.match(/BAD_SDK_LINKS=\$\(tar -tvzf "\$TAR" \| awk .*?\nif \[ -n "\$BAD_SDK_LINKS" \]; then\n[\s\S]*?\nfi/);
  assert(listingCheck, 'pack.sh must keep its tar symlink-entry check');

  const fixture = join(temp, 'tree');
  mkdirSync(join(fixture, 'dsh-plugins/dsh-ccpg-scheme/node_modules/@deepseek-ai/libreoffice-kit-linux-x64'), { recursive: true });
  mkdirSync(join(fixture, 'dsh-plugins/node_modules/@deepseek-ai'), { recursive: true });
  writeFileSync(join(fixture, 'dsh-plugins/dsh-ccpg-scheme/node_modules/@deepseek-ai/libreoffice-kit-linux-x64/runtime.node'), 'runtime');
  writeFileSync(join(fixture, 'dsh-plugins/dsh-ccpg-scheme/node_modules/@deepseek-ai/libreoffice-kit-linux-x64/package.json'), '{}');
  symlinkSync('../../../../target', join(fixture, 'dsh-plugins/node_modules/@deepseek-ai/dsh-tools'));
  symlinkSync('missing-target', join(fixture, 'dsh-plugins/node_modules/@deepseek-ai/dsh-session'));
  const archive = join(temp, 'fixture.tar.gz');
  run('tar', ['-czf', archive, '-C', fixture, 'dsh-plugins']);

  const shellCheck = (archivePath) => spawnSync('sh', ['-c', listingCheck[0]], {
    encoding: 'utf8', env: { ...process.env, TAR: archivePath },
  });
  const passed = shellCheck(archive);
  assert.equal(passed.status, 1, 'SDK symlink entries, including dangling links, must reject the archive');
  assert.match(passed.stdout + passed.stderr, /不可分发的 @deepseek-ai SDK 软链/);

  const cleanFixture = join(temp, 'clean-tree');
  mkdirSync(join(cleanFixture, 'dsh-plugins/dsh-ccpg-scheme/node_modules/@deepseek-ai/libreoffice-kit-linux-x64'), { recursive: true });
  writeFileSync(join(cleanFixture, 'dsh-plugins/dsh-ccpg-scheme/node_modules/@deepseek-ai/libreoffice-kit-linux-x64/runtime.node'), 'runtime');
  const cleanArchive = join(temp, 'clean.tar.gz');
  run('tar', ['-czf', cleanArchive, '-C', cleanFixture, 'dsh-plugins']);
  assert.equal(shellCheck(cleanArchive).status, 0, 'real LibreOffice package directories must be allowed');

  const rsyncBlock = packScript.match(/rsync -a --delete \\\n[\s\S]*?"\$HERE\/" "\$OUT\/dsh-plugins\/"/);
  assert(rsyncBlock, 'pack.sh must retain the release rsync block');
  assert.match(rsyncBlock[0], /--exclude '\.DS_Store'/);
  for (const path of ['dsh-ccpg-scheme/src', 'dsh-ccpg-scheme/scripts', 'dsh-ccpg-scheme/authoring', 'dsh-ccpg-scheme/test', 'dsh-ccpg-scheme/tasks', 'dsh-ccpg-scheme/docs', 'dsh-ccpg-scheme/AGENTS.md', 'dsh-ccpg-scheme/.superpowers']) {
    assert(rsyncBlock[0].includes(`--exclude '${path}`), `release rsync must exclude ${path}`);
  }
  const filterSource = join(temp, 'source');
  const filterOut = join(temp, 'out');
  mkdirSync(join(filterSource, 'dsh-ccpg-scheme/rules'), { recursive: true });
  mkdirSync(join(filterSource, 'dsh-ccpg-scheme/test'), { recursive: true });
  mkdirSync(join(filterSource, 'dsh-ccpg-scheme/tasks'), { recursive: true });
  mkdirSync(join(filterSource, 'dsh-ccpg-scheme/docs'), { recursive: true });
  mkdirSync(join(filterSource, 'dsh-ccpg-scheme/.superpowers/sdd'), { recursive: true });
  writeFileSync(join(filterSource, '.DS_Store'), 'metadata');
  writeFileSync(join(filterSource, 'dsh-ccpg-scheme/AGENTS.md'), 'developer rules');
  writeFileSync(join(filterSource, 'dsh-ccpg-scheme/rules/AGENTS.md'), 'runtime rules');
  for (const dir of ['src', 'scripts', 'authoring', 'test', 'tasks', 'docs', '.superpowers/sdd']) {
    mkdirSync(join(filterSource, `dsh-ccpg-scheme/${dir}`), { recursive: true });
    writeFileSync(join(filterSource, `dsh-ccpg-scheme/${dir}/note.md`), 'developer content');
  }
  for (const dir of ['lib', 'skills', 'vendor', 'licenses']) {
    mkdirSync(join(filterSource, `dsh-ccpg-scheme/${dir}`), { recursive: true });
    writeFileSync(join(filterSource, `dsh-ccpg-scheme/${dir}/runtime.js`), 'runtime');
  }
  mkdirSync(join(filterSource, 'dsh-ccpg-document-preview/src'), { recursive: true });
  writeFileSync(join(filterSource, 'dsh-ccpg-document-preview/src/host.js'), 'runtime');
  mkdirSync(filterOut, { recursive: true });
  writeFileSync(join(filterOut, 'keep.txt'), 'keep pack data');
  run('sh', ['-c', rsyncBlock[0]], { env: { ...process.env, HERE: filterSource, OUT: filterOut } });
  assert.equal(readFileSync(join(filterOut, 'keep.txt'), 'utf8'), 'keep pack data');
  assert(!existsSync(join(filterOut, 'dsh-plugins/.DS_Store')));
  for (const dir of ['src', 'scripts', 'authoring', 'test', 'tasks', 'docs', '.superpowers']) assert(!existsSync(join(filterOut, `dsh-plugins/dsh-ccpg-scheme/${dir}`)));
  for (const dir of ['lib', 'skills', 'vendor', 'licenses']) assert(existsSync(join(filterOut, `dsh-plugins/dsh-ccpg-scheme/${dir}/runtime.js`)));
  assert(existsSync(join(filterOut, 'dsh-plugins/dsh-ccpg-document-preview/src/host.js')));
  assert(!existsSync(join(filterOut, 'dsh-plugins/dsh-ccpg-scheme/AGENTS.md')));
  assert(existsSync(join(filterOut, 'dsh-plugins/dsh-ccpg-scheme/rules/AGENTS.md')));

  assert(!packScript.includes('rm -rf "$OUT" "$DIST_DIR"'), 'pack.sh must not erase caller output or prior releases');
  const distDir = join(temp, 'dist-release');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'keep.txt'), 'keep release data');
  assert.equal(readFileSync(join(distDir, 'keep.txt'), 'utf8'), 'keep release data');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('✓ release archive exclusions, SDK symlink boundary, and staging preservation');
