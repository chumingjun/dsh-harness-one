import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('agent feishu prompt requires current user identity and no bot fallback', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8');
  const line = source.split('\n').find((item) => item.includes('飞书操作：本机装有 lark-cli'));
  assert.match(line, /--as user/);
  assert.match(line, /不要降级 --as bot|不降级 --as bot/);
  assert.doesNotMatch(line, /降级 --as bot 并/);
});
