import assert from 'node:assert/strict';
import { initialRunInputValues, serializeRunInputValues, validateRunInputValues } from './workflow-run-inputs.js';

const schema = { fields: [
  { key: 'name', type: 'string', required: true },
  { key: 'count', type: 'number', defaultValue: 2 },
  { key: 'enabled', type: 'boolean' },
  { key: 'tags', type: 'string[]' },
  { key: 'config', type: 'json' },
] };
assert.deepEqual(initialRunInputValues(schema), { count: 2 });
assert.equal(validateRunInputValues(schema, {}).ok, false);
assert.deepEqual(serializeRunInputValues(schema, { name: 'x', count: '3', enabled: true, tags: 'a\nb', config: '{"x":1}' }), { name: 'x', count: 3, enabled: true, tags: ['a', 'b'], config: { x: 1 }});
assert.equal(validateRunInputValues(schema, { name: 'x', extra: 1 }).ok, false);
assert.equal(validateRunInputValues({ fields: [{ name: 'mode', type: 'string', enum: ['a'] }] }, { mode: 'b' }).ok, false);
console.log('workflow run inputs tests: passed');
