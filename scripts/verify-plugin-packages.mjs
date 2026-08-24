import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginsDir = join(root, 'dsh-plugins');
const packages = [
  'dsh-ccpg-tools',
  'dsh-ccpg-orchestrator',
  'dsh-ccpg-web',
  'dsh-ccpg-canvasui',
  'dsh-ccpg-document-preview',
  'dsh-ccpg-larkauth',
  'dsh-ccpg-llm-guard',
  'dsh-ccpg-one',
  'dsh-ccpg-brand',
];
const required = {
  'dsh-ccpg-web': ['web-dist/index.html'],
  'dsh-ccpg-canvasui': ['lib/client.js'],
  'dsh-ccpg-document-preview': ['dist/client.js', 'dist/react.js', 'dist/document-preview.css'],
  'dsh-ccpg-larkauth': ['lib/client.js', 'skills/feishu-cli.md'],
  'dsh-ccpg-brand': ['assets/logo.png', 'assets/icon.svg'],
};

for (const name of packages) {
  const dir = join(pluginsDir, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, name);
  assert.equal(pkg.private, false, `${name} must be publishable`);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.directory, `dsh-plugins/${name}`);
  assert.equal(pkg.engines?.node, '>=20');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');

  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: dir,
    encoding: 'utf8',
  }));
  const report = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const files = new Set(report.files.map((file) => file.path));
  for (const path of ['LICENSE', 'cordis.patch.yml', ...(required[name] || [])]) {
    assert(files.has(path), `${name} package is missing ${path}`);
  }
  console.log(`✓ ${name}: ${files.size} files`);
}

const aggregate = JSON.parse(readFileSync(join(pluginsDir, 'dsh-ccpg-one', 'package.json'), 'utf8'));
for (const name of packages.filter((name) => name !== 'dsh-ccpg-one' && name !== 'dsh-ccpg-brand')) {
  assert.equal(aggregate.dependencies[name], aggregate.version, `${name} must match aggregate version`);
}
assert.match(aggregate.dependencies['dsh-better-sidebar'], /^\d+\.\d+\.\d+$/);
assert(!Object.values(aggregate.dependencies).some((version) => String(version).startsWith('file:')));
console.log('plugin package contracts: ok');
