import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveArtifactsToWorkspace } from '../lib/artifact-save.js';

const root = mkdtempSync(join(tmpdir(), 'wf1-artifact-save-'));
try {
  const cwd = join(root, '项目');
  const source = join(root, 'source');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'report.md'), '# report');
  const run = { runId: 'run_1', workflowName: '消防巡检', startedAt: '2026-08-21T08:09:10.000Z' };
  const artifacts = [{ id: 'a1', name: '巡检报告.md' }];
  const resolveArtifact = () => ({ file: join(source, 'report.md') });

  const first = saveArtifactsToWorkspace({ cwd, run, artifacts, resolveArtifact });
  assert.deepEqual(first, { savedCount: 1, names: ['巡检报告.md'] });
  assert.equal(readFileSync(join(cwd, '工作流成果', '消防巡检', '2026-08-21 08-09-10', '巡检报告.md'), 'utf8'), '# report');

  const second = saveArtifactsToWorkspace({ cwd, run, artifacts, resolveArtifact });
  assert.deepEqual(second, { savedCount: 1, names: ['巡检报告 (2).md'] });
  assert.equal(readFileSync(join(cwd, '工作流成果', '消防巡检', '2026-08-21 08-09-10', '巡检报告 (2).md'), 'utf8'), '# report');

  assert.throws(() => saveArtifactsToWorkspace({ cwd: 'relative', run, artifacts, resolveArtifact }), /工作目录/);
  assert.throws(() => saveArtifactsToWorkspace({ cwd, run, artifacts: [], resolveArtifact }), /没有可保存/);
  console.log('artifact save tests: ALL PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
