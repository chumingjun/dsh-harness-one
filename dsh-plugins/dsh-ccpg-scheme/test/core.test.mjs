import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, mkdir, writeFile, readFile, symlink, stat, unlink, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  SchemeStore, validateManifest, createProject, registerMaterial,
  prepareChapter, submitChapter, editChapter, confirmChapter, recoverProject,
  exportProject, exportDelivery, createDeliverySnapshot, indexMaterialDirectory, registerIndexedMaterial, replaceChapterRules, projectSnapshot, readChapterArtifact, skipChapter, updateMaterialReadingInstructions,
} from '../lib/core.js';
import { MATERIAL_READING_RULE, LEGACY_MATERIAL_READING_RULES } from '../lib/material-reading.js';
import { MATERIAL_PARSER_VERSION } from '../lib/materials.js';

const manifest = (extra = {}) => ({
  schemaVersion: 1, id: 'demo', version: '1.0.0', title: 'Demo',
  chapters: [
    { id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [{ id: 'brief', name: 'brief', required: true }], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] },
    { id: 'two', title: 'Two', order: 2, skill: 'skills/two/SKILL.md', dependencies: ['one'], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] },
  ], resources: [], dataMappings: {}, ...extra,
});

test('internal generation notes are excluded from saved bodies, Markdown attachments and all delivery paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-clean-body-')); const rules = join(base, 'rules'); const cwd = join(base, 'project');
  await mkdir(cwd); await mkdir(join(rules, 'skills/one'), { recursive: true });
  await writeFile(join(rules, 'skills/one/SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const definition = manifest(); definition.chapters = [definition.chapters[0]];
  definition.chapters[0].outputs.push({ id: 'table', name: 'Table', kind: 'attachment' });
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(definition));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'facts' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  const attachments = Object.freeze([Object.freeze({ outputId: 'table', name: '目标.md', content: '本表基于输入材料生成。\n\n|目标|值|\n|---|---|\n|满意度|95%|' })]);
  await submitChapter(store, { token: ready.token, body: '# 正文\n\n> 本章依据 IN-001 输入材料编制。\n\n依据有效合同，提供约定服务。',
    attachments });
  assert.match(attachments[0].content, /基于输入材料/);
  const artifact = await readChapterArtifact(store, 'one');
  assert.doesNotMatch(artifact.body, /输入材料|IN-001/);
  assert.match(artifact.body, /依据有效合同/);
  assert.doesNotMatch(artifact.attachments[0].content, /基于输入材料/);
  assert.match(artifact.attachments[0].content, /\|满意度\|95%\|/);
  assert.doesNotMatch(await exportProject(store), /输入材料/);
  const delivery = await createDeliverySnapshot(store);
  assert.doesNotMatch(await readFile(delivery.artifactPath, 'utf8'), /输入材料/);
  assert.doesNotMatch(await readFile(join(cwd, delivery.directory, delivery.attachments[0].path), 'utf8'), /输入材料/);
  assert.equal(delivery.wordPath, undefined);
  const exported = await createDeliverySnapshot(store, { word: true });
  assert.match(exported.wordPath, /完整方案\.docx$/);
  assert.deepEqual(await readFile(exported.wordPath), Buffer.from(exported.base64, 'base64'));
  assert.ok(exported.files.some((item) => item.path === '完整方案.docx'));
  const repeated = await createDeliverySnapshot(store, { word: true });
  assert.equal(repeated.directory, exported.directory);
  assert.equal(repeated.base64, exported.base64);
  const otherWindow = SchemeStore.load(cwd); const reload = store.reload.bind(store);
  let reads = 0;
  store.reload = () => { reads++; return reload(); };
  await exportDelivery(store, { requireComplete: true });
  const deliveryReads = reads; reads = 0;
  store.reload = () => {
    const state = reload();
    if (++reads === deliveryReads) queueMicrotask(() => otherWindow.commit(state.revision, (next) => { next.chapters.one.confirmed = true; }));
    return state;
  };
  await assert.rejects(createDeliverySnapshot(store, { word: true }), /project changed during delivery/);
});

test('image attachment preserves original bytes and its inline position in preview and delivery', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-image-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(cwd); await mkdir(join(rules, 'skills', 'one'), { recursive: true });
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const definition = manifest(); definition.chapters = [definition.chapters[0]];
  definition.chapters[0].outputs.push({ id: 'plan', name: 'Plan', kind: 'attachment' });
  definition.chapters[0].outputs.push({ id: 'notes', name: 'Notes', kind: 'attachment' });
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(definition));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'facts' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await mkdir(join(cwd, 'materials', 'input'), { recursive: true });
  await writeFile(join(cwd, 'materials', 'input', '园林图.png'), png);
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await writeFile(join(cwd, 'materials', 'input', '说明.md'), '# 说明\n\n![园林图](<materials/input/园林图.png>)\n\nAfter');
  const attachments = [{ outputId: 'plan', name: '园林图.png', filePath: 'materials/input/园林图.png' }, { outputId: 'notes', name: '说明.md', filePath: 'materials/input/说明.md' }];
  const revision = store.state.revision;
  await symlink(join(base, 'rules', 'AGENTS.md'), join(cwd, 'materials', 'input', 'escape.png'));
  for (const filePath of ['materials/input/../../outside.png', 'materials/input/escape.png', 'materials/input/missing.png', 'materials/input/说明.md']) {
    await assert.rejects(submitChapter(store, { token: ready.token, body: 'Body', attachments: [{ ...attachments[0], filePath }, attachments[1]] }));
    assert.equal(projectSnapshot(store).state.revision, revision);
  }
  await assert.rejects(submitChapter(store, { token: ready.token, body: '![remote](https://example.com/photo.png)', attachments }), /local saved original/);
  await assert.rejects(submitChapter(store, { token: ready.token, body: '![reference][plan]\n\n[plan]: materials/input/园林图.png', attachments }), /inline Markdown/);
  await assert.rejects(submitChapter(store, { token: ready.token, body: '<img src="materials/input/园林图.png">', attachments }), /inline Markdown/);
  await submitChapter(store, { token: ready.token, body: 'Before\n\n![园林图](<materials/input/园林图.png>)\n\nAfter', attachments });
  await unlink(join(cwd, 'materials', 'input', '园林图.png'));
  const artifact = await readChapterArtifact(store, 'one');
  assert.deepEqual(Buffer.from(artifact.attachments[0].base64, 'base64'), png);
  assert.match(artifact.body, /Before\n\n!\[园林图\]\(<materials\/input\/园林图.png>\)\n\nAfter/);
  assert.equal(artifact.images['materials/input/园林图.png'], `data:image/png;base64,${png.toString('base64')}`);
  const delivery = await createDeliverySnapshot(store);
  assert.match(delivery.markdown, /Before\n\n!\[园林图\]\(<图片\/one\/1-园林图.png>\)\n\nAfter/);
  assert.deepEqual(await readFile(join(cwd, delivery.directory, '图片/one/1-园林图.png')), png);
  assert.match(delivery.attachments[1].content, /!\[园林图\]\(<\.\.\/\.\.\/图片\/one\/1-园林图.png>\)/);
  assert.match(await readFile(join(cwd, delivery.directory, delivery.attachments[1].publicationPath), 'utf8'), /!\[园林图\]\(<@\.\/图片\/one\/1-园林图.png>\)/);
  assert.ok(delivery.files.some(item => item.path === delivery.attachments[1].publicationPath && item.sha256));
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: `${artifact.body}\nUpdated` });
  assert.equal((await readChapterArtifact(store, 'one')).images['materials/input/园林图.png'], artifact.images['materials/input/园林图.png']);
  const encodedBody = artifact.body.replace('园林图.png>', '%E5%9B%AD%E6%9E%97%E5%9B%BE.png>');
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: encodedBody });
  const edited = await readChapterArtifact(store, 'one');
  assert.equal(edited.images['materials/input/%E5%9B%AD%E6%9E%97%E5%9B%BE.png'], artifact.images['materials/input/园林图.png']);
  assert.deepEqual((await exportDelivery(store)).assets.map(asset => Buffer.from(asset.base64, 'base64')), [png, png]);
});

