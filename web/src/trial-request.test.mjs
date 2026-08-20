import assert from 'node:assert/strict';
import { trialRequestUrls } from './trial-request.js';

assert.deepEqual(trialRequestUrls('/wf1/api/node/test'), ['/wf1/api/node/test']);
assert.deepEqual(trialRequestUrls('/api/node/test'), [
  '/api/node/test',
  '/wf1/api/node/test',
]);
assert.deepEqual(trialRequestUrls('http://localhost:3080/api/node/test?x=1'), [
  'http://localhost:3080/api/node/test?x=1',
  'http://localhost:3080/wf1/api/node/test?x=1',
]);

console.log('trial request tests: all pass');
