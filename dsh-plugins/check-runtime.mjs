#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.ccpg?.scheme, true, 'internal scheme package is required');
for (const name of Object.keys(manifest.dependencies)) assert(!/libreoffice-kit|@napi-rs\/canvas|sharp|koffi/.test(name), `native dependency forbidden: ${name}`);
for (const path of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'dsh-ccpg-scheme/skills/ccpg-scheme/SKILL.md']) await readFile(join(root, path));
const rules = JSON.parse(await readFile(join(root, 'dsh-ccpg-scheme/rules/manifest.json'), 'utf8'));
assert(rules.chapters.length > 0);
const { validateManifest } = await import(pathToFileURL(join(root, 'dsh-ccpg-scheme/lib/core.js')));
validateManifest(rules, { rulesRoot: join(root, 'dsh-ccpg-scheme/rules') });
const { PDFiumLibrary } = await import(pathToFileURL(require.resolve('@hyzyla/pdfium')));
const library = await PDFiumLibrary.init();
library.destroy();
const { createWordDocument } = await import(pathToFileURL(join(root, 'dsh-ccpg-scheme/lib/word.js')));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const bytes = await createWordDocument({ markdown: '# Runtime check\n\n![image](check.png)', assets: [{ path: 'check.png', mime: 'image/png', base64: png }] });
assert.equal(bytes.subarray(0, 2).toString(), 'PK');
console.log(JSON.stringify({ ready: true, version: manifest.version, chapters: rules.chapters.length, nativeDependencies: false, platform: process.platform, arch: process.arch }));