test('delivery merges numbered bodies once and preserves separate attachments and incomplete chapter notices', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-delivery-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(cwd);
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const definition = manifest(); definition.chapters[0].code = '1'; definition.chapters[1].code = '2';
  definition.chapters[0].outputs.push({ id: 'table', name: 'Table', kind: 'attachment' });
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(definition));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'facts' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await submitChapter(store, { token: ready.token, body: '# 1 One\n\n## 1.1 Scope\nBody only', attachments: [{ outputId: 'table', name: 'counts.xlsx', base64: 'AP9V' }] });
  const partial = await exportDelivery(store);
  assert.deepEqual(partial.incomplete.map((item) => item.chapterId), ['two']);
  assert.equal(partial.complete, false);
  assert.equal(partial.markdown.match(/^# 1 One/gm).length, 1);
  assert.doesNotMatch(partial.markdown, /counts|Appendices|Attachment Manifest/);
  assert.equal(partial.attachments[0].path, '附件/1 One/1-counts.xlsx');
  assert.equal(partial.attachments[0].base64, 'AP9V');
  await assert.rejects(createDeliverySnapshot(store), /incomplete chapters/);
  const chapterOnly = await createDeliverySnapshot(store, { chapterId: 'one' });
  assert.equal(chapterOnly.complete, true);
  assert.deepEqual(chapterOnly.chapters.map(item => item.chapterId), ['one']);
  assert.deepEqual(chapterOnly.incomplete, []);
  assert.equal(chapterOnly.attachments.length, 1);
  assert.notEqual(chapterOnly.directory, `outputs/final/revision-${chapterOnly.revision}`);
  assert.match(chapterOnly.markdown, /Body only/);
  assert.doesNotMatch(chapterOnly.markdown, /# 2/);
  assert.equal((await createDeliverySnapshot(store, { chapterId: 'one' })).directory, chapterOnly.directory);
  await assert.rejects(createDeliverySnapshot(store, { chapterId: 'two' }), /incomplete chapters/);
  await assert.rejects(createDeliverySnapshot(store, { chapterId: 'unknown' }), /unknown chapter/);
  const second = await prepareChapter(store, { chapterId: 'two' });
  await submitChapter(store, { token: second.token, body: 'Second body' });
  const complete = await exportDelivery(store, { requireComplete: true });
  assert.equal(complete.complete, true);
  assert.ok(complete.markdown.indexOf('Body only') < complete.markdown.indexOf('# 2 Two'));
  const saved = await createDeliverySnapshot(store);
  assert.equal(await readFile(join(cwd, saved.directory, '完整方案.md'), 'utf8'), complete.markdown);
  assert.deepEqual(await readFile(join(cwd, saved.directory, complete.attachments[0].path)), Buffer.from([0, 255, 85]));
  assert.equal((await createDeliverySnapshot(store)).directory, saved.directory);
  await writeFile(join(cwd, saved.directory, '完整方案.md'), 'modified outside plugin');
  await assert.rejects(createDeliverySnapshot(store), /delivery.*changed/i);
});

test('editing an attachment uses artifact CAS and preserves chapter body and other files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-edit-attachment-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(cwd); await mkdir(join(rules, 'skills', 'one'), { recursive: true });
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const definition = manifest(); definition.chapters = [definition.chapters[0]];
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(definition));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'facts' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await submitChapter(store, { token: ready.token, body: 'Original body', summary: 'Original summary', attachments: [{ outputId: 'table', name: 'table.md', content: 'Original attachment' }] });
  const revision = store.state.revision;
  await editChapter(store, { chapterId: 'one', revision, artifactRevision: 1, attachmentOutputId: 'table', body: 'Edited attachment' });
  const artifact = await readChapterArtifact(store, 'one');
  assert.equal(artifact.body, 'Original body');
  assert.equal(artifact.attachments[0].content, 'Edited attachment');
  await assert.rejects(editChapter(store, { chapterId: 'one', revision, artifactRevision: 1, attachmentOutputId: 'table', body: 'Late edit' }), /revision conflict/);
  await assert.rejects(editChapter(store, { chapterId: 'one', revision: store.state.revision, attachmentOutputId: 'unknown', body: 'bad' }), /attachment.*unavailable/);
});

test('editing body without the hidden review section preserves pending confirmation items', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-edit-review-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(cwd); await mkdir(join(rules, 'skills', 'one'), { recursive: true });
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const definition = manifest(); definition.chapters = [definition.chapters[0]];
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(definition));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'facts' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await submitChapter(store, { token: ready.token, body: '# One\n\n正文\n\n## 待确认事项\n1. 请核对合同期限。' });
  const revision = store.state.revision;
  await editChapter(store, { chapterId: 'one', revision, artifactRevision: 1, body: '# One\n\n已编辑正文', reviewItems: [{ id: 'body-review-1', message: '请核对合同期限。', status: 'pending', required: true }] });
  const artifact = await readChapterArtifact(store, 'one');
  assert.equal(artifact.body, '# One\n\n已编辑正文');
  assert.deepEqual(artifact.confirmations.map((item) => item.message), ['请核对合同期限。']);
  assert.equal(store.state.chapters.one.pendingConfirmations, true);
  const item = artifact.confirmations[0];
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: artifact.body, reviewItems: [{ ...item, status: 'confirmed' }] });
  assert.equal(store.state.chapters.one.pendingConfirmations, true, 'agent edit cannot approve user review');
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: artifact.body, reviewItems: [{ ...item, status: 'confirmed' }], userReview: true });
  assert.equal(store.state.chapters.one.pendingConfirmations, false);
  assert.equal((await readChapterArtifact(store, 'one')).confirmations[0].status, 'confirmed');
});

test('saving resolved inline gaps clears persisted review and publication gate without losing independent checks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-edit-inline-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(cwd); await mkdir(join(rules, 'skills', 'one'), { recursive: true });
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const definition = manifest(); definition.chapters = [definition.chapters[0]];
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(definition));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'facts' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await submitChapter(store, { token: ready.token, body: '## 2.2 合同版本\n版本：待确认' });
  const original = await readChapterArtifact(store, 'one');
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: '## 2.2 合同版本\n现行版本：待填写', reviewItems: original.confirmations });
  const changed = await readChapterArtifact(store, 'one');
  assert.deepEqual(changed.confirmations.map(item => item.message), ['现行版本：待填写']);
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: '## 2.2 合同版本\n现行版本：2026版', reviewItems: changed.confirmations });
  assert.deepEqual((await readChapterArtifact(store, 'one')).confirmations, []);
  assert.equal(store.state.chapters.one.pendingConfirmations, false);
  store.commit(store.state.revision, state => { state.chapters.one.pendingConfirmations = true; });
  assert.equal(projectSnapshot(store).state.chapters.one.pendingConfirmations, false, 'legacy cached flag must not restore a resolved gap');
  assert.equal((await exportDelivery(store, { requireComplete: true })).complete, true);
});

