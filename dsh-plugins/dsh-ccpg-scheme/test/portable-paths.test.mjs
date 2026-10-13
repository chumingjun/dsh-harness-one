import assert from 'node:assert/strict';
import { checkedPath, validateManifest } from '../lib/core.js';
import { cliEnvironment } from '../lib/ccpg-cli.js';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

assert.equal(cliEnvironment({ PATH: '/caller/bin', CCPG_CLI_BIN: '/caller/ccpg' }).PATH.split(delimiter).at(-1), '/caller/bin');
assert.equal(cliEnvironment({ Path: 'C:\\Caller\\bin' }, 'win32').PATH, 'C:\\Caller\\bin');
assert.equal(cliEnvironment({ PATH: 'C:\\Caller\\bin', Path: 'C:\\Other\\bin' }, 'win32').Path, undefined);
for (const path of ['C:\\outside.txt', 'D:/outside.txt', '\\\\server\\share\\file', '\\outside.txt']) {
  assert.throws(() => checkedPath(tmpdir(), path), /unsafe project path/);
}
assert.equal(checkedPath(tmpdir(), 'materials/input/file.md'), join(tmpdir(), 'materials/input/file.md'));
const definition = { schemaVersion: 1, id: 'portable', version: '1', chapters: [], resources: [] };
for (const path of ['C:\\outside.txt', 'D:/outside.txt', '\\\\server\\share\\file']) {
  assert.throws(() => validateManifest({ ...definition, resources: [{ path, sha256: 'a'.repeat(64) }] }), /unsafe resource/);
}
console.log('✓ portable CLI environment and cross-platform workspace path boundaries');
