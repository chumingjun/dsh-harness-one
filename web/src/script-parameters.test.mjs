import assert from 'node:assert/strict';

import {
  formatScriptConstant,
  normalizeScriptInputs,
  parseScriptConstant,
  validateScriptInputs,
} from './script-parameters.js';

assert.deepEqual(normalizeScriptInputs(null), []);
assert.deepEqual(normalizeScriptInputs([
  { name: 'source', expression: '{{node["input"].data}}', value: 3 },
  { name: 'limit', value: 3 },
  { name: 'enabled', value: false },
  { name: 'empty' },
]), [
  { name: 'source', expression: '{{node["input"].data}}' },
  { name: 'limit', value: 3 },
  { name: 'enabled', value: false },
  { name: 'empty', value: null },
]);

assert.deepEqual(validateScriptInputs([
  { name: '', value: null },
  { name: 'bad-name', value: null },
  { name: 'valid', value: null },
  { name: 'valid', expression: '{{$trigger}}' },
]), [
  '参数名不能为空',
  '参数名必须是有效的 JavaScript 标识符',
  '',
  '参数名与第 3 行重复',
]);

for (const value of [null, false, 12.5, 'text', [1, true], { nested: { ok: true } }]) {
  const parsed = parseScriptConstant(formatScriptConstant(value));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, value);
}
assert.equal(parseScriptConstant('{bad').ok, false);
assert.match(validateScriptInputs([{ name: '__proto__', value: 1 }])[0], /不安全/);
assert.match(validateScriptInputs([{ name: 'constructor', value: 1 }])[0], /不安全/);

console.log('script parameter frontend tests: all pass');