test('prepare binds bundled knowledge originals and preserves explicit project bindings', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-bundled-knowledge-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  const original = 'skills/one/references/standard.md'; const text = '# Verified company standard\nService commitment.';
  await mkdir(join(rules, 'skills', 'one', 'references'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, original), text); await writeFile(join(rules, 'skills/one/SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const chapter = { ...manifest().chapters[0], inputs: [{ id: 'Z-1', name: 'Company standard', required: true }, { id: 'brief', name: 'Project brief', required: true }], references: [{ title: 'Company standard', roles: ['knowledge'], inputIds: ['Z-1'], original: 'references/standard.md', content: 'references/standard.md' }] };
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters: [chapter], resources: [{ path: original, sha256: createHash('sha256').update(text).digest('hex') }] })));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const brief = await registerMaterial(store, { name: 'Project brief', text: 'Current facts' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: brief.id } });
  assert.equal(ready.token.bindings.brief, brief.id);
  const knowledge = store.state.materials[ready.token.bindings['Z-1']];
  assert.equal(knowledge.parseStatus, 'complete');
  assert.equal(knowledge.metadata.sourcePath, `.dsh/${original}`);
  assert.equal(await readFile(join(cwd, knowledge.contentPath), 'utf8'), text);
  const revision = store.state.revision;
  await recoverProject(store);
  const retry = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: brief.id } });
  assert.equal(retry.token.bindings['Z-1'], knowledge.id);
  assert.equal(store.state.revision, revision + 2, 'unchanged knowledge is reused without registering it again');
  await submitChapter(store, { token: retry.token, body: 'Body', evidence: [{ source: knowledge.id }] });
});

test('bundled knowledge with unread image content stays blocked and reuses its completed interpretation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-knowledge-review-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  const original = 'skills/one/references/standard.png';
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWQAAAAASUVORK5CYII=', 'base64');
  await mkdir(join(rules, 'skills/one/references'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, original), image); await writeFile(join(rules, 'skills/one/SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const chapter = { ...manifest().chapters[0], inputs: [{ id: 'Z-1', required: true }], references: [{ roles: ['knowledge'], inputIds: ['Z-1'], original: 'references/standard.png' }] };
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters: [chapter], resources: [{ path: original, sha256: createHash('sha256').update(image).digest('hex') }] })));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  await assert.rejects(prepareChapter(store, { chapterId: 'one' }), /bundled knowledge needs document review: Z-1/);
  assert.equal(store.state.chapters.one.status, 'pending');
  const prior = Object.values(store.state.materials)[0];
  assert.equal(prior.metadata.parserVersion, MATERIAL_PARSER_VERSION);
  assert.equal(prior.parseStatus, 'needs-vision');
  const complete = await registerMaterial(store, { name: prior.name, text: 'Verified diagram interpretation.', parseStatus: 'complete', metadata: { ...prior.metadata, derivedFrom: prior.id, coverage: { method: 'native-document-review', unresolved: [] } } });
  const ready = await prepareChapter(store, { chapterId: 'one' });
  assert.equal(ready.token.bindings['Z-1'], complete.id);
  assert.equal(Object.keys(store.state.materials).length, 2);
});

test('prepare returns exact attachment outputs and submit snapshots a saved attachment', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-attachment-draft-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills/one/SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const output = { id: '4.2.1', name: '物业服务项目标准及服务承诺', kind: 'attachment' };
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters: [{ ...manifest().chapters[0], inputs: [], outputs: [output] }] })));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const ready = await prepareChapter(store, { chapterId: 'one' });
  assert.deepEqual(ready.outputs, [output]);
  const contentPath = 'materials/notes/4.2.1-服务承诺.md';
  const content = '# 服务承诺\n\n|项目|标准|\n|---|---|\n|响应|按有效约定|';
  await writeFile(join(cwd, contentPath), content);
  for (const path of ['../outside.md', '.ccpg-scheme/state.json']) await assert.rejects(submitChapter(store, { token: ready.token, body: 'Body', attachments: [{ outputId: output.id, name: '服务承诺.md', contentPath: path }] }), /attachment.*path/i);
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'Body', attachments: [{ outputId: output.id, name: '服务承诺.md', contentPath, content }] }), /exactly one/i);
  await submitChapter(store, { token: ready.token, body: 'Body', attachments: [{ outputId: output.id, name: '服务承诺.md', contentPath }] });
  await writeFile(join(cwd, contentPath), 'Changed draft');
  const artifact = await readChapterArtifact(store, 'one');
  assert.deepEqual(artifact.attachments, [{ outputId: output.id, name: '服务承诺.md', content }]);
});

test('material instruction correction preserves artifacts, bindings and custom surrounding instructions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-material-instructions-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(cwd);
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await writeFile(join(rules, 'AGENTS.md'), `# Custom project rules\n${LEGACY_MATERIAL_READING_RULES[0]}\nKeep custom business instructions.\n`);
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'exact source' });
  const first = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await submitChapter(store, { token: first.token, body: 'saved chapter' });
  const before = structuredClone(store.state);
  assert.equal(updateMaterialReadingInstructions(store), true);
  assert.deepEqual(store.state.chapters, before.chapters); assert.deepEqual(store.state.artifacts, before.artifacts); assert.deepEqual(store.state.materials, before.materials);
  assert.deepEqual(store.state.confirmations, before.confirmations); assert.equal(store.state.manifest.version, before.manifest.version);
  assert.notEqual(store.state.rulesFingerprint, before.rulesFingerprint);
  const rulesText = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
  assert.ok(rulesText.includes(MATERIAL_READING_RULE)); assert.match(rulesText, /Keep custom business instructions/);
  assert.equal(updateMaterialReadingInstructions(store), false);
  const second = await prepareChapter(store, { chapterId: 'two' });
  assert.ok(second.token);
});

test('material instruction correction refuses active attempts, tampered rules and rolls back failed saves', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-material-instructions-fail-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(cwd);
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await writeFile(join(rules, 'AGENTS.md'), LEGACY_MATERIAL_READING_RULES[0]); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'source' });
  await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  assert.throws(() => updateMaterialReadingInstructions(store), /active/i);
  await recoverProject(store);
  const before = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
  const state = await readFile(join(cwd, '.ccpg-scheme/state.json'), 'utf8');
  const save = store.save;
  store.save = () => { throw new Error('injected failed save'); };
  assert.throws(() => updateMaterialReadingInstructions(store), /failed save/i);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), before);
  assert.equal(await readFile(join(cwd, '.ccpg-scheme/state.json'), 'utf8'), state);
  store.save = save;
  await writeFile(join(cwd, 'AGENTS.md'), before + '\nexternal modification');
  assert.throws(() => updateMaterialReadingInstructions(store), /integrity/i);
  assert.match(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), /external modification/);
});

test('manifest validation rejects bad graph, blockers, and unsafe resources', () => {
  assert.throws(() => validateManifest(manifest({ chapters: [{ ...manifest().chapters[0], dependencies: ['missing'] }] })), /dependency/i);
  assert.throws(() => validateManifest(manifest({ chapters: [{ ...manifest().chapters[0], dependencies: ['one'] }] })), /cycle/i);
  assert.throws(() => validateManifest(manifest({ resources: [{ path: '../secret', sha256: 'a'.repeat(64) }] })), /path/i);
  assert.doesNotThrow(() => validateManifest(manifest({ chapters: [{ ...manifest().chapters[0], blockers: [{ code: 'x', message: 'fix' }] }] })));
  assert.throws(() => validateManifest(manifest({ chapters: [{ ...manifest().chapters[0], order: 2 }, { ...manifest().chapters[1], order: 2 }] })), /order/i);
  assert.throws(() => validateManifest(manifest({ chapters: [{ ...manifest().chapters[0], order: 2 }, { ...manifest().chapters[1], order: 1, dependencies: ['one'] }] })), /order/i);
});

test('incomplete visual sources cannot satisfy a required input', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-visual-input-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await mkdir(sessionCwd); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'scan', text: '[No readable text layer]', parseStatus: 'needs-vision', metadata: { coverage: { unreadPages: [1], visualVerified: false } } });
  assert.equal(material.parseStatus, 'needs-vision');
  await assert.rejects(prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } }), /not acquired|incomplete/i);
  const legacy = await registerMaterial(store, { name: 'legacy scan', text: 'old placeholder', metadata: { coverage: { unreadPages: [1], visualVerified: false } } });
  await assert.rejects(prepareChapter(store, { chapterId: 'one', inputBindings: { brief: legacy.id } }), /not acquired|incomplete/i);
});

