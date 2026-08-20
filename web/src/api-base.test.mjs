import assert from 'node:assert/strict';
import { resolveApiBase } from './api-base.js';

assert.equal(resolveApiBase({ injected: '/wf1', assetBase: '/', pathname: '/' }), '/wf1');
assert.equal(resolveApiBase({ injected: '/custom/', assetBase: '/wf1/', pathname: '/wf1/' }), '/custom');
assert.equal(resolveApiBase({ assetBase: '/wf1/', pathname: '/' }), '/wf1');
assert.equal(resolveApiBase({ assetBase: '/', pathname: '/wf1/' }), '/wf1');
assert.equal(resolveApiBase({ assetBase: '/', pathname: '/wf1/workflows/demo' }), '/wf1');
assert.equal(resolveApiBase({ assetBase: '/', pathname: '/' }), '');
assert.equal(resolveApiBase({ assetBase: '/', pathname: '/other' }), '');

console.log('api base tests: all pass');
