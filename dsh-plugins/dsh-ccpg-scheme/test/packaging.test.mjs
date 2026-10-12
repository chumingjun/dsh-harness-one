import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const schemeDir = join(root, 'dsh-plugins/dsh-ccpg-scheme');
const defaultRules = JSON.parse(readFileSync(join(schemeDir, 'rules/manifest.json'), 'utf8'));
assert.equal(existsSync(join(schemeDir, 'rules/rules')), false, 'compiled rules must be installed at the runtime root, not nested');
assert.equal(defaultRules.chapters.length, 15);
for (const chapter of defaultRules.chapters) assert(existsSync(join(schemeDir, 'rules', chapter.skill)), `default chapter skill missing: ${chapter.id}`);
assert.match(readFileSync(join(schemeDir, 'rules/AGENTS.md'), 'utf8'), /scheme_validation_report/, 'default rules must include the implemented local report entry');
const assembly = readFileSync(join(root, 'dsh-plugins/assemble-one.sh'), 'utf8');
assert.match(assembly, /Object\.assign\(pkg\.dependencies, JSON\.parse\(fs\.readFileSync/, 'aggregate must read canonical runtime dependency manifest');
const schemeManifest = JSON.parse(readFileSync(join(schemeDir, 'package.json'), 'utf8'));
for (const name of Object.keys(schemeManifest.dependencies)) assert(!/libreoffice-kit|@napi-rs\/canvas|koffi|sharp/.test(name), `native dependency leaked: ${name}`);
const copyBlock = assembly.match(/for p in \$PLUGINS; do\n[\s\S]*?\ndone/);
assert(copyBlock, 'aggregate runtime copy block must exist');
const fixture = mkdtempSync(join(tmpdir(), 'ccpg-aggregate-test-'));
try {
  const source = join(fixture, 'source');
  const output = join(fixture, 'output');
  for (const plugin of ['dsh-ccpg-scheme', 'dsh-ccpg-document-preview']) {
    mkdirSync(join(source, plugin), { recursive: true });
    writeFileSync(join(source, plugin, 'package.json'), '{}');
    for (const dir of ['lib', 'src', 'scripts', 'authoring', 'rules', 'skills', 'vendor', 'licenses', 'test', 'tasks', 'docs', 'web-dist']) {
      mkdirSync(join(source, plugin, dir), { recursive: true });
      writeFileSync(join(source, plugin, dir, 'sentinel'), dir);
    }
    writeFileSync(join(source, plugin, 'AGENTS.md'), 'developer');
    writeFileSync(join(source, plugin, 'rules/AGENTS.md'), 'runtime');
    writeFileSync(join(source, plugin, 'lib/client.js'), 'compiled');
  }
  for (const file of ['host.js', 'index.js', 'markdown-compat.mjs', 'markdown-sanitize.mjs']) {
    writeFileSync(join(source, 'dsh-ccpg-document-preview/src', file), 'runtime');
  }
  execFileSync('sh', ['-c', copyBlock[0]], {
    env: { ...process.env, HERE: source, OUT: output, PLUGINS: 'dsh-ccpg-scheme dsh-ccpg-document-preview' },
  });
  for (const dir of ['src', 'scripts', 'authoring', 'test', 'tasks', 'docs']) assert(!existsSync(join(output, 'dsh-ccpg-scheme', dir)), `aggregate must exclude scheme ${dir}`);
  assert(!existsSync(join(output, 'dsh-ccpg-scheme/AGENTS.md')));
  for (const path of ['lib/client.js', 'rules/AGENTS.md', 'skills/sentinel', 'vendor/sentinel', 'licenses/sentinel']) assert(existsSync(join(output, 'dsh-ccpg-scheme', path)), `aggregate must retain ${path}`);
  assert(!existsSync(join(output, 'dsh-ccpg-document-preview/src/sentinel')), 'unlisted preview source must not ship');
  for (const file of ['host.js', 'index.js', 'markdown-compat.mjs', 'markdown-sanitize.mjs']) {
    assert(existsSync(join(output, 'dsh-ccpg-document-preview/src', file)), `preview runtime missing ${file}`);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
execFileSync('sh', [join(root, 'dsh-plugins/build-scheme.sh')], { stdio: 'pipe' });

const packFiles = (cwd) => {
  const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd, encoding: 'utf8' }));
  return new Set(result[0].files.map(({ path }) => path));
};

const schemeFiles = packFiles(schemeDir);
for (const path of ['LICENSE', 'cordis.patch.yml', 'lib/client.js', 'lib/index.js', 'lib/material-collection.js', 'vendor/']) {
  assert([...schemeFiles].some((file) => file === path || file.startsWith(path)), `scheme package missing ${path}`);
}
for (const path of [...schemeFiles]) {
  assert(!/^(src|scripts|authoring)(\/|$)/.test(path), `build-time content leaked into scheme package: ${path}`);
  assert(!/(^|\/)(test|tests|tasks|docs|\.superpowers|node_modules)(\/|$)/.test(path), `developer content leaked into scheme package: ${path}`);
  assert(!path.startsWith('/'), `absolute path leaked into scheme package: ${path}`);
}
const manifest = JSON.parse(readFileSync(join(schemeDir, 'package.json'), 'utf8'));
assert.equal(manifest.private, true, 'scheme standalone package must not publish');
assert.equal(manifest.engines.node, '>=22.19.0');
assert(manifest.exports?.['./client'], 'scheme client entry must be exported');
assert.equal(manifest.dependencies['@hyzyla/pdfium'], '3.0.0');
for (const dir of ['rules', 'skills', 'vendor']) {
  assert(manifest.files.some((path) => path === dir || path.startsWith(`${dir}/`)), `scheme manifest must package ${dir}`);
}
const lock = readFileSync(join(schemeDir, 'package-lock.json'), 'utf8');
assert(!/\/private\/|\/Users\/|\/opt\/homebrew\//.test(lock), 'scheme lock must not contain machine paths');
console.log(`✓ scheme package contract (${schemeFiles.size} npm files)`);