test('text-only PDF coverage satisfies inputs without claiming model visual verification', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-text-pdf-input-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await mkdir(sessionCwd); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  const unknown = await registerMaterial(store, { name: 'old PDF', text: 'Text', parseStatus: 'complete', metadata: { coverage: { method: 'text-layer', visualVerified: false } } });
  await assert.rejects(prepareChapter(store, { chapterId: 'one', inputBindings: { brief: unknown.id } }), /incomplete/i);
  const mixed = await registerMaterial(store, { name: 'mixed PDF', text: 'Text', parseStatus: 'complete', metadata: { coverage: { method: 'text-layer', visualPages: [1], visualVerified: false } } });
  await assert.rejects(prepareChapter(store, { chapterId: 'one', inputBindings: { brief: mixed.id } }), /incomplete/i);
  const text = await registerMaterial(store, { name: 'text PDF', text: 'Exact text', parseStatus: 'complete', metadata: { coverage: { method: 'text-layer', visualPages: [], unreadPages: [], visualVerified: false } } });
  const prepared = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: text.id } });
  assert.equal(prepared.token.bindings.brief, text.id);
});

test('regenerating upstream invalidates confirmed descendants and preserves unrelated chapters', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-regenerate-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  const chapters = [...manifest().chapters, { ...manifest().chapters[1], id: 'three', order: 3, dependencies: [] }];
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await mkdir(sessionCwd); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters })));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'source' });
  for (const chapterId of ['one', 'two', 'three']) {
    const ready = await prepareChapter(store, { chapterId, inputBindings: chapterId === 'one' ? { brief: material.id } : {} });
    await submitChapter(store, { token: ready.token, body: chapterId });
    if (chapterId !== 'one') await confirmChapter(store, { chapterId, revision: store.state.revision });
  }
  const unrelated = structuredClone(store.state.chapters.three); const confirmation = structuredClone(store.state.confirmations.three);
  const again = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await submitChapter(store, { token: again.token, body: 'regenerated' });
  assert.equal(store.state.chapters.two.status, 'stale'); assert.equal(store.state.chapters.two.confirmed, false); assert.equal(store.state.confirmations.two, undefined); assert.equal(store.state.chapters.two.token, null);
  assert.deepEqual(store.state.chapters.three, unrelated); assert.deepEqual(store.state.confirmations.three, confirmation);
  const dependent = await prepareChapter(store, { chapterId: 'two' });
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: 'edited' });
  assert.equal(store.state.chapters.two.token, null);
  await assert.rejects(submitChapter(store, { token: dependent.token, body: 'late' }), /stale|revoked/i);
});

test('chapter preparation follows explicit natural order and refuses silent skips', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-order-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const chapters = [
    { ...manifest().chapters[0], order: 20 },
    { ...manifest().chapters[1], order: 10, dependencies: [] },
  ];
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters })));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  await assert.rejects(prepareChapter(store, { chapterId: 'one', inputBindings: { brief: (await registerMaterial(store, { name: 'brief', text: 'x' })).id } }), /natural order/i);
  assert.equal(store.state.chapters.one.status, 'pending');
  assert.equal((await prepareChapter(store, { chapterId: 'two' })).token.chapterId, 'two');
});

test('validates resource bytes and rejects resource symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccpg-rules-'));
  await writeFile(join(root, 'data.txt'), 'real');
  const m = manifest({ resources: [{ path: 'data.txt', sha256: '0000000000000000000000000000000000000000000000000000000000000000' }] });
  assert.throws(() => validateManifest(m, { rulesRoot: root }), /hash/i);
  await writeFile(join(root, 'target.txt'), 'real');
  await symlink(join(root, 'target.txt'), join(root, 'link.txt'));
  assert.throws(() => validateManifest(manifest({ resources: [{ path: 'link.txt', sha256: 'a'.repeat(64) }] }), { rulesRoot: root }), /symlink/i);
});

test('project lifecycle pins versions, uses CAS, and invalidates descendants', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-scheme-'));
  const rules = join(base, 'rules');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true });
  await mkdir(join(rules, 'skills', 'two'), { recursive: true });
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), '# one');
  await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), '# two');
  await writeFile(join(rules, 'AGENTS.md'), '# Installed company instructions\nUse only approved sources.');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const sessionCwd = join(base, 'session'); await mkdir(sessionCwd);
  const store = await createProject({ sessionCwd, projectId: 'p1', rulesDir: rules });
  assert.equal(store.root, sessionCwd);
  assert.equal(existsSync(join(store.root, '.git')), true);
  assert.equal(existsSync(join(store.root, 'outputs', 'chapters')), true);
  assert.equal(existsSync(join(store.root, '.ccpg-scheme', 'state.json')), true);
  assert.equal(existsSync(join(store.root, 'materials', 'input')), true);
  assert.match(await readFile(join(store.root, 'AGENTS.md'), 'utf8'), /Installed company instructions/);
  assert.equal(store.state.revision, 1);
  await writeFile(join(store.root, '.ccpg-scheme', 'state.lock'), String(process.pid));
  await assert.rejects(registerMaterial(store, { name: 'locked', text: 'x' }), /locked/);
  await unlink(join(store.root, '.ccpg-scheme', 'state.lock'));
  await writeFile(join(store.root, '.ccpg-scheme', 'state.lock'), '99999999');
  const material = await registerMaterial(store, { name: 'brief.txt', text: 'hello' });
  assert.equal(await readFile(join(store.root, material.contentPath), 'utf8'), 'hello');
  assert.equal(Object.hasOwn(store.state.materials[material.id], 'text'), false);
  const prepared = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  assert.match(prepared.prompt, /当前同一个 DSH 原生会话/);
  assert.match(prepared.prompt, /\.dsh\/skills\/one\/SKILL\.md/);
  assert.equal(prepared.skillName, 'one');
  assert.equal(prepared.skillSource, 'project-dsh');
  await assert.rejects(prepareChapter(store, { chapterId: 'two' }), /already prepared/i);
  assert.equal(prepared.token.chapterId, 'one');
  const done = await submitChapter(store, { token: prepared.token, body: 'draft', evidence: [{ source: material.id }], attachments: [] });
  assert.equal(done.status, 'submitted');
  await confirmChapter(store, { chapterId: 'one', revision: done.revision });
  const next = await prepareChapter(store, { chapterId: 'two' });
  await submitChapter(store, { token: next.token, body: 'two', evidence: [], attachments: [] });
  await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: 'revised' });
  assert.equal(store.state.chapters.one.confirmed, false);
  assert.equal(store.state.chapters.two.stale, true);
  assert.match(await exportProject(store), /revised/);
  assert.doesNotMatch(await exportProject(store), /\n\ntwo/);
  assert.throws(() => store.commit(store.state.revision - 1, () => ({})), /revision/i);
  const secondHandle = SchemeStore.load(store.root);
  assert.throws(() => secondHandle.commit(store.state.revision - 1, () => ({})), /revision/i);
  const recovered = await recoverProject(store);
  assert.ok(recovered.chapters.one.interrupted || recovered.chapters.one.status !== 'running');
  assert.equal(await readFile(join(store.root, '.ccpg-scheme', 'state.json'), 'utf8').then(Boolean), true);
});

test('chapter submission snapshots a saved draft without re-emitting its body', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-draft-submit-')); const rules = join(base, 'rules'); const cwd = join(base, 'project');
  await mkdir(cwd);
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'exact source' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id }, sessionId: 'native' });
  assert.equal(ready.draftPath, 'materials/notes/one-draft.md');
  const body = '# Complete chapter\n\n| Metric | Value |\n| --- | --- |\n| Area | 123.45 |\n\nSource: exact source.\n';
  await writeFile(join(cwd, ready.draftPath), body);
  const done = await submitChapter(store, { token: ready.token, bodyPath: ready.draftPath, sessionId: 'native', evidence: [{ source: material.id }] });
  assert.equal(done.status, 'submitted');
  assert.equal((await readChapterArtifact(store, 'one')).body, body);
  await writeFile(join(cwd, ready.draftPath), 'later edit');
  assert.equal((await readChapterArtifact(store, 'one')).body, body);
});

