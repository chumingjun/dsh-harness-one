import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerSchemeSkills } from '../lib/skills.js';

test('scheme uses native document reading and ships official Office content as a fallback', async () => {
  let provider; let disposed = false;
  const controller = new AbortController();
  const ctx = { skills: { registerProvider(create) { provider = create({ signal: controller.signal, invalidate() {} }); return () => { disposed = true; controller.abort(); }; } } };
  const dispose = registerSchemeSkills(ctx);
  assert.equal(typeof dispose, 'function');
  const candidates = await provider.list({});
  assert.deepEqual(candidates.map(({ name }) => name).sort(), ['ccpg-scheme', 'office-docx', 'office-pptx', 'office-xlsx', 'pdf']);
  const conversation = await provider.get(candidates.find(({ name }) => name === 'ccpg-scheme'), {});
  assert.match(conversation.content, /project quality plan/);
  assert.match(conversation.content, /Feishu list containing multiple links/);
  assert.match(conversation.content, /feishu_collect_materials/);
  assert.match(conversation.content, /do not ask for per-file confirmation/i);
  assert.match(conversation.content, /examples.*do not read or download/i);
  assert.match(conversation.content, /CCPG CLI/);
  assert.match(conversation.content, /references\/ccpg-cli\.md/);
  assert.match(conversation.content, /ccpg_project_find/);
  assert.match(conversation.content, /ccpg_project_fetch/);
  assert.match(conversation.content, /registered material or artifact id/i);
  assert.match(conversation.content, /do not inspect plugin source/i);
  assert.match(conversation.content, /material_complete/);
  assert.match(conversation.content, /same conversation.*draft/i);
  assert.match(conversation.content, /each completed section/i);
  assert.match(conversation.content, /bodyPath/);
  assert.match(conversation.content, /automatically registers and binds declared bundled knowledge/);
  assert.match(conversation.content, /Submission failure does not advance/);
  assert.match(conversation.content, /exact.*outputId/);
  assert.match(conversation.content, /file_path.*content/);
  assert.match(conversation.content, /scheme_validation_report/);
  assert.match(conversation.content, /scheme_feedback/);
  assert.match(conversation.content, /整理这次测试的问题/);
  assert.doesNotMatch(conversation.content, /fresh native.*subagent|material_visual_read/);
  for (const candidate of candidates) {
    if (candidate.name === 'ccpg-scheme') continue;
    const skill = await provider.get(candidate, {});
    assert.equal(skill.resourceBase.kind, 'directory');
    assert.match(skill.resourceBase.path, new RegExp(`/${candidate.name}$`));
    if (candidate.name.startsWith('office-')) {
      assert.ok(candidate.rank > 600, 'native bundled Office provider takes precedence');
      const upstream = await readFile(new URL(`../vendor/dsh-skill-office/assets/${candidate.name}/SKILL.md`, import.meta.url), 'utf8');
      assert.ok(skill.content.includes(upstream.slice(upstream.indexOf('\n---', 3) + 4).trim()));
      await readFile(join(skill.resourceBase.path, '../scripts/check_office.py'));
      assert.match(skill.content, /load_workspace_dependencies/);
    } else {
      assert.match(skill.content, /material_parse/);
      assert.match(skill.content, /material_complete/);
      assert.doesNotMatch(skill.content, /fresh native.*subagent|material_visual_read|brew install|pip install|pdftoppm/);
    }
  }
  assert.match((await provider.get(candidates.find(({ name }) => name === 'pdf'), {})).content, /text-only PDF/);
  assert.match((await provider.get(candidates.find(({ name }) => name === 'pdf'), {})).content, /only.*necessary/i);
  dispose();
  assert.equal(disposed, true);
  await assert.rejects(provider.list({}), /disposed/i);
});

test('vendor source manifest records upstream commit, package version, and applicable licenses', async () => {
  const manifest = JSON.parse(await readFile(new URL('../vendor/SOURCES.json', import.meta.url), 'utf8'));
  assert.equal(manifest.sources.office.version, '0.2.0-rc.2');
  assert.equal(manifest.sources.office.license, 'MIT');
  assert.equal(manifest.sources.pdf.commit, '49f948faa9258a0c61caceaf225e179651397431');
  assert.equal(manifest.sources.pdf.license, 'Apache-2.0');
  await readFile(new URL('../vendor/dsh-skill-office/LICENSE', import.meta.url));
  await readFile(new URL('../vendor/openai-skills/pdf/LICENSE.txt', import.meta.url));
});

test('installed chapter 7 rules define an executable generic body contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rules/manifest.json', import.meta.url), 'utf8'));
  const chapter = manifest.chapters.find(({ id }) => id === 'chapter-7');
  assert.equal(chapter.outputDefinitionSource.kind, 'internal-supplement');
  assert.deepEqual(chapter.outputs, [{ id: '7', name: '要求的管理与变更控制', kind: 'body', template: '要求的管理与变更控制（本技能正文结构）', sourceRows: [], dependencies: [] }]);
  assert.ok(!chapter.blockers.some(({ code }) => code === 'OUTPUT_DEFINITION_MISSING'));
  assert.ok(!manifest.blockers.some(({ code, message }) => code === 'OUTPUT_DEFINITION_MISSING' && /7/.test(message)));
  const skill = await readFile(new URL('../rules/skills/ccpg-chapter-7/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /要求识别清单/);
  assert.match(skill, /内部测试补充定义/);
  assert.doesNotMatch(skill, /OUTPUT_DEFINITION_MISSING|不得生成正文/);
});
