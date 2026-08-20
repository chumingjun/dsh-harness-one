import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalVariableStore, VariableStoreError } from '../lib/variable-store.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack || error.message}`); process.exitCode = 1; }
}

console.log('variable store tests:');

await test('read does not create file; mutation writes 0600 revisioned document', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wf1-vars-')), 'global-variables.json');
  const store = new GlobalVariableStore(file);
  assert.deepEqual(store.read(), { version: 1, revision: 0, variables: [] });
  assert.equal(existsSync(file), false);
  const added = store.add({ key: 'region', label: 'Region', type: 'string', value: '' });
  assert.equal(added.document.revision, 1);
  assert.equal(added.variable.revision, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

await test('revision conflicts and sensitive declarations are rejected', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wf1-vars-')), 'global-variables.json');
  const store = new GlobalVariableStore(file);
  store.add({ key: 'enabled', type: 'boolean', value: false });
  assert.throws(() => store.add({ key: 'region', type: 'string', value: 'cn' }, { expectedRevision: 0 }), (error) => error instanceof VariableStoreError && error.status === 409);
  assert.throws(() => store.update({ key: 'enabled' }, { value: true }, { expectedRevision: 0 }), (error) => error instanceof VariableStoreError && error.status === 409);
  assert.throws(() => store.add({ key: 'token', type: 'secret', value: 'x' }), /敏感变量类型/);
  assert.throws(() => store.add({ key: 'password', type: 'string', value: 'x', sensitive: true }), /敏感变量字段/);
  assert.throws(() => store.add({ key: '__proto__', type: 'json', value: {} }), /安全的 ASCII/);
});

await test('changing type replaces incompatible values instead of retaining old defaults', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wf1-vars-')), 'global-variables.json');
  const store = new GlobalVariableStore(file);
  const added = store.add({ key: 'limit', type: 'number', defaultValue: 15 });
  const updated = store.update({ key: 'limit' }, { type: 'string', value: 'fifteen' }, { expectedRevision: added.document.revision });
  assert.equal(updated.variable.type, 'string');
  assert.equal(updated.variable.value, 'fifteen');
  assert.equal(Object.prototype.hasOwnProperty.call(updated.variable, 'defaultValue'), false);
});

await test('stable keys cannot be changed through generic updates', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wf1-vars-')), 'global-variables.json');
  const store = new GlobalVariableStore(file);
  const added = store.add({ key: 'region', type: 'string', value: 'north' });
  assert.throws(
    () => store.update(
      { id: added.variable.id },
      { key: 'area' },
      { expectedRevision: added.document.revision },
    ),
    (error) => error instanceof VariableStoreError
      && error.code === 'variable-key-immutable'
      && error.status === 409,
  );
});

console.log(process.exitCode ? `${passed} tests passed with failures` : `ALL PASS (${passed})`);