test('draft submission keeps path, cancellation, session and evidence checks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-draft-safety-')); const rules = join(base, 'rules'); const cwd = join(base, 'project');
  await mkdir(cwd);
  for (const id of ['one', 'two']) { await mkdir(join(rules, 'skills', id), { recursive: true }); await writeFile(join(rules, 'skills', id, 'SKILL.md'), id); }
  await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'source' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id }, sessionId: 'native' });
  const bodyPath = 'materials/notes/one-draft.md';
  await writeFile(join(cwd, bodyPath), 'saved draft');
  const input = { token: ready.token, bodyPath, sessionId: 'native' };
  await assert.rejects(submitChapter(store, { ...input, body: 'ambiguous body' }), /exactly one.*body/i);
  for (const path of ['/tmp/outside.md', 'materials/notes/../../AGENTS.md', 'AGENTS.md', material.contentPath, 'materials/notes/draft.txt']) {
    await assert.rejects(submitChapter(store, { ...input, bodyPath: path }), /draft path|project path/i);
  }
  await symlink(join(cwd, bodyPath), join(cwd, 'materials/notes/link.md'));
  await assert.rejects(submitChapter(store, { ...input, bodyPath: 'materials/notes/link.md' }), /symlink/i);
  await mkdir(join(cwd, 'materials/notes/directory.md'));
  await assert.rejects(submitChapter(store, { ...input, bodyPath: 'materials/notes/directory.md' }), /regular file/i);
  await assert.rejects(submitChapter(store, { ...input, bodyPath: 'materials/notes/missing.md' }), /ENOENT/i);
  await assert.rejects(submitChapter(store, { ...input, sessionId: 'other' }), /session mismatch/i);
  await assert.rejects(submitChapter(store, { ...input, evidence: [{ source: 'missing' }] }), /registered material or artifact/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(submitChapter(store, { ...input, signal: controller.signal }), /cancelled/i);
  await writeFile(join(cwd, bodyPath), Buffer.from([0xff, 0xfe]));
  await assert.rejects(submitChapter(store, input), /encoded data|utf-8/i);
  await writeFile(join(cwd, bodyPath), ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(submitChapter(store, input), /draft.*large/i);
  await writeFile(join(cwd, bodyPath), '  \n');
  await assert.rejects(submitChapter(store, input), /body is required/i);
  assert.equal(store.state.chapters.one.status, 'prepared');
  assert.equal(Object.keys(store.state.artifacts).length, 0);
  await writeFile(join(cwd, bodyPath), 'complete body');
  await recoverProject(store);
  await assert.rejects(submitChapter(store, input), /stale|revoked/i);
});

test('unresolved chapter blockers do not prevent project creation but block that chapter', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-blockers-'));
  const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters: manifest().chapters.map((c) => c.id === 'one' ? { ...c, blockers: [{ code: 'need-review', message: 'Review source' }] } : c) })));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  await assert.rejects(prepareChapter(store, { chapterId: 'one', inputBindings: {} }), /blocker/i);
  await assert.rejects(prepareChapter(store, { chapterId: 'two' }), /dependency/i);
});

test('unknown required inputs need an explicit decision and prepared versions cannot go stale silently', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-unknown-'));
  const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const m = manifest({ chapters: manifest().chapters.map((c) => c.id === 'one' ? { ...c, inputs: [{ id: 'maybe', name: 'Maybe', required: 'unknown' }] } : c) });
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(m));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  await assert.rejects(prepareChapter(store, { chapterId: 'one' }), /decision/i);
  const ready = await prepareChapter(store, { chapterId: 'one', inputDecisions: { maybe: 'not_required' } });
  await registerMaterial(store, { name: 'later', text: 'new material' });
  const done = await submitChapter(store, { token: ready.token, body: 'body' });
  assert.equal(done.status, 'submitted');
  assert.deepEqual(store.state.chapters.one.decisions, { maybe: 'not_required' });
});

test('metadata-only acquisition cannot satisfy required input and attachments match declared outputs', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-outputs-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const chapters = manifest().chapters.map((c) => c.id === 'one' ? { ...c, outputs: [...c.outputs, { id: 'sheet', name: 'Sheet', kind: 'attachment' }] } : c);
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters })));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const metadata = await registerMaterial(store, { name: 'brief', metadata: { source: 'later' } });
  await assert.rejects(prepareChapter(store, { chapterId: 'one', inputBindings: { brief: metadata.id } }), /not acquired/i);
  const actual = await registerMaterial(store, { name: 'brief', text: 'content' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: actual.id } });
  for (const attachment of [
    { outputId: 'sheet', name: '../outside.csv', content: 'a,b' },
    { outputId: 'sheet', name: 'sheet.csv', base64: 'not valid base64!' },
    { outputId: 'sheet', name: 'sheet.csv', content: '' },
    { outputId: 'sheet', name: 'sheet.csv', content: 'x', base64: 'eA==' },
  ]) await assert.rejects(submitChapter(store, { token: ready.token, body: 'body', attachments: [attachment] }), /attachment/i);
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'body', attachments: [{ outputId: 'wrong', name: 'x.txt', content: 'x' }] }), /attachment output/i);
  const done = await submitChapter(store, { token: ready.token, body: 'body', attachments: [{ outputId: 'sheet', name: 'sheet.csv', content: 'a,b' }] });
  assert.equal(done.status, 'submitted');
});

test('confirmation blocks descendants only when the upstream definition requires it and uses project CAS', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-confirm-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const chapters = manifest().chapters.map((c) => c.id === 'one' ? { ...c, confirmations: [{ id: 'owner', required: true }] } : c); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters })));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const mat = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: mat.id } }); await submitChapter(store, { token: ready.token, body: 'body' });
  await assert.rejects(prepareChapter(store, { chapterId: 'two' }), /confirmation/i);
  await assert.rejects(confirmChapter(store, { chapterId: 'one', revision: store.state.revision - 1 }), /revision|ready/i);
  const originalSave = store.save.bind(store); store.save = () => { throw new Error('disk failure'); };
  await assert.rejects(confirmChapter(store, { chapterId: 'one', revision: store.state.revision }), /disk failure/);
  assert.equal(SchemeStore.load(store.root).state.chapters.one.confirmed, false);
  assert.equal(store.state.chapters.one.status, 'submitted');
  store.save = originalSave;
  await confirmChapter(store, { chapterId: 'one', revision: store.state.revision, artifactRevision: store.state.chapters.one.revision });
  const next = await prepareChapter(store, { chapterId: 'two' }); assert.equal(next.token.chapterId, 'two');
});

test('submitted pending confirmations are durable and block descendants', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-pending-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const mat = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: mat.id } });
  const done = await submitChapter(store, { token: ready.token, body: 'body', confirmations: [{ id: 'date', message: 'Confirm date', required: true, status: 'pending' }] });
  assert.equal(JSON.parse(await readFile(join(store.root, 'outputs', 'chapters', 'one', done.artifactId, 'confirmations.json'), 'utf8'))[0].id, 'date');
  await assert.rejects(prepareChapter(store, { chapterId: 'two' }), /confirmation/i);
});

