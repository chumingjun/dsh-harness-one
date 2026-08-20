import assert from 'node:assert/strict';
import {
  StructuredOutputError,
  createStructuredEnvelope,
  extractJsonValue,
  getAgentOutputConfig,
  readableStructuredOutput,
  structuredRepairPrompt,
  validateStructuredOutput,
  validateStructuredOutputWithRepair,
} from '../lib/agent-schema.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '标题' },
    score: { type: 'number' },
    approved: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['open', 'closed'] },
    detail: {
      type: 'object',
      properties: { owner: { type: 'string' } },
      required: ['owner'],
      additionalProperties: false,
    },
  },
  required: ['title', 'score', 'approved', 'status', 'detail'],
  additionalProperties: false,
};

console.log('agent schema tests:');

await test('文本模式保持默认兼容', () => {
  assert.deepEqual(getAgentOutputConfig({}), { mode: 'text', schema: null });
});

await test('结构化模式可解析 JSON Schema 文本', () => {
  const config = getAgentOutputConfig({ outputMode: 'structured', outputSchema: JSON.stringify(schema) });
  assert.equal(config.mode, 'structured');
  assert.deepEqual(config.schema, schema);
});

await test('无效 Schema 配置在执行前失败', () => {
  assert.throws(
    () => getAgentOutputConfig({ outputMode: 'structured', outputSchema: '{bad' }),
    (error) => error instanceof StructuredOutputError && error.details.kind === 'schema',
  );
});

await test('从 Markdown 代码块和说明文字中提取 JSON', () => {
  const fenced = extractJsonValue('结果如下：\n```json\n{"ok":true}\n```');
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.value, { ok: true });

  const embedded = extractJsonValue('前缀 [1,{"x":"}"}] 后缀');
  assert.equal(embedded.ok, true);
  assert.deepEqual(embedded.value, [1, { x: '}' }]);
});

await test('Ajv 校验通过并生成结构化 envelope', () => {
  const raw = JSON.stringify({
    title: '漏水工单', score: 9.5, approved: true, tags: ['urgent'], status: 'open', detail: { owner: 'A' },
  });
  const result = validateStructuredOutput(raw, schema);
  const envelope = createStructuredEnvelope(result, { schema });
  assert.equal(envelope.version, 1);
  assert.equal(envelope.type, 'json');
  assert.equal(envelope.mediaType, 'application/json');
  assert.equal(envelope.value.title, '漏水工单');
  assert.deepEqual(envelope.schema, schema);
  assert.equal(readableStructuredOutput(envelope.value), JSON.stringify(envelope.value, null, 2));
});

await test('Ajv 返回 required、enum 和类型错误', () => {
  assert.throws(
    () => validateStructuredOutput('{"title":2,"score":"high","approved":true,"status":"bad","detail":{}}', schema),
    (error) => {
      assert.ok(error instanceof StructuredOutputError);
      assert.equal(error.details.kind, 'validation');
      const joined = error.details.errors.join('\n');
      assert.match(joined, /must be string/);
      assert.match(joined, /allowed values/);
      assert.match(joined, /owner/);
      return true;
    },
  );
});

await test('修复提示包含校验问题、Schema 和原始输出', () => {
  const prompt = structuredRepairPrompt({ schema, raw: '{"title":2}', errors: ['/title must be string'] });
  assert.match(prompt, /修复后重新返回/);
  assert.match(prompt, /must be string/);
  assert.match(prompt, /"required"/);
  assert.match(prompt, /\{"title":2\}/);
});

await test('校验失败时只调用一次修复并返回修复结果', async () => {
  let repairs = 0;
  const valid = JSON.stringify({
    title: '修复后', score: 8, approved: false, status: 'closed', detail: { owner: 'B' },
  });
  const output = await validateStructuredOutputWithRepair('{"title":2}', schema, async (prompt, firstError) => {
    repairs += 1;
    assert.ok(firstError instanceof StructuredOutputError);
    assert.match(prompt, /上一条回复/);
    return valid;
  });
  assert.equal(repairs, 1);
  assert.equal(output.repaired, true);
  assert.equal(output.result.data.title, '修复后');
});

await test('第二次仍失败时不再重试', async () => {
  let repairs = 0;
  await assert.rejects(
    validateStructuredOutputWithRepair('不是 JSON', schema, async () => {
      repairs += 1;
      return '{"title":2}';
    }),
    StructuredOutputError,
  );
  assert.equal(repairs, 1);
});

if (!process.exitCode) console.log(`\n${passed} tests passed`);
