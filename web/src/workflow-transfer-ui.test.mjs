import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./WorkflowList.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

assert.doesNotMatch(source, /data\?\.graph\?\.nodes/);
assert.match(source, /if \(!res\.ok\)/);
assert.match(source, /URL\.createObjectURL\(await res\.blob\(\)\)/);
assert.match(source, /await onOpen\?\.\(out\)/);
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.wf-list-head \{ flex-wrap: wrap; \}[\s\S]*\.wf-list-head \.btn \{ white-space: nowrap; \}/);
assert.match(source, /onStartRun/);
assert.match(source, /onCancelRun/);
assert.match(source, /wf-live-run/);
assert.match(source, /RunWorkflowModal/);

console.log('workflow transfer UI tests: passed');
