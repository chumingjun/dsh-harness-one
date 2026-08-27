// workflow-one 技能种子单测：写入/幂等/不覆盖用户文件/带标记升级，DSH_HOME 隔离不碰真实 ~/.dsh。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dshHome = mkdtempSync(join(tmpdir(), 'wf1-skill-home-'));
const originalDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;
const target = join(dshHome, 'skills', 'workflow-one.md');

try {
  const { ensureWorkflowSkill } = await import('../lib/skill-seed.js');
  const bundled = readFileSync(new URL('../skills/workflow-one.md', import.meta.url), 'utf8');
  const marker = 'managed-by: dsh-ccpg-orchestrator';

  // 首次：写入
  assert.equal(ensureWorkflowSkill(), target);
  assert.equal(readFileSync(target, 'utf8'), bundled);

  // 幂等：内容相同不再写
  assert.equal(ensureWorkflowSkill(), null);
  assert.equal(readFileSync(target, 'utf8'), bundled);

  // 用户改过（无标记）：不覆盖
  const userVersion = '---\nname: workflow-one\n---\n用户自己的内容\n';
  writeFileSync(target, userVersion);
  assert.equal(ensureWorkflowSkill(), null);
  assert.equal(readFileSync(target, 'utf8'), userVersion);

  // 带标记的旧内容：升级为当前版本
  writeFileSync(target, `<!-- ${marker} v0 -->\n旧版正文\n`);
  assert.equal(ensureWorkflowSkill(), target);
  assert.equal(readFileSync(target, 'utf8'), bundled);

  console.log('skill-seed: ok');
} finally {
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
}