test('rule files are fingerprinted, relative resources preserved, and artifacts stored separately', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-files-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(join(rules, 'resources'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'read ../../resources/table.txt'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'resources', 'table.txt'), 'table'); await writeFile(join(rules, 'AGENTS.md'), 'real instructions');
  const m = manifest({ resources: [{ path: 'resources/table.txt', sha256: '0d4fc4a78d3706edccafb665a8b2fdd9309e82c78625bb0f2b8e7bb9e1c4d21c' }] });
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(m));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  assert.equal(await readFile(join(store.root, '.dsh', 'resources', 'table.txt'), 'utf8'), 'table');
  const mat = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: mat.id } });
  await writeFile(join(store.root, '.dsh', 'skills', 'one', 'SKILL.md'), 'tampered');
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'body' }), /rules changed|integrity/i);
  await writeFile(join(store.root, '.dsh', 'skills', 'one', 'SKILL.md'), 'read ../../resources/table.txt');
  const retry = await recoverProject(store).then(() => prepareChapter(store, { chapterId: 'one', inputBindings: { brief: mat.id } }));
  const done = await submitChapter(store, { token: retry.token, body: 'body', evidence: [{ source: mat.id }] });
  assert.equal(await readFile(join(store.root, 'outputs', 'chapters', 'one', done.artifactId, 'body.md'), 'utf8'), 'body');
  assert.equal(store.state.artifacts[done.artifactId].body, undefined);
});

test('safe source index excludes hidden secrets and symlinks and export follows chapter order', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-index-')); const source = join(base, 'source');
  await mkdir(join(source, 'docs'), { recursive: true }); await writeFile(join(source, 'docs', 'brief.txt'), 'hello'); await writeFile(join(source, '.env'), 'secret'); await writeFile(join(source, 'password.txt'), 'secret'); await symlink(join(source, 'docs', 'brief.txt'), join(source, 'link.txt'));
  const indexed = await indexMaterialDirectory(source, ['brief']);
  assert.deepEqual(indexed.map((x) => x.relativePath), ['docs/brief.txt']);
  assert.deepEqual(indexed[0].candidates, ['brief']);
  const rules = join(base, 'rules'); const sessionCwd = join(base, 'session'); await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const acquired = await registerIndexedMaterial(store, { sourceDir: source, relativePath: 'docs/brief.txt', name: 'brief' }); assert.equal(await readFile(join(store.root, acquired.contentPath), 'utf8'), 'hello');
  await assert.rejects(registerIndexedMaterial(store, { sourceDir: source, relativePath: '.env', name: 'bad' }), /unsafe|secret/i);
  await writeFile(join(source, 'huge.txt'), 'x'.repeat(20));
  await assert.rejects(indexMaterialDirectory(source, [], { maxFileBytes: 10 }), /too large/i);
});

test('compatible inactive chapter rule replacement preserves old version on failure', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-replace-')); const rules = join(base, 'rules'); const replacement = join(base, 'replacement'); const sessionCwd = join(base, 'session');
  for (const root of [rules, replacement]) { await mkdir(join(root, 'skills', 'one'), { recursive: true }); await mkdir(join(root, 'skills', 'two'), { recursive: true }); await writeFile(join(root, 'skills', 'one', 'SKILL.md'), root === rules ? 'old' : 'new'); await writeFile(join(root, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(root, 'AGENTS.md'), 'instructions'); await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest({ version: root === rules ? '1.0.0' : '1.0.1' }))); }
  await mkdir(sessionCwd); const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  await replaceChapterRules(store, { chapterId: 'one', replacementDir: replacement });
  assert.equal(await readFile(join(store.root, '.dsh', 'skills', 'one', 'SKILL.md'), 'utf8'), 'new');
  const snapshot = projectSnapshot(store); assert.equal(snapshot.manifest.chapters[1].title, 'Two'); assert.equal(snapshot.state.projectId, 'p');
  const incompatible = JSON.parse(await readFile(join(replacement, 'manifest.json'), 'utf8')); incompatible.chapters[0].inputs = [];
  await writeFile(join(replacement, 'manifest.json'), JSON.stringify(incompatible)); await writeFile(join(replacement, 'skills', 'one', 'SKILL.md'), 'bad');
  await assert.rejects(replaceChapterRules(store, { chapterId: 'one', replacementDir: replacement }), /interface/i);
  assert.equal(await readFile(join(store.root, '.dsh', 'skills', 'one', 'SKILL.md'), 'utf8'), 'new');
});

test('one compatible rule version can update multiple inactive chapters without deleting another chapter snapshot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-version-chapters-'));
  const rules = join(base, 'rules'); const replacement = join(base, 'replacement'); const cwd = join(base, 'session');
  for (const root of [rules, replacement]) {
    for (const id of ['one', 'two']) {
      await mkdir(join(root, 'skills', id), { recursive: true });
      await writeFile(join(root, 'skills', id, 'SKILL.md'), `${root === rules ? 'old' : 'new'} ${id}`);
    }
    await writeFile(join(root, 'AGENTS.md'), 'instructions');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest({ version: root === rules ? '1.0.0' : '1.0.1' })));
  }
  await mkdir(cwd);
  const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  await replaceChapterRules(store, { chapterId: 'one', replacementDir: replacement });
  await replaceChapterRules(store, { chapterId: 'two', replacementDir: replacement });
  assert.equal(await readFile(join(cwd, '.ccpg-scheme/rule-versions/1.0.1/one/SKILL.md'), 'utf8'), 'new one');
  assert.equal(await readFile(join(cwd, '.ccpg-scheme/rule-versions/1.0.1/two/SKILL.md'), 'utf8'), 'new two');
  await assert.rejects(replaceChapterRules(store, { chapterId: 'two', replacementDir: replacement }), /already exists/i);
  const next = join(base, 'next');
  await cp(replacement, next, { recursive: true });
  const nextManifest = JSON.parse(await readFile(join(next, 'manifest.json'), 'utf8')); nextManifest.version = '1.0.2';
  await writeFile(join(next, 'manifest.json'), JSON.stringify(nextManifest));
  await replaceChapterRules(store, { chapterId: 'one', replacementDir: next });
  const save = store.save;
  store.save = () => { throw new Error('simulated replacement persistence failure'); };
  await assert.rejects(replaceChapterRules(store, { chapterId: 'two', replacementDir: next }), /persistence failure/i);
  store.save = save;
  assert.equal(await readFile(join(cwd, '.ccpg-scheme/rule-versions/1.0.2/one/SKILL.md'), 'utf8'), 'new one');
  await replaceChapterRules(store, { chapterId: 'two', replacementDir: next });
});

test('inactive missing-output rule repair preserves project data and rejects other interface changes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-output-repair-')); const rules = join(base, 'rules'); const replacement = join(base, 'replacement'); const sessionCwd = join(base, 'session');
  const missing = { code: 'OUTPUT_DEFINITION_MISSING', message: 'Two has no output' };
  const unresolved = { code: 'MISSING_KNOWLEDGE', message: 'Other chapter still needs knowledge' };
  const original = manifest({ blockers: [missing, unresolved], chapters: manifest().chapters.map((chapter) => chapter.id === 'two' ? { ...chapter, outputs: [], blockers: [missing] } : chapter) });
  const corrected = structuredClone(original); corrected.version = '1.0.1'; corrected.blockers = [unresolved];
  corrected.chapters[1] = { ...corrected.chapters[1], outputs: [{ id: 'body', name: 'Requirements management', kind: 'body' }], blockers: [], rules: ['Use the internal body structure; verify project facts.'], outputDefinitionSource: { kind: 'internal-supplement', date: '2026-10-10' } };
  for (const root of [rules, replacement]) {
    for (const id of ['one', 'two']) { await mkdir(join(root, 'skills', id), { recursive: true }); await writeFile(join(root, 'skills', id, 'SKILL.md'), id === 'two' && root === replacement ? 'new two' : id); }
    await writeFile(join(root, 'AGENTS.md'), 'instructions');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(root === rules ? original : corrected));
  }
  await mkdir(sessionCwd); const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  const material = await registerMaterial(store, { name: 'brief', text: 'source' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await assert.rejects(replaceChapterRules(store, { chapterId: 'two', replacementDir: replacement }), /active/i);
  await submitChapter(store, { token: ready.token, body: 'existing chapter body' });
  await writeFile(join(sessionCwd, 'materials', 'notes', 'draft.md'), 'existing draft');
  const before = structuredClone(store.state);
  const incompatible = structuredClone(corrected); incompatible.chapters[1].dependencies = [];
  await writeFile(join(replacement, 'manifest.json'), JSON.stringify(incompatible));
  await assert.rejects(replaceChapterRules(store, { chapterId: 'two', replacementDir: replacement }), /interface/i);
  await writeFile(join(replacement, 'manifest.json'), JSON.stringify(corrected));
  await replaceChapterRules(store, { chapterId: 'two', replacementDir: replacement });
  const after = projectSnapshot(store);
  assert.deepEqual(after.state.materials, before.materials);
  assert.deepEqual(after.state.artifacts, before.artifacts);
  assert.deepEqual(after.state.chapters.one, before.chapters.one);
  assert.deepEqual(after.manifest.chapters[1], corrected.chapters[1]);
  assert.deepEqual(after.manifest.blockers, [unresolved]);
  assert.equal(await readFile(join(sessionCwd, 'materials', 'notes', 'draft.md'), 'utf8'), 'existing draft');
  assert.equal(await readFile(join(sessionCwd, '.dsh', 'skills', 'two', 'SKILL.md'), 'utf8'), 'new two');
  const next = await prepareChapter(store, { chapterId: 'two' });
  assert.equal((await submitChapter(store, { token: next.token, body: 'requirements body' })).status, 'submitted');
  await assert.rejects(replaceChapterRules(store, { chapterId: 'two', replacementDir: rules }), /interface/i);
});

