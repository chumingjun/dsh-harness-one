import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let client;
const storage = new Map();
const context = {
  window: {
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
    },
    __ModuleLoader__: {
      load({ factory }) {
        client = factory((name) => {
          if (name === 'react') return { createElement() {}, useRef() {}, useState() {}, useEffect() {} };
          throw new Error(`unexpected require: ${name}`);
        });
      },
    },
  },
  document: {},
  console,
  setInterval,
  clearInterval,
  setTimeout,
};
vm.runInNewContext(bundle, context, { filename: 'dsh-ccpg-canvasui/lib/client.js' });

assert.ok(client.inject.includes('sessions'));
assert.ok(client.inject.includes('conversationEvents'));

const definition = client.__test.workflowCommandInputDefinition();
const event = {
  type: 'command/run',
  seq: 4,
  time: 1,
  data: { commandId: 'cmd-1', name: 'workflow', args: '' },
};
assert.deepEqual({ ...definition.match(event) }, { id: 'cmd-1', role: 'start' });
assert.equal(definition.match({ ...event, data: { ...event.data, name: 'goal' } }), null);

const state = definition.start({}, { event });
const node = definition.buildViewNode({
  key: 'ccpg-workflow-open:cmd-1',
  id: 'cmd-1',
  state,
  start: { location: { kind: 'unresolved' } },
});
assert.equal(node.kind, 'ccpg-workflow-open');
assert.equal(node.visibility, 'visible');
assert.equal(client.__test.WorkflowCommandRow(), null);

assert.equal(client.__test.currentDshSessionId('blank-session'), 'blank-session');
storage.set('dsh.sessions.current', JSON.stringify({ sessionId: 'formal-session' }));
assert.equal(client.__test.currentDshSessionId('blank-session'), 'formal-session');
storage.set('dsh.sessions.current', '{invalid');
assert.equal(client.__test.currentDshSessionId('blank-session'), 'blank-session');

console.log('canvasui client tests: 2 passed');
