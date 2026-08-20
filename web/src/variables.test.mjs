import assert from 'node:assert/strict';

globalThis.window = {};

const {
  VARIABLE_MIME,
  buildFallbackSchema,
  describeVariables,
  flattenVariables,
  renderTemplatePreview,
  tokenForNode,
  validateTemplate,
  validateTemplateLocally,
  wrapToken,
} = await import('./variables.js');

const graph = {
  nodes: [
    { id: 'http-a', type: 'http', data: { label: 'HTTP 请求' } },
    { id: 'agent-b', type: 'agent', data: { label: '处理' } },
  ],
  edges: [{ source: 'http-a', target: 'agent-b' }],
};

assert.equal(VARIABLE_MIME, 'application/x-workflow-template-variable');
assert.equal(wrapToken(' node["http-a"].data.json.name '), '{{node["http-a"].data.json.name}}');
assert.equal(tokenForNode('http-a', ['json', 'x.y', 0, 'name']), 'node["http-a"].data.json["x.y"][0].name');

const schema = buildFallbackSchema({
  graph,
  targetNodeId: 'agent-b',
  upstreamPreviews: {
    'http-a': JSON.stringify({ customer: { name: '李女士' }, items: [{ name: '止水钳' }], 'x.y': { value: 1 }, a: { b: { c: { d: { e: { f: 'deep' } } } } } }),
  },
});
const tokens = new Set(flattenVariables(schema.items).map((item) => item.token));
assert.ok(tokens.has('node["http-a"].data.customer.name'));
assert.ok(tokens.has('node["http-a"].data.items[0].name'));
assert.ok(tokens.has('node["http-a"].data["x.y"].value'));
assert.ok(tokens.has('node["http-a"].data.a.b.c.d.e.f'));
assert.ok(tokens.has('$trigger'));
assert.ok(tokens.has('$upstream'));

assert.equal(validateTemplateLocally('{{node["http-a"].data.customer.name}}', schema.items).ok, true);
assert.equal(validateTemplateLocally('{{$trigger}}', schema.items).ok, true);
assert.equal(validateTemplateLocally('{{builtin.trigger}}', schema.items).ok, false);
assert.equal(validateTemplateLocally('{{node["other"].data.name}}', schema.items).ok, false);

const scopedSchema = [{
  id: 'group:scoped',
  label: '作用域变量',
  children: [
    { id: 'workflow:customer', label: 'customer', token: 'vars.workflow["customer"]', children: [] },
    { id: 'global:tenant', label: 'tenant', token: 'vars.global["tenant"]', children: [] },
    { id: 'input:ticket', label: 'ticket', token: 'inputs["ticket"]', children: [] },
  ],
}];
assert.equal(validateTemplateLocally('{{vars.workflow["customer"].profile.name}}', scopedSchema).ok, true);
assert.equal(validateTemplateLocally('{{vars.global["tenant"]["region-code"]}}', scopedSchema).ok, true);
assert.equal(validateTemplateLocally('{{inputs["ticket"].details[0].name}}', scopedSchema).ok, true);
assert.equal(validateTemplateLocally('{{vars.workflow["missing"].name}}', scopedSchema).ok, false);
assert.equal(validateTemplateLocally('{{inputs["ticketExtra"]}}', scopedSchema).ok, false);

const requestContext = {
  graph,
  targetNodeId: 'agent-b',
  workflowId: 'wf-1',
  runId: 'run-1',
  outputs: { 'http-a': 'ok' },
  structuredOutputs: { 'http-a': { type: 'json', value: { ok: true } } },
  nodeStates: { 'http-a': { status: 'success' } },
  triggerInput: 'legacy trigger',
  runInputs: { ticket: { id: 7 } },
  workflowVariables: [{ key: 'customer', value: { profile: { name: '李女士' } } }],
  inputSchema: { fields: [{ key: 'ticket', type: 'object' }] },
};
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, body: JSON.parse(options.body) });
  if (String(url).endsWith('/variables/describe')) return { ok: true, json: async () => ({ items: [] }) };
  if (String(url).endsWith('/template/validate')) return { ok: true, json: async () => ({ ok: true, issues: [] }) };
  return { ok: true, json: async () => ({ ok: true, text: 'rendered' }) };
};

await describeVariables(requestContext);
await validateTemplate('{{inputs["ticket"].id}}', requestContext);
await renderTemplatePreview('{{vars.workflow["customer"].profile.name}}', requestContext);
for (const request of requests) {
  assert.deepEqual(request.body.runInputs, requestContext.runInputs);
  assert.deepEqual(request.body.workflowVariables, requestContext.workflowVariables);
  assert.deepEqual(request.body.inputSchema, requestContext.inputSchema);
  assert.equal(request.body.triggerInput, requestContext.triggerInput);
}

console.log('variables frontend tests: all pass');