test('explicit project instruction update participates in rule integrity and invalidates earlier artifacts', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-instruction-update-')); const rules = join(base, 'rules'); const replacement = join(base, 'replacement'); const cwd = join(base, 'session');
  for (const root of [rules, replacement]) {
    for (const id of ['one', 'two']) { await mkdir(join(root, 'skills', id), { recursive: true }); await writeFile(join(root, 'skills', id, 'SKILL.md'), id); }
    await writeFile(join(root, 'AGENTS.md'), root === rules ? 'original instructions' : 'register materials before preparation');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest({ version: root === rules ? '1.0.0' : '1.0.1' })));
  }
  await mkdir(cwd); const store = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const before = structuredClone(store.state); const save = store.save;
  store.save = () => { throw new Error('simulated state persistence failure'); };
  await assert.rejects(replaceChapterRules(store, { chapterId: 'two', replacementDir: replacement, updateProjectInstructions: true }), /persistence failure/i);
  store.save = save;
  assert.deepEqual(SchemeStore.load(cwd).state, before);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'original instructions');
  assert.equal(JSON.parse(await readFile(join(cwd, '.ccpg-scheme', 'manifest.json'), 'utf8')).version, '1.0.0');
  assert.equal(await readFile(join(cwd, '.dsh', 'skills', 'two', 'SKILL.md'), 'utf8'), 'two');
  const material = await registerMaterial(store, { name: 'brief', text: 'source' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } }); await submitChapter(store, { token: ready.token, body: 'earlier body' });
  await replaceChapterRules(store, { chapterId: 'two', replacementDir: replacement, updateProjectInstructions: true });
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'register materials before preparation');
  assert.equal(store.state.chapters.one.status, 'stale');
  assert.ok(store.state.chapters.one.artifactId);
  assert.equal((await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } })).token.rulesFingerprint, store.state.rulesFingerprint);
  await recoverProject(store);
  await writeFile(join(cwd, 'AGENTS.md'), 'external tamper');
  await assert.rejects(replaceChapterRules(store, { chapterId: 'two', replacementDir: rules, updateProjectInstructions: true }), /integrity|rules changed/i);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'external tamper');
});

test('chapter attempts stay in the current native session and cannot revive an older token', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-attempt-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' });
  const first = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  assert.match(first.prompt, /当前|同一|existing|native/i); assert.match(first.token.attemptId, /^[0-9a-f-]{36}$/i);
  await recoverProject(store);
  const second = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  assert.notEqual(first.token.attemptId, second.token.attemptId);
  await assert.rejects(submitChapter(store, { token: first.token, body: 'late' }), /stale|attempt/i);
});

test('chapter preparation stops when managed source files exist but none are registered', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-unregistered-materials-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  const chapters = manifest().chapters.map((chapter) => chapter.id === 'one' ? { ...chapter, inputs: [] } : chapter);
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest({ chapters })));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  await writeFile(join(sessionCwd, 'materials', 'input', 'brief.md'), '# Brief');
  await assert.rejects(prepareChapter(store, { chapterId: 'one' }), /materials.*not registered|register.*materials/i);
  await registerMaterial(store, { name: 'brief', text: '# Brief', metadata: { source: 'project-file', sourcePath: 'materials/input/brief.md', sourceSha256: createHash('sha256').update('# Brief').digest('hex') } });
  assert.equal((await prepareChapter(store, { chapterId: 'one' })).token.chapterId, 'one');
});

test('chapter submission accepts the same JSON token after tool transport reorders object keys', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-token-transport-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id }, sessionId: 's1' });
  const transportedToken = Object.fromEntries(Object.entries(ready.token).reverse());
  const submitted = await submitChapter(store, { token: transportedToken, body: 'body', evidence: [{ source: material.id }], sessionId: 's1' });
  assert.equal(SchemeStore.load(store.root).state.chapters.one.artifactId, submitted.artifactId);
});

test('cancelled submit does not persist an artifact', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-cancel-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: (await registerMaterial(store, { name: 'brief', text: 'x' })).id } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'cancelled', signal: controller.signal }), /cancel/i);
  assert.equal(Object.keys(SchemeStore.load(store.root).state.artifacts).length, 0);
  assert.equal(store.state.chapters.one.status, 'prepared');
});

test('artifact summaries and context references are hashed, and external edits are stale', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-artifact-hash-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  const done = await submitChapter(store, { token: ready.token, body: 'body', summary: 'summary', contextRefs: [{ materialId: material.id }], evidence: [{ source: material.id }] });
  const record = SchemeStore.load(store.root).state.artifacts[done.artifactId];
  assert.ok(record.files.body.sha256); assert.ok(record.files.summary.sha256); assert.ok(record.files.contextRefs.sha256);
  const bodyPath = join(store.root, 'outputs', 'chapters', 'one', done.artifactId, 'body.md'); await writeFile(bodyPath, 'changed');
  await assert.rejects(readChapterArtifact(store, 'one'), /external|changed|stale/i);
  assert.equal(SchemeStore.load(store.root).state.chapters.one.stale, true);
  await assert.rejects(exportProject(store), /external|changed|stale/i);
});

test('invalid evidence references are rejected and index corruption is rebuilt', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-integrity-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'body', evidence: [{ source: 'missing-material' }] }), /registered material or artifact id/i);
  const indexPath = join(store.root, '.ccpg-scheme', 'index.json'); const index = JSON.parse(await readFile(indexPath, 'utf8')); index.projectId = 'tampered'; await writeFile(indexPath, JSON.stringify(index));
  const reloaded = SchemeStore.load(store.root); assert.equal(reloaded.reload().projectId, 'p');
  assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).projectId, 'p');
});

test('explicit user skip records a reason and never bypasses dependencies', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-skip-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  await assert.rejects(skipChapter(store, { chapterId: 'one', revision: store.state.revision }), /reason/i);
  await skipChapter(store, { chapterId: 'one', revision: store.state.revision, reason: 'not in scope' });
  assert.equal(store.state.chapters.one.status, 'skipped'); assert.equal(store.state.chapters.one.skipReason, 'not in scope');
  await assert.rejects(prepareChapter(store, { chapterId: 'two' }), /dependency/i);
});

