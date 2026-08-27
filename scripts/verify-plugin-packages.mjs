import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginsDir = join(root, 'dsh-plugins');

// ---- 源码包契约：子插件目录仍是发布单元的源（assemble-one.sh 装配进单包）----
const sources = [
  'dsh-ccpg-tools',
  'dsh-ccpg-orchestrator',
  'dsh-ccpg-web',
  'dsh-ccpg-canvasui',
  'dsh-ccpg-document-preview',
  'dsh-ccpg-larkauth',
  'dsh-ccpg-llm-guard',
  'dsh-ccpg-brand',
];
const required = {
  'dsh-ccpg-web': ['web-dist/index.html'],
  'dsh-ccpg-canvasui': ['lib/client.js'],
  'dsh-ccpg-document-preview': ['dist/client.js', 'dist/react.js', 'dist/document-preview.css'],
  'dsh-ccpg-larkauth': ['lib/client.js', 'skills/feishu-cli.md'],
  'dsh-ccpg-brand': ['assets/logo.png', 'assets/icon.svg'],
};

for (const name of sources) {
  const dir = join(pluginsDir, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, name);
  assert.equal(pkg.private, false, `${name} must be publishable`);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.directory, `dsh-plugins/${name}`);
  assert.equal(pkg.engines?.node, name === 'dsh-ccpg-orchestrator' ? '>=22.15.0' : '>=20');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  for (const path of required[name] || []) {
    assert(existsSync(join(dir, path)), `${name} is missing ${path}`);
  }
  console.log(`✓ ${name}: source contract`);
}

// ---- 单包契约（dsh-harness-one，装配产物）----
const one = join(pluginsDir, 'dsh-harness-one');
assert(existsSync(join(one, 'package.json')), 'dsh-harness-one 未装配（先 sh assemble-one.sh）');
const onePkg = JSON.parse(readFileSync(join(one, 'package.json'), 'utf8'));
const trainVersion = JSON.parse(readFileSync(join(pluginsDir, 'dsh-ccpg-one', 'package.json'), 'utf8')).version;
assert.equal(onePkg.name, 'dsh-harness-one');
assert.equal(onePkg.version, trainVersion, '单包版本必须与 dsh-ccpg-one 版本列车对齐');
assert.equal(onePkg.private, false);
assert.equal(onePkg.license, 'MIT');
assert.equal(onePkg.engines?.node, '>=22.15.0');
assert.equal(onePkg.dsh?.bundle?.patch, './cordis.patch.yml');
assert.equal(onePkg.dsh?.client?.platform, 'web');
assert.equal(onePkg.exports?.['./client'], './lib/client.js');
assert.equal(onePkg.exports?.['./package.json'], './package.json', 'client-modules 按 <pkg>/package.json 解析，exports 必须暴露');
assert.match(onePkg.dependencies['dsh-better-sidebar'], /^\d+\.\d+\.\d+$/);
for (const dep of ['ajv', 'cron-parser', 'quickjs-emscripten']) {
  assert(onePkg.dependencies[dep], `runtime dep ${dep} must be declared (npm pack ships no node_modules)`);
}
assert(!Object.keys(onePkg.dependencies).some((name) => name.startsWith('dsh-ccpg-')), '单包不得再依赖老 8 包');

const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: one, encoding: 'utf8',
}));
const report = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
const files = new Set(report.files.map((file) => file.path));
for (const path of [
  'LICENSE', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js',
  'dsh-ccpg-web/web-dist/index.html',
  'dsh-ccpg-canvasui/lib/client.js',
  'dsh-ccpg-document-preview/dist/client.js',
]) {
  assert(files.has(path), `dsh-harness-one package is missing ${path}`);
}
// 合并 client 必须含 3 个 __ModuleLoader__ 工厂注册（canvasui/larkauth/preview）
const clientText = readFileSync(join(one, 'lib', 'client.js'), 'utf8');
const loads = (clientText.match(/window\.__ModuleLoader__\.load\s*\(/g) || []).length;
assert.equal(loads, 3, `merged client must register 3 factories, got ${loads}`);
console.log(`✓ dsh-harness-one: ${files.size} files (merged client: 3 factories)`);

console.log('plugin package contracts: ok');
