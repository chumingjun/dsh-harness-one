import assert from 'node:assert/strict';
import { parseJsonResponseText } from './json-response.js';

assert.deepEqual(parseJsonResponseText('{"ok":true}', {
  status: 200,
  contentType: 'application/json; charset=utf-8',
  url: '/wf1/api/node/test',
}), { ok: true });

assert.throws(() => parseJsonResponseText('<!DOCTYPE html><html></html>', {
  status: 200,
  contentType: 'text/html; charset=utf-8',
  url: '/api/node/test',
}), /返回了网页而不是 JSON.*\/api\/node\/test/);

assert.throws(() => parseJsonResponseText('', { status: 503 }), /空响应.*503/);
assert.throws(() => parseJsonResponseText('not-json', { status: 502 }), /无效 JSON.*502/);

console.log('json response tests: all pass');
