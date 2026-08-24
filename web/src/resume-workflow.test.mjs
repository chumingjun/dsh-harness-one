import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.jsx'), 'utf8');

assert.match(app, /const latestRun = runs\.find/);
assert.match(app, /resumeCandidate = latestRun\?\.resumable/);
assert.doesNotMatch(app, /runId: resumeCandidate\.runId, graph:/);

console.log('resume workflow tests: passed');