test('invalid rules leave a dedicated workspace empty', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-invalid-rules-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(rules); await mkdir(sessionCwd); await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'bad', version: '1', chapters: [{ id: 'bad', order: 1, skill: '../outside' }] }));
  await assert.rejects(createProject({ sessionCwd, projectId: 'p', rulesDir: rules }), /invalid|unsafe|missing/i);
  assert.deepEqual(await readdir(sessionCwd), []);
});

test('recovery revokes an in-flight attempt before it can commit', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-revoke-race-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id }, sessionId: 's1' });
  const originalCommit = store.commit.bind(store); let revoked = false;
  store.commit = (revision, mutate) => { if (!revoked) { revoked = true; originalCommit(store.state.revision, (s) => { for (const chapter of Object.values(s.chapters)) if (chapter.status === 'prepared') { chapter.status = 'interrupted'; chapter.token = null; } }); } return originalCommit(revision, mutate); };
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'late', sessionId: 's1' }), /revision|stale|attempt/i);
  assert.equal(SchemeStore.load(store.root).state.chapters.one.status, 'interrupted');
});

test('artifact writes reject symlinked managed ancestors', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-artifact-symlink-')); const outside = join(base, 'outside'); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd); await mkdir(outside);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); await rm(join(store.root, 'outputs', 'chapters'), { recursive: true }); await symlink(outside, join(store.root, 'outputs', 'chapters'));
  const material = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'must stay inside' }), /symlink|escape|project path/i);
  assert.deepEqual(await readdir(outside), []);
});

test('editing a dynamically confirmed chapter reopens its confirmation gate', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-edit-confirm-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } }); const done = await submitChapter(store, { token: ready.token, body: 'body', confirmations: [{ id: 'owner', required: true }] });
  for (const body of [undefined, '', '   ', null, 123]) {
    await assert.rejects(editChapter(store, { chapterId: 'one', revision: store.state.revision, body }), /body/i);
    assert.equal(store.state.chapters.one.artifactId, done.artifactId);
  }
  const controller = new AbortController();
  const originalCommit = store.commit.bind(store);
  store.commit = (...args) => { controller.abort(); return originalCommit(...args); };
  await assert.rejects(editChapter(store, { chapterId: 'one', revision: store.state.revision, body: 'cancelled edit', signal: controller.signal }), /cancel/i);
  assert.equal(SchemeStore.load(store.root).state.chapters.one.artifactId, done.artifactId);
  assert.deepEqual(await readdir(join(store.root, 'outputs', 'chapters', 'one')), [done.artifactId]);
  store.commit = originalCommit;
  await confirmChapter(store, { chapterId: 'one', revision: done.revision });
  const edited = await editChapter(store, { chapterId: 'one', revision: store.state.revision, body: 'edited' });
  assert.equal(store.state.chapters.one.pendingConfirmations, true);
  assert.equal(await readFile(join(store.root, edited.path, 'summary.md'), 'utf8'), 'edited');
  await assert.rejects(prepareChapter(store, { chapterId: 'two' }), /confirmation/i);
});

test('confirmation and edit reject externally modified artifact files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-confirm-external-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' }); const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } }); const committed = await submitChapter(store, { token: ready.token, body: 'body' }); const root = join(store.root, 'outputs', 'chapters', 'one', committed.artifactId);
  await writeFile(join(root, 'evidence.json'), 'tampered');
  await assert.rejects(confirmChapter(store, { chapterId: 'one', revision: store.state.revision }), /external|changed|stale/i);
  await assert.rejects(editChapter(store, { chapterId: 'one', revision: store.state.revision, body: 'edit' }), /external|changed|stale/i);
});

test('changing original source invalidates its parsed material and dependent chapter', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-original-source-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true });
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  await mkdir(sessionCwd);
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules });
  await mkdir(join(sessionCwd, 'inputs')); await writeFile(join(sessionCwd, 'inputs/brief.md'), 'source');
  const digest = createHash('sha256').update('source').digest('hex');
  const material = await registerMaterial(store, { name: 'brief', text: 'parsed source', metadata: { source: 'project-file', sourcePath: 'inputs/brief.md', sourceSha256: digest } });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await submitChapter(store, { token: ready.token, body: 'body' });
  await writeFile(join(sessionCwd, 'inputs/brief.md'), 'changed original');
  await assert.rejects(exportProject(store), /material external-changed/i);
  assert.equal(store.state.chapters.one.stale, true);
  const next = await registerMaterial(store, { name: 'brief', text: 'parsed source', metadata: { source: 'project-file', sourcePath: 'inputs/brief.md', sourceSha256: createHash('sha256').update('changed original').digest('hex') } });
  assert.notEqual(next.id, material.id);
  const resumed = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: next.id } });
  assert.equal(resumed.token.bindings.brief, next.id);
});

test('material byte changes revoke prepared attempts and stale dependent artifacts', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-material-changed-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'original' });
  const ready = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } });
  await writeFile(join(store.root, material.contentPath), 'externally changed');
  await assert.rejects(submitChapter(store, { token: ready.token, body: 'must reject' }), /material external-changed/i);
  assert.equal(SchemeStore.load(store.root).state.chapters.one.status, 'external-changed');
  assert.equal(SchemeStore.load(store.root).state.chapters.one.token, null);

  const otherCwd = join(base, 'session-submitted'); await mkdir(otherCwd);
  const other = await createProject({ sessionCwd: otherCwd, projectId: 'q', rulesDir: rules }); const otherMaterial = await registerMaterial(other, { name: 'brief', text: 'original' });
  const otherReady = await prepareChapter(other, { chapterId: 'one', inputBindings: { brief: otherMaterial.id } }); await submitChapter(other, { token: otherReady.token, body: 'body' });
  await writeFile(join(other.root, otherMaterial.contentPath), 'externally changed');
  await assert.rejects(exportProject(other), /material external-changed/i);
  assert.equal(SchemeStore.load(other.root).state.chapters.one.status, 'external-changed');
});

test('upstream artifact and rule changes block dependent preparation and export', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-integrity-propagation-')); const rules = join(base, 'rules'); const sessionCwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(sessionCwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules'); await writeFile(join(rules, 'manifest.json'), JSON.stringify(manifest()));
  const store = await createProject({ sessionCwd, projectId: 'p', rulesDir: rules }); const material = await registerMaterial(store, { name: 'brief', text: 'x' });
  const first = await prepareChapter(store, { chapterId: 'one', inputBindings: { brief: material.id } }); const submitted = await submitChapter(store, { token: first.token, body: 'one' });
  await writeFile(join(store.root, 'outputs', 'chapters', 'one', submitted.artifactId, 'body.md'), 'tampered');
  await assert.rejects(prepareChapter(store, { chapterId: 'two' }), /external-changed/i);
  assert.equal(SchemeStore.load(store.root).state.chapters.two.stale, true);

  const otherBase = await mkdtemp(join(tmpdir(), 'ccpg-rules-changed-')); const otherRules = join(otherBase, 'rules'); const otherCwd = join(otherBase, 'session');
  await mkdir(join(otherRules, 'skills', 'one'), { recursive: true }); await mkdir(join(otherRules, 'skills', 'two'), { recursive: true }); await mkdir(otherCwd);
  await writeFile(join(otherRules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(otherRules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(otherRules, 'AGENTS.md'), 'rules'); await writeFile(join(otherRules, 'manifest.json'), JSON.stringify(manifest()));
  const other = await createProject({ sessionCwd: otherCwd, projectId: 'q', rulesDir: otherRules }); const otherMaterial = await registerMaterial(other, { name: 'brief', text: 'x' });
  const prepared = await prepareChapter(other, { chapterId: 'one', inputBindings: { brief: otherMaterial.id } }); await submitChapter(other, { token: prepared.token, body: 'body' });
  await writeFile(join(other.root, 'AGENTS.md'), 'rules changed');
  await assert.rejects(exportProject(other), /rules changed|integrity/i);
  assert.equal(SchemeStore.load(other.root).state.chapters.one.stale, true);
});
