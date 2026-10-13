import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = process.env.ASSEMBLE_OUT || join(root, 'dsh-plugins/dsh-harness-one');
const require = createRequire(join(root, 'dsh-plugins/dsh-ccpg-scheme/package.json'));
const JSZip = require('jszip');
const base = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const version = process.argv[2] || `${base.version}-internal.portable`;
assert(/^\d+\.\d+\.\d+-internal\.[a-zA-Z0-9.-]+$/.test(version), 'use an internal prerelease version');
assert.equal(base.ccpg?.channel, 'internal', 'assemble the internal package first');
for (const name of Object.keys(base.dependencies)) assert(!/libreoffice-kit|@napi-rs\/canvas|sharp|koffi/.test(name), `native runtime dependency: ${name}`);
const report = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: source, encoding: 'utf8' }))[0];
const stage = await mkdtemp(join(tmpdir(), 'dsh-portable-pack-'));
const dist = join(root, 'dist-release');
await mkdir(dist, { recursive: true });
const npmPack = (cwd, args = []) => JSON.parse(execFileSync('npm', ['pack', ...args, '--ignore-scripts', '--json'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))[0];
try {
  const pkgRoot = join(stage, 'plugin'); await mkdir(pkgRoot);
  for (const { path } of report.files) {
    assert(!/(^|\/)(node_modules|tasks|test|tests|docs|\.superpowers|authoring|local-data)(\/|$)/.test(path), `developer content leaked: ${path}`);
    assert(!/\.(node|dylib|dll|exe|so|bak|map|tmp|orig)$|(^|\/)\.DS_Store$/.test(path), `non-delivery file leaked: ${path}`);
    assert(!/^dsh-ccpg-(brand|one)\//.test(path), `obsolete separate plugin leaked: ${path}`);
    assert(path !== 'bin/install.js', 'public registry installer must not ship in the internal delivery');
    const output = join(pkgRoot, path);
    await mkdir(join(output, '..'), { recursive: true });
    await cp(join(source, path), output, { dereference: true });
  }
  base.version = version;
  await writeFile(join(pkgRoot, 'package.json'), `${JSON.stringify(base, null, 2)}\n`);
  const packed = npmPack(pkgRoot);
  const sidebar = npmPack(stage, [`dsh-better-sidebar@${base.dependencies['dsh-better-sidebar']}`]);
  const files = [
    { file: packed.filename, bytes: await readFile(join(pkgRoot, packed.filename)) },
    { file: sidebar.filename, bytes: await readFile(join(stage, sidebar.filename)) },
  ];
  const delivery = {
    name: base.name, version, sidebarVersion: base.dependencies['dsh-better-sidebar'],
    packages: files.map(({ file, bytes }) => ({ file, sha256: createHash('sha256').update(bytes).digest('hex') })),
  };
  const zip = new JSZip();
  for (const { file, bytes } of files) zip.file(file, bytes);
  zip.file('delivery.json', `${JSON.stringify(delivery, null, 2)}\n`);
  zip.file('install.mjs', await readFile(join(root, 'dsh-plugins/install-internal.mjs')));
  zip.file('安装说明.md', await readFile(join(root, 'dsh-plugins/INTERNAL-INSTALL.md')));
  const archive = join(dist, `dsh-harness-one-${version}.zip`);
  await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const reopened = await JSZip.loadAsync(await readFile(archive));
  for (const { file, sha256 } of delivery.packages) assert.equal(createHash('sha256').update(await reopened.file(file).async('nodebuffer')).digest('hex'), sha256);
  await writeFile(join(dist, packed.filename), files[0].bytes);
  console.log(JSON.stringify({ archive, plugin: join(dist, basename(packed.filename)), version, files: packed.files.length, bytes: (await readFile(archive)).length }, null, 2));
} finally { await rm(stage, { recursive: true, force: true }); }
