import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  WORKFLOW_EXPORT_VERSION,
  WORKFLOW_SCHEMA_VERSION,
  createWorkflowExportManifest,
  importWorkflowDocument,
  normalizeWorkflowDocument,
} from '../lib/workflow-document.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('workflow document tests:');

await test('legacy normalize adds v3 declarations without mutating source or graph', () => {
  const legacy = {
    id: 'wf_legacy',
    name: 'Legacy',
    graph: {
      nodes: [{ id: 'a', type: 'input', position: { x: 1, y: 2 }, data: { text: 'hello' } }],
      edges: [{ id: 'e1', source: 'a', target: 'b', custom: { preserved: true } }],
      viewport: { x: 4, y: 5, zoom: 1.2 },
    },
  };
  const before = structuredClone(legacy);
  const normalized = normalizeWorkflowDocument(legacy);

  assert.deepEqual(legacy, before);
  assert.strictEqual(normalized.graph, legacy.graph);
  assert.equal(normalized.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.deepEqual(normalized.variables, []);
  assert.deepEqual(normalized.inputSchema, { fields: [] });
  assert.deepEqual(normalized.dependencies, { globalVariables: [], credentials: [] });
});

await test('v3 document roundtrip preserves graph and declarations', () => {
  const document = normalizeWorkflowDocument({
    id: 'wf_v3',
    name: 'Roundtrip',
    updatedAt: '2026-08-18T00:00:00.000Z',
    graph: {
      nodes: [{ id: 'agent', type: 'agent', position: { x: 10, y: 20 }, data: { prompt: 'work' } }],
      edges: [],
      viewport: { x: 1, y: 2, zoom: 0.8 },
    },
    variables: [{ key: 'region', type: 'string', defaultValue: 'cn' }],
    inputSchema: { fields: [{ key: 'ticket', type: 'string', required: true }], title: 'Input' },
    dependencies: {
      globalVariables: ['tenant'],
      credentials: [{ key: 'feishu', type: 'oauth', provider: 'feishu', required: true }],
    },
  });

  const saved = JSON.parse(JSON.stringify(document));
  const normalized = normalizeWorkflowDocument(saved);
  assert.deepEqual(normalized, document);

  const manifest = createWorkflowExportManifest(document, { exportedAt: '2026-08-18T01:00:00.000Z' });
  const imported = importWorkflowDocument(manifest, {
    id: 'wf_imported',
    updatedAt: '2026-08-18T02:00:00.000Z',
  });
  assert.equal(manifest.version, WORKFLOW_EXPORT_VERSION);
  assert.equal(manifest.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.deepEqual(imported.graph, document.graph);
  assert.deepEqual(imported.variables, document.variables);
  assert.deepEqual(imported.inputSchema, document.inputSchema);
  assert.deepEqual(imported.dependencies.globalVariables, document.dependencies.globalVariables);
  assert.deepEqual(imported.dependencies.credentials, [{ key: 'feishu', type: 'oauth', provider: 'feishu', required: true, unresolved: true }]);
});

await test('export includes declarations but strips credential bindings and attachment storage/content', () => {
  const manifest = createWorkflowExportManifest({
    name: 'Safe export',
    graph: {
      nodes: [{
        id: 'input',
        type: 'input',
        data: {
          feishuCredId: 'cred_live_123',
          inputBindings: {
            account: {
              source: 'credential',
              key: 'feishu',
              credentialId: 'cred_nested_456',
              token: 'nested-secret-token',
            },
            evidence: {
              source: 'attachment',
              name: 'evidence',
              assetId: 'asset_nested_456',
              storageRef: 'objects/private/file',
              url: 'https://signed.example/nested',
            },
          },
          attachments: [{
            name: 'requirements',
            filename: 'secret-local-name.txt',
            path: '/private/data/file.txt',
            url: 'https://signed.example/file',
            mimeType: 'text/plain',
            size: 10,
            content: 'secret attachment contents',
          }],
        },
      }],
      edges: [],
    },
    dependencies: {
      globalVariables: ['tenant'],
      credentials: [{
        id: 'cred_live_123',
        key: 'feishu',
        name: 'Feishu account',
        type: 'oauth',
        provider: 'feishu',
        required: true,
        token: 'secret-token',
        appSecret: 'secret-value',
      }],
    },
  });

  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.graph.nodes[0].data.feishuCredId, undefined);
  assert.deepEqual(manifest.graph.nodes[0].data.inputBindings.account, {
    source: 'credential', key: 'feishu', unresolved: true,
  });
  assert.deepEqual(manifest.graph.nodes[0].data.inputBindings.evidence, {
    source: 'attachment', name: 'evidence', unresolved: true,
  });
  assert.deepEqual(manifest.graph.nodes[0].data.attachments, [{ name: 'requirements', mimeType: 'text/plain', size: 10 }]);
  assert.deepEqual(manifest.dependencies.credentials, [{ key: 'feishu', name: 'Feishu account', type: 'oauth', provider: 'feishu', required: true, unresolved: true }]);
  assert.doesNotMatch(serialized, /cred_live_123|cred_nested_456|asset_nested_456|secret-token|secret-value|secret attachment|private\/data|objects\/private|signed\.example|secret-local-name/);
});

await test('version 1 manifest and raw graph imports remain compatible', () => {
  const graph = {
    nodes: [{ id: 'a', type: 'input', data: { text: 'legacy' } }],
    edges: [],
  };
  const fromManifest = importWorkflowDocument({ kind: 'workflow-one', version: 1, name: 'V1', graph }, { id: 'wf_v1' });
  const fromRawGraph = importWorkflowDocument(graph, { id: 'wf_raw' });

  for (const imported of [fromManifest, fromRawGraph]) {
    assert.equal(imported.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.deepEqual(imported.graph, graph);
    assert.deepEqual(imported.variables, []);
    assert.deepEqual(imported.inputSchema, { fields: [] });
    assert.deepEqual(imported.dependencies, { globalVariables: [], credentials: [] });
  }
});

await test('future document and export versions fail closed', () => {
  assert.throws(
    () => normalizeWorkflowDocument({ schemaVersion: WORKFLOW_SCHEMA_VERSION + 1, graph: { nodes: [] } }),
    /不支持/,
  );
  assert.throws(
    () => importWorkflowDocument({ kind: 'workflow-one', version: WORKFLOW_EXPORT_VERSION + 1, graph: { nodes: [] } }),
    /不支持/,
  );
  assert.throws(
    () => importWorkflowDocument({ kind: 'workflow-one', version: 3, schemaVersion: WORKFLOW_SCHEMA_VERSION + 1, graph: { nodes: [] } }),
    /不支持/,
  );
});

await test('repository workflow examples are valid import documents', () => {
  const examples = new URL('../../../examples/workflows/', import.meta.url);
  const files = readdirSync(examples).filter((file) => file.endsWith('.workflow-one.json')).sort();
  assert.deepEqual(files, [
    'parallel-review.workflow-one.json',
    'repair-order.workflow-one.json',
    'urgency-routing.workflow-one.json',
  ]);
  for (const file of files) {
    const imported = importWorkflowDocument(JSON.parse(readFileSync(new URL(file, examples), 'utf8')));
    assert.ok(imported.name);
    assert.ok(imported.graph.nodes.length >= 3);
    const nodeIds = new Set(imported.graph.nodes.map((node) => node.id));
    for (const edge of imported.graph.edges) {
      assert.ok(nodeIds.has(edge.source), `${file}: missing source ${edge.source}`);
      assert.ok(nodeIds.has(edge.target), `${file}: missing target ${edge.target}`);
    }
  }
});

await test('workflow variables reject sensitive declarations and unsafe values before export', () => {
  assert.throws(
    () => normalizeWorkflowDocument({
      graph: { nodes: [], edges: [] },
      variables: [{ key: 'api_token', type: 'secret', value: 'hidden' }],
    }),
    /敏感变量类型/,
  );
  assert.throws(
    () => createWorkflowExportManifest({
      name: 'Unsafe',
      graph: { nodes: [], edges: [] },
      variables: [{ key: 'region', type: 'string', value: 'cn', sensitive: true }],
    }),
    /敏感变量字段/,
  );
  assert.throws(
    () => normalizeWorkflowDocument({
      graph: { nodes: [], edges: [] },
      variables: [{ key: 'limit', type: 'number', defaultValue: Number.POSITIVE_INFINITY }],
    }),
    /有限数字/,
  );
  assert.throws(
    () => createWorkflowExportManifest({
      name: 'Unsafe field',
      graph: { nodes: [], edges: [] },
      variables: [{ key: 'region', type: 'string', value: 'cn', credentialValue: 'hidden' }],
    }),
    /不支持字段 credentialValue/,
  );
});

console.log(`\n${passed} tests passed`);
