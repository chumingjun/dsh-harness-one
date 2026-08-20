import assert from 'node:assert/strict';

globalThis.window = {};

const {
  createGlobalVariable,
  deleteGlobalVariable,
  draftToVariable,
  GlobalVariableApiError,
  loadGlobalVariables,
  parseEditorValue,
  updateGlobalVariable,
  valueToEditorText,
  variableToDraft,
  variableToken,
} = await import('./global-variables.js');

assert.equal(variableToken('sla'), 'vars.global["sla"]');
assert.equal(variableToken('sla', 'workflow'), 'vars.workflow["sla"]');
assert.equal(variableToken('ticket', 'input'), 'inputs["ticket"]');

assert.equal(parseEditorValue('string', ''), '');
assert.equal(parseEditorValue('number', '0'), 0);
assert.equal(parseEditorValue('boolean', 'false'), false);
assert.deepEqual(parseEditorValue('json', '{"ok":false,"count":0}'), { ok: false, count: 0 });
assert.deepEqual(parseEditorValue('string[]', ' first\n\nsecond '), ['first', 'second']);
assert.throws(() => parseEditorValue('number', ''), /请输入数字/);
assert.throws(() => parseEditorValue('number', 'Infinity'), /有限数字/);
assert.throws(() => parseEditorValue('json', '{bad'), /JSON 格式错误/);

assert.equal(valueToEditorText('boolean', false), 'false');
assert.equal(valueToEditorText('number', 0), '0');
assert.equal(valueToEditorText('string', ''), '');
assert.equal(valueToEditorText('string[]', ['a', 'b']), 'a\nb');
assert.match(valueToEditorText('json', { nested: { ok: true } }), /"nested"/);

assert.deepEqual(variableToDraft({ key: 'enabled', label: 'Enabled', type: 'boolean', value: false }), {
  key: 'enabled', label: 'Enabled', type: 'boolean', description: '', valueText: 'false',
});
assert.deepEqual(draftToVariable({ key: ' limit ', label: ' Limit ', type: 'number', description: ' minutes ', valueText: '15' }), {
  key: 'limit', label: 'Limit', type: 'number', description: 'minutes', value: 15,
});
assert.throws(() => draftToVariable({ key: 'bad key', type: 'string', valueText: 'x' }), /Key/);

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ version: 1, revision: calls.length, variables: [], variable: { id: 'var_1', key: 'sla', type: 'number', value: 15 } }),
  };
};

await loadGlobalVariables();
await createGlobalVariable({ key: 'sla', type: 'number', value: 15 }, 0);
await updateGlobalVariable('var_1', { key: 'sla', type: 'number', value: 20 }, 1);
await deleteGlobalVariable('var_1', 2);
assert.equal(calls[0].options.method, undefined);
assert.deepEqual(JSON.parse(calls[1].options.body), { expectedRevision: 0, variable: { key: 'sla', type: 'number', value: 15 } });
assert.deepEqual(JSON.parse(calls[2].options.body), { id: 'var_1', expectedRevision: 1, changes: { key: 'sla', type: 'number', value: 20 } });
assert.deepEqual(JSON.parse(calls[3].options.body), { id: 'var_1', expectedRevision: 2 });

fetch = async () => ({
  ok: false,
  status: 409,
  text: async () => JSON.stringify({ error: '版本冲突', code: 'revision-conflict' }),
});
await assert.rejects(
  () => createGlobalVariable({ key: 'x', type: 'string', value: '' }, 0),
  (error) => error instanceof GlobalVariableApiError && error.status === 409 && error.code === 'revision-conflict',
);

console.log('global variable frontend tests: all pass');
