import assert from 'node:assert/strict';
import { Orchestrator } from '../lib/engine.js';
import { createOutputEnvelope } from '../lib/output-contract.js';

const renderTemplate = (template) => ({ text: String(template || ''), missing: [], used: [] });
const orchestrator = new Orchestrator(null, { renderTemplate });

orchestrator.nodeRunner = async () => ({
  output: '{\n  "ticketId": "T-100"\n}',
  structuredOutput: createOutputEnvelope({ ticketId: 'T-100' }, {
    type: 'json',
    mediaType: 'application/json',
    schema: {
      type: 'object',
      properties: { ticketId: { type: 'string' } },
      required: ['ticketId'],
    },
  }),
  structuredMeta: { repaired: true, validationErrors: [] },
});

const run = await orchestrator.run({
  nodes: [{ id: 'agent', type: 'agent', data: { label: '工单智能体' } }],
  edges: [],
});

assert.equal(run.status, 'success');
assert.equal(run.outputs.agent, '{\n  "ticketId": "T-100"\n}');
assert.deepEqual(run.structuredOutputs.agent.value, { ticketId: 'T-100' });
assert.equal(run.structuredOutputs.agent.type, 'json');
assert.equal(run.nodeStates.agent.structuredMeta.repaired, true);
console.log('agent structured engine test: ✓ readable output and structured envelope persisted');
