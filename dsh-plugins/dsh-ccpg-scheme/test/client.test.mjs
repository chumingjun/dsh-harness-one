import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as clientState from '../src/client-state.mjs';

import {
  artifactReference,
  chapterDefinition,
  chapterRows,
  documentOutline,
  itemStateLabel,
  createProjectRequest,
  clearPersistedDraft,
  draftStorageKey,
  executeUserAction,
  mergeArtifactIntoDraft,
  readPersistedDraft,
  referenceGroups,
  resolveDraftConflict,
  saveEditRequest,
  sessionIdFromProps,
  writePersistedDraft,
} from '../src/client-state.mjs';

test('runtime material bindings and source paths override bundled parsing hints without inventing completion', () => {
  const snapshot = {
    manifest: { chapters: [{ id: 'c', skill: 'skills/c/SKILL.md', references: [
      { title: '知识', roles: ['knowledge'], inputIds: ['Z-1'], parseStatus: 'needs-vision', status: 'downloaded' },
      { title: '模板', roles: ['output-template'], original: 'assets/template.docx', parseStatus: 'needs-vision', status: 'downloaded' },
      { title: '未使用案例', roles: ['reference-example'], original: 'references/example.docx', parseStatus: 'needs-vision', status: 'downloaded' },
    ] }] },
    state: { chapters: { c: { status: 'submitted', bindings: { 'Z-1': 'knowledge' } } }, materials: {
      knowledge: { id: 'knowledge', parseStatus: 'complete' },
      template: { id: 'template', parseStatus: 'needs-review', metadata: { sourcePath: '.dsh/skills/c/assets/template.docx', sourceSha256: 'old' } },
      reviewed: { id: 'reviewed', parseStatus: 'complete', metadata: { sourcePath: '.dsh/skills/c/assets/template.docx', sourceSha256: 'old', derivedFrom: 'template' } },
    } },
  };
  const refs = chapterDefinition(snapshot, 'c').references;
  assert.deepEqual(refs.map((ref) => ref.displayStatus), ['complete', 'complete', 'downloaded']);
  assert.equal(refs[1].materialId, 'reviewed');
  assert.equal(snapshot.manifest.chapters[0].references[0].parseStatus, 'needs-vision');
  snapshot.state.materials.template.metadata.sourceSha256 = 'new';
  assert.equal(chapterDefinition(snapshot, 'c').references[1].displayStatus, 'needs-review', 'old review must not mask a changed source');
});

test('document outline follows actual headings, keeps numeric hierarchy and ignores fenced examples', () => {
  const body = '# 4 质量目标\n\n## 4.1 总体目标\n\n### 4.1.1 服务定位\n\n```md\n## 4.8 示例\n```\n\n## 4.2 服务承诺\n\n## 4.3 测量目标';
  const outline = documentOutline(body, [{ id: '4.2.1', name: '附件', kind: 'attachment' }]);
  assert.deepEqual(outline.map((item) => item.title), ['4.1 总体目标', '4.1.1 服务定位', '4.2 服务承诺', '4.2.1 附件', '4.3 测量目标']);
  assert.deepEqual(outline.map((item) => item.depth), [1, 2, 1, 2, 1]);
  assert.equal(outline[0].anchor, 'scheme-heading-1');
  const definitions = documentOutline('', [{ id: '4.1', name: '目标', kind: 'body' }, { id: '4.2.1', name: '附件', kind: 'attachment' }]);
  assert.deepEqual(definitions.map((item) => item.title), ['4.1 目标', '4.2.1 附件']);
  assert.deepEqual(definitions.map((item) => item.kind), ['body', 'attachment']);
  assert.equal(definitions[1].outputId, '4.2.1');
});

test('output labels use the business title without duplicate numbering or internal IDs', () => {
  const snapshot = { manifest: { chapters: [{ id: 'c', outputs: [
    { id: '4.1', name: '4.1 总体目标', kind: 'body' },
    { id: 'internal-table', name: '4.2.1 服务承诺表', kind: 'attachment' },
    { id: '4.3', name: '测量目标', kind: 'body' },
  ] }] } };
  assert.deepEqual(chapterDefinition(snapshot, 'c').outputs.map(item => item.label), [
    '4.1 总体目标', '4.2.1 服务承诺表', '4.3 测量目标',
  ]);
});

test('document outline merges missing body definitions and normalizes output ids to business codes', () => {
  const outline = documentOutline('## 4.1 总体质量目标\n\n## 4.3 分项目标', [
    { id: '4.1', name: '总体质量目标', kind: 'body' },
    { id: '4.2.2', name: '4.2 物业服务项目标准及服务承诺', kind: 'body' },
    { id: '4.2.1', name: '4.2 附件', kind: 'attachment' },
    { id: '4.3', name: '分项目标', kind: 'body' },
  ]);
  assert.deepEqual(outline.map((item) => item.title), ['4.1 总体质量目标', '4.2 物业服务项目标准及服务承诺', '4.2 附件', '4.3 分项目标']);
  assert.equal(outline[1].anchor, '', 'a definition without generated body is visible but not clickable');
  assert.equal(outline.some((item) => item.kind === 'attachment'), true, 'attachments remain in the same outline');
});

test('a generated whole-chapter output is not repeated as a missing subsection', () => {
  const body = '# 1. 范围\n\n## 1. 质量计划适用范围\n\n正文\n\n## 2. 覆盖的服务项目与区域';
  const outputs = [{ id: 'scope', name: '1. 范围', kind: 'body' }];
  const outline = documentOutline(body, outputs);
  assert.deepEqual(outline.map(item => item.title), ['1. 质量计划适用范围', '2. 覆盖的服务项目与区域']);
  assert.ok(outline.every(item => item.anchor));
  assert.equal(documentOutline('', outputs)[0].anchor, '');
  assert.equal(documentOutline('已有整章正文', outputs).length, 0);
  const section = documentOutline('## 质量目标\n\n正文', [{ id: 'target', name: '质量目标', kind: 'body' }, { id: 'standard', name: '服务标准', kind: 'body' }]);
  assert.equal(section.filter(item => item.title === '质量目标').length, 1);
  assert.equal(section.find(item => item.title === '服务标准').anchor, '');
});

test('chapter publication depends on this saved chapter, not later chapters', () => {
  const snapshot = { manifest: { chapters: [{ id: 'one' }, { id: 'two' }] }, state: { revision: 4, chapters: { one: { status: 'submitted', revision: 1, artifactId: 'a' }, two: { status: 'pending' } } } };
  const artifact = { chapterId: 'one', artifactId: 'a', revision: 1, body: '正文', confirmations: [] };
  assert.equal(clientState.chapterPublicationState(snapshot, 'one', artifact, {}).canPublish, true);
  assert.equal(clientState.chapterPublicationState(snapshot, 'one', artifact, { two: { dirty: true } }).canPublish, true);
  assert.equal(clientState.chapterPublicationState(snapshot, 'one', artifact, { 'one@table': { dirty: true } }).canPublish, false);
  assert.equal(clientState.chapterPublicationState(snapshot, 'one', { ...artifact, artifactId: 'old' }, {}).canPublish, false);
  assert.equal(clientState.chapterPublicationState(snapshot, 'two', null, {}).canPublish, false);
  snapshot.state.chapters.one.pendingConfirmations = true;
  assert.equal(clientState.chapterPublicationState(snapshot, 'one', artifact, {}).canPublish, false);
  snapshot.state.chapters.one.pendingConfirmations = false;
  snapshot.state.chapters.one.stale = true;
  assert.equal(clientState.chapterPublicationState(snapshot, 'one', artifact, {}).canPublish, false);
});

test('chapter review keeps legacy body issues after editing and unions current artifact confirmations', () => {
  const artifact = { chapterId: 'one', body: '# 本章\n\n## 4.1 总体目标\n正文\n\n## 待确认事项\n- 核验人员数量', confirmations: [{ id: 'count', message: '核验面积', sectionLabel: '4.1 总体目标', sectionCode: '4.1', status: 'pending' }] };
  const first = clientState.chapterReview(artifact);
  const draft = { chapterId: 'one', body: first.body + '\n编辑', reviewItems: first.items };
  const next = clientState.chapterReview(artifact, draft);
  assert.equal(next.body.includes('待确认事项'), false);
  assert.deepEqual(next.items.map((item) => item.message), ['核验面积', '核验人员数量']);
  assert.equal(next.items[0].sectionLabel, '4.1 总体目标');
  assert.deepEqual(clientState.chapterReview({ chapterId: 'two', body: '另章', confirmations: [] }, draft).items, [], 'a previous chapter draft must not leak into this chapter');
  assert.equal(clientState.chapterReview(null, draft).body, draft.body, 'a temporarily unavailable artifact must not hide the selected chapter draft');
  assert.deepEqual(clientState.chapterReview(null, draft).items, first.items);
});

test('review locations use actual outline anchors and fall back to the chapter without guessed positions', () => {
  const outline = documentOutline('# 本章\n\n## 4.1 总体目标\n\n### 4.1.1 服务定位\n\n## 4.2 服务承诺');
  assert.equal(clientState.reviewItemAnchor({ sectionCode: '4.1.1' }, outline), 'scheme-heading-2');
  assert.equal(clientState.reviewItemAnchor({ sectionLabel: '4.2 服务承诺' }, outline), 'scheme-heading-3');
  assert.equal(clientState.reviewItemAnchor({ headingAnchor: 'scheme-heading-1' }, outline), 'scheme-heading-1');
  assert.equal(clientState.reviewItemAnchor({ headingAnchor: 'scheme-heading-99', sectionCode: '4.8' }, outline), '');
  assert.equal(clientState.reviewItemAnchor({ sectionCode: '4.1' }, documentOutline('', [{ id: '4.1', name: '目标', kind: 'body' }])), '');
});

test('editing an inline gap immediately updates review count and location before and after draft refresh', () => {
  const artifact = { chapterId: 'one', artifactId: 'a', revision: 1, body: '## 2.2 合同版本\n版本：待确认', confirmations: [] };
  const draft = { ...mergeArtifactIntoDraft(null, artifact, 1), body: '## 2.2 合同版本\n版本：现行有效', dirty: true };
  assert.deepEqual(clientState.chapterReview(artifact, draft).items, []);
  assert.deepEqual(clientState.chapterReview(artifact, mergeArtifactIntoDraft(draft, artifact, 1)).items, []);
  draft.body = '## 2.2 合同版本\n现行有效版本：待填写';
  assert.deepEqual(clientState.chapterReview(artifact, draft).items.map(item => item.message), ['现行有效版本：待填写']);
});

test('manual review status survives a same-artifact refresh and does not approve inline text gaps', () => {
  const manual = { id: 'check', message: '核对现行合同', status: 'pending' };
  const artifact = { chapterId: 'one', artifactId: 'a', revision: 1, body: '合同：待确认', confirmations: [manual] };
  const draft = { ...mergeArtifactIntoDraft(null, artifact, 1), dirty: true, reviewItems: [{ ...manual, status: 'confirmed' }] };
  const refreshed = mergeArtifactIntoDraft(draft, artifact, 2);
  const review = clientState.chapterReview(artifact, refreshed);
  assert.equal(review.items.find(item => item.id === manual.id).status, 'confirmed');
  assert.equal(review.items.filter(item => item.status === 'pending').length, 1);
});

test('review items survive persistence, incoming conflicts, and either explicit conflict resolution', () => {
  const local = { id: 'local', message: '核验人员数量', status: 'pending' };
  const incoming = { id: 'incoming', message: '核验面积', sectionLabel: '4.1 总体目标', status: 'pending' };
  const draft = { chapterId: 'one', body: '编辑正文', reviewItems: [local], dirty: true, artifactId: 'old', artifactRevision: 1 };
  const values = new Map();
  const storage = { setItem(key, value) { values.set(key, value); }, getItem(key) { return values.get(key); } };
  writePersistedDraft(storage, 'review-draft', draft);
  assert.deepEqual(readPersistedDraft(storage, 'review-draft').reviewItems, [local]);
  const conflicted = mergeArtifactIntoDraft(draft, { chapterId: 'one', body: '新正文', confirmations: [incoming], artifactId: 'new', revision: 2 }, 3);
  assert.deepEqual(conflicted.conflict.incomingReviewItems, [incoming]);
  assert.deepEqual(resolveDraftConflict(conflicted, 'incoming').reviewItems, [incoming]);
  assert.deepEqual(resolveDraftConflict(conflicted, 'overwrite').reviewItems, [incoming, local]);
  const clean = mergeArtifactIntoDraft(null, { chapterId: 'one', body: '正文', confirmations: [incoming], artifactId: 'new', revision: 2 }, 3);
  assert.deepEqual(clean.reviewItems, [incoming]);
});

test('chapter confirmation shows pending review first and cannot run from an attachment', async () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const callback = source.slice(source.indexOf('const confirm = async () => {'), source.indexOf('\n\n  const exportAll', source.indexOf('const confirm = async () => {')));
  const calls = []; let opened = false;
  const createConfirm = (selectedAttachment, showReview, pendingReview) => new Function('snapshot', 'selected', 'currentArtifact', 'selectedAttachment', 'drafts', 'showReview', 'pendingReview', 'setShowReview', 'setStatus', 'setError', 'executeUserAction', 'props', 'sessionId', 'projectId', 'loadSnapshot', `${callback}; return confirm;`)(
    { state: { revision: 3 } }, { id: 'one' }, { revision: 1 }, selectedAttachment, {}, showReview, pendingReview,
    (value) => { opened = value; }, () => {}, () => {}, async (...args) => calls.push(args), { commands: {} }, 's', 'p', async () => {},
  );
  await createConfirm({ outputId: 'table' }, false, [])();
  assert.equal(calls.length, 0);
  await createConfirm(null, false, [{ id: 'pending' }])();
  assert.equal(opened, true);
  assert.equal(calls.length, 0);
  await createConfirm(null, true, [{ id: 'pending' }])();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].chapterId, 'one');
  assert.match(source, /本章待确认 · /);
  assert.match(source, /确认本章/);
  assert.match(source, /scheme-placeholder-highlight/);
  assert.match(source, /scheme-review-heading/);
  assert.match(source, /useEffect\(\(\) => \{ setShowReview\(false\); setStatus\(''\); setError\(''\); \}, \[selected\?\.id\]\)/);
});

test('chapter navigation follows manifest natural order', () => {
  const rows = chapterRows({
    manifest: {
      chapters: [
        { id: 'chapter-10', title: 'Ten', order: 10 },
        { id: 'chapter-2', title: 'Two', order: 2 },
        { id: 'chapter-1', title: 'One', order: 1 },
      ],
    },
    state: {
      chapters: {
        'chapter-1': { status: 'submitted', revision: 2 },
        'chapter-2': { status: 'pending', stale: true },
      },
    },
  });

  assert.deepEqual(rows.map((row) => row.id), ['chapter-1', 'chapter-2', 'chapter-10']);
  assert.equal(rows[1].stale, true);
  assert.equal(rows[2].status, 'pending');
});

test('final delivery is available only after every chapter has a current generated artifact', () => {
  const snapshot = {
    manifest: { chapters: [{ id: 'last', order: 15 }, { id: 'first', order: 1 }] },
    state: { revision: 4, chapters: { first: { status: 'submitted', artifactId: 'a1' }, last: { status: 'pending' } } },
  };
  assert.equal(clientState.deliveryViewState(snapshot, null, {}).available, false);
  snapshot.state.chapters.last = { status: 'submitted', artifactId: 'a15' };
  assert.equal(clientState.deliveryViewState(snapshot, null, {}).available, true);
  for (const state of [
    { status: 'pending' },
    { status: 'skipped' },
    { status: 'submitted' },
    { status: 'submitted', artifactId: 'a1', stale: true },
    { status: 'running', artifactId: 'a1' },
  ]) {
    snapshot.state.chapters.first = state;
    const view = clientState.deliveryViewState(snapshot, { revision: 4, complete: true }, {});
    assert.equal(view.available, false, 'a generated last chapter cannot hide an incomplete earlier chapter');
    assert.equal(view.ready, false, 'cached delivery cannot bypass current chapter readiness');
    assert.equal(view.canPublish, false);
  }
  snapshot.state.chapters.first = { status: 'confirmed', artifactId: 'a1' };
  assert.equal(clientState.deliveryViewState(snapshot, null, {}).available, true);
  assert.equal(clientState.deliveryViewState({ manifest: { chapters: [] }, state: {} }, null, {}).available, false);
  snapshot.state.chapters.last.stale = true;
  assert.equal(clientState.deliveryViewState(snapshot, null, {}).available, false);
});

test('delivery actions require the current saved revision and publishing requires complete results', () => {
  const snapshot = { manifest: { chapters: [{ id: 'last', order: 15 }] }, state: { revision: 4, chapters: { last: { status: 'submitted', artifactId: 'a' } } } };
  const delivery = { revision: 4, complete: true };
  assert.deepEqual(clientState.deliveryViewState(snapshot, delivery, {}), { available: true, dirty: false, stale: false, ready: true, canPublish: true });
  assert.equal(clientState.deliveryViewState(snapshot, { ...delivery, complete: false }, {}).canPublish, false);
  const changed = clientState.deliveryViewState({ ...snapshot, state: { ...snapshot.state, revision: 5 } }, delivery, {});
  assert.equal(changed.stale, true);
  assert.equal(changed.ready, false);
  assert.equal(changed.canPublish, false);
  const unsaved = clientState.deliveryViewState(snapshot, delivery, { last: { dirty: true } });
  assert.equal(unsaved.dirty, true);
  assert.equal(unsaved.ready, false);
  assert.equal(unsaved.canPublish, false);
});

test('final delivery replaces chapter actions rather than appending a duplicate export panel', () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /汇总全文|scheme-export-preview|showExportPreview/);
  assert.match(source, /查看全文与导出/);
  assert.match(source, /cloudState.label/);
  assert.match(source, /deliveryViewState/);
  assert.match(source, /showDelivery \? <DeliveryView/);
  assert.match(source, /!showDelivery && <ListsPanel/);
});

test('cloud publication controls keep historical links and update only after saved chapter content changes', () => {
  const snapshot = { state: { revision: 100, chapters: { one: { artifactId: 'a', revision: 1 }, two: { artifactId: 'b', revision: 2 } } } };
  const publication = { verified: true, layoutVersion: 2, body: { url: 'https://example.feishu.cn/docx/original' }, chapters: [{ chapterId: 'one', artifactId: 'a', revision: 1 }] };
  assert.deepEqual(clientState.publicationControls(snapshot, { ...publication, layoutVersion: undefined }), { label: '整理飞书目录', disabled: false });
  assert.deepEqual(clientState.publicationControls(snapshot, publication), { label: '已同步到飞书', disabled: true });
  snapshot.state.chapters.two.revision++;
  assert.equal(clientState.publicationControls(snapshot, publication).disabled, true, 'other chapter changes never recreate this chapter');
  snapshot.state.chapters.one.revision++;
  assert.deepEqual(clientState.publicationControls(snapshot, publication), { label: '更新飞书文档', disabled: false });
  assert.equal(clientState.publicationControls(snapshot, { ...publication, blocked: true }).disabled, true);
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  assert.match(source, /snapshot\?\.publications\?\.\[selected\?\.id\]/);
  assert.match(source, /snapshot\?\.publications\?\.full/);
  assert.match(source, /发布历史/);
});

test('delivery entry is above the chapter directory, and the browser reuses the native results view', () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const shell = source.slice(source.indexOf('<div className="scheme-shell">'));
  assert(shell.indexOf('查看全文与导出') < shell.indexOf('<nav>'), 'delivery entry must not be buried after the chapter list');
  assert.equal(shell.split('查看全文与导出').length - 1, 1, 'one entry avoids duplicate actions');
  assert.match(source, /export function SchemeResultsTab/);
  const browser = readFileSync(new URL('../src/browser.jsx', import.meta.url), 'utf8');
  assert.match(browser, /import \{ SchemeResultsTab \} from '\.\/client\.jsx'/);
  assert.match(browser, /<SchemeResultsTab/);
  assert.match(browser, /readOnly/);
  assert.doesNotMatch(browser, /function BrowserResults|function Markdown|function Detail/);
});

test('Feishu delivery publishing uses the native user action and does not report unverified writes as success', async () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('const publishDelivery = async () => {');
  assert.notEqual(start, -1, 'final view has a publication action');
  const callback = source.slice(start, source.indexOf('\n  };', start) + 5);
  const calls = []; const statuses = []; const errors = []; let publication;
  const createPublish = (result, canPublish = true) => new Function('deliveryState', 'deliveryBusy', 'setDeliveryBusy', 'setError', 'setStatus', 'executeUserAction', 'props', 'sessionId', 'projectId', 'snapshot', 'delivery', 'setPublication', `${callback}; return publishDelivery;`)(
    { canPublish }, false, () => {}, (value) => errors.push(value), (value) => statuses.push(value),
    async (...args) => { calls.push(args); return { result }; }, { commands: {} }, 's', 'p', { manifest: { title: '项目质量计划' } }, { revision: 4 }, (value) => { publication = value; },
  );
  await createPublish({ ok: true, verified: true, folder: { url: 'https://example.invalid/folder' }, body: { url: 'https://example.invalid/body' } })();
  assert.deepEqual(calls[0][2], { action: 'publish', projectId: 'p', title: '项目质量计划', revision: 4 });
  assert.equal(publication.folder.url, 'https://example.invalid/folder');
  assert.match(statuses.at(-1), /已保存/);
  await createPublish({ ok: false, code: 'uncertain', error: '附件尚未核验' })();
  assert.match(errors.at(-1), /uncertain.*附件尚未核验/);
  await createPublish({ ok: true, verified: false })();
  assert.match(errors.at(-1), /核验/);
  const count = calls.length;
  await createPublish({ ok: true, verified: true }, false)();
  assert.equal(calls.length, count, 'incomplete or stale delivery cannot publish');
});

test('chapter publication passes the selected saved chapter revision and only retains verified links', async () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('const publishChapter = async () => {');
  assert.notEqual(start, -1, 'each chapter has a native publication action');
  const callback = source.slice(start, source.indexOf('\n  };', start) + 5);
  const calls = []; const errors = []; let publications = {};
  const make = (result, canPublish = true) => new Function('chapterPublication', 'deliveryBusy', 'setDeliveryBusy', 'setError', 'setStatus', 'executeUserAction', 'props', 'sessionId', 'projectId', 'snapshot', 'selected', 'currentArtifact', 'chapterLabel', 'setChapterPublications', `${callback}; return publishChapter;`)(
    { canPublish }, false, () => {}, (value) => errors.push(value), () => {},
    async (...args) => { calls.push(args); return { result }; }, { commands: {} }, 's', 'p', { state: { revision: 4 } }, { id: 'one' }, { artifactId: 'art-1', revision: 1 }, '1. 范围', (fn) => { publications = fn(publications); },
  );
  await make({ ok: true, verified: true, body: { url: 'https://example.invalid/body' } })();
  assert.deepEqual(calls[0][2], { action: 'publish', projectId: 'p', chapterId: 'one', title: '1. 范围', revision: 4, artifactRevision: 1 });
  assert.equal(publications.one.body.url, 'https://example.invalid/body');
  publications = {};
  await make({ ok: true, verified: false })();
  assert.deepEqual(publications, {});
  assert.match(errors.at(-1), /核验/);
  const count = calls.length;
  await make({ ok: true, verified: true }, false)();
  assert.equal(calls.length, count);
  assert.match(source, /chapterPublications\[selected\?\.id\]/);
});

test('bundled knowledge appears only under knowledge dependencies and keeps its parse status', () => {
  const snapshot = { manifest: { chapters: [{ id: 'c', inputs: [{ id: 'Z-1', required: true }, { id: 'IN-1', required: true }], references: [{ title: '知识', inputIds: ['Z-1'], roles: ['knowledge'], status: 'downloaded', content: 'references/正文.md', parseStatus: 'needs-vision' }] }] }, state: {} };
  const detail = chapterDefinition(snapshot, 'c');
  assert.deepEqual(detail.inputs.map((item) => item.id), ['IN-1']);
  assert.equal(detail.inputs[0].status, 'missing');
  const [group] = referenceGroups(detail.references);
  assert.equal(group.label, '知识依赖');
  assert.equal(group.items[0].title, snapshot.manifest.chapters[0].references[0].title);
  assert.equal(group.items[0].displayStatus, 'downloaded');
  assert.equal(group.items[0].parseStatus, 'needs-vision');
  assert.equal(group.items[0].sourceParseStatus, 'needs-vision');
  assert.equal(group.items[0].original, '');
  assert.equal(group.items[0].content, 'references/正文.md');
  assert.equal(snapshot.manifest.chapters[0].inputs.length, 2);
});

test('reference details keep source and packaged files while runtime state wins', () => {
  const snapshot = {
    manifest: { chapters: [{
      id: 'c',
      skill: 'skills/c/SKILL.md',
      references: [{
        title: '模板',
        roles: ['output-template'],
        source: 'https://example.invalid/template',
        original: 'assets/template.docx',
        content: 'assets/template.md',
        status: 'downloaded',
        parseStatus: 'needs-vision',
      }],
    }] },
    state: { materials: {
      parsed: {
        id: 'parsed',
        parseStatus: 'complete',
        metadata: { sourcePath: '.dsh/skills/c/assets/template.md' },
      },
    } },
  };
  const [reference] = chapterDefinition(snapshot, 'c').references;
  assert.equal(reference.materialId, 'parsed');
  assert.equal(reference.displayStatus, 'complete');
  assert.equal(reference.source, 'https://example.invalid/template');
  assert.equal(reference.original, 'assets/template.docx');
  assert.equal(reference.content, 'assets/template.md');
});

test('knowledge classification uses roles and associations even when resources are unavailable', () => {
  const snapshot = {
    manifest: { chapters: [{
      id: 'c',
      inputs: [{ id: 'knowledge', required: true }, { id: 'shared', required: true }, { id: 'project', name: '知识库现场采集表', required: true }],
      references: [
        { title: '未下载知识', inputIds: ['knowledge'], roles: ['knowledge'], status: 'missing' },
        { title: '多用途知识', inputIds: ['shared'], roles: ['knowledge', 'output-template'], status: 'downloaded', parseStatus: 'complete' },
        { title: '采集模板', inputIds: ['project'], roles: ['collection-template'], status: 'downloaded' },
      ],
    }] },
    state: { materials: { m1: { name: '项目材料', parseStatus: 'complete' } }, chapters: { c: { bindings: { project: 'm1' } } } },
  };
  const detail = chapterDefinition(snapshot, 'c');
  assert.deepEqual(detail.inputs.map((item) => item.id), ['project']);
  assert.equal(detail.inputs[0].material.name, '项目材料');
  const groups = referenceGroups(detail.references);
  assert.deepEqual(groups.map((group) => group.label), ['知识依赖', '输出模板', '采集模板']);
  assert.deepEqual(groups[0].items.map((item) => item.status), ['missing', 'downloaded']);
  assert.equal(groups[1].items[0].title, '多用途知识');
});

test('chapter definitions expose business codes, bindings, dependencies, outputs and resource roles', () => {
  const snapshot = {
    manifest: { chapters: [
      { id: 'chapter-2', code: '2', title: '前章', order: 2 },
      { id: 'chapter-8-1', code: '8.1', title: '子章', order: 8, dependencies: ['chapter-2'], inputs: [{ id: 'required', name: '必填', required: true }, { id: 'optional', name: '可选', required: false }], outputs: [{ id: '8.1', name: '正文', kind: 'body' }], references: [{ title: '模板', roles: ['output-template'] }, { title: '知识', roles: ['knowledge'] }] },
    ] },
    state: { materials: { m1: { id: 'm1', name: '材料', parseStatus: 'complete' } }, chapters: { 'chapter-2': { status: 'submitted', artifactId: 'a2' }, 'chapter-8-1': { bindings: { required: 'm1' } } } },
  };
  assert.equal(chapterRows(snapshot)[1].code, '8.1');
  const detail = chapterDefinition(snapshot, 'chapter-8-1');
  assert.equal(detail.inputs[0].material.name, '材料');
  assert.equal(detail.inputs[0].status, 'complete');
  assert.equal(detail.inputs[1].status, 'optional');
  assert.deepEqual(detail.dependencies[0], { id: 'chapter-2', code: '2', title: '前章', status: 'submitted', artifactId: 'a2' });
  assert.equal(detail.outputs[0].id, '8.1');
  assert.equal(detail.outputs[0].status, 'pending');
  assert.deepEqual(referenceGroups(detail.references).map((group) => group.label), ['输出模板', '知识依赖']);
});

test('result panels share readable material and output status labels', () => {
  assert.equal(itemStateLabel('needs-vision'), '待模型解读');
  assert.equal(itemStateLabel('interrupted'), '已中断');
  const snapshot = {
    manifest: { chapters: [{ id: 'c', outputs: [
      { id: 'c-body', name: '正文', kind: 'body' },
      { id: 'c-attachment', name: '附件', kind: 'attachment' },
    ] }] },
    state: { chapters: { c: { status: 'submitted', artifactId: 'a' } } },
  };
  const detail = chapterDefinition(snapshot, 'c', { attachments: [{ outputId: 'c-attachment', name: '附件.md' }] });
  assert.deepEqual(detail.outputs.map((item) => item.status), ['submitted', 'submitted']);
});

test('unresolved requiredness stays unknown and shared resources appear under every role', () => {
  const snapshot = { manifest: { chapters: [{ id: 'one', inputs: [{ id: 'maybe', required: 'unknown' }] }] }, state: { chapters: { one: {} } } };
  assert.equal(chapterDefinition(snapshot, 'one').inputs[0].required, 'unknown');
  assert.equal(chapterDefinition(snapshot, 'one').inputs[0].status, 'undecided');
  snapshot.state.chapters.one.decisions = { maybe: 'not_required' };
  assert.equal(chapterDefinition(snapshot, 'one').inputs[0].required, false);
  const groups = referenceGroups([{ title: '共用资源', roles: ['knowledge', 'output-template', 'knowledge'] }]);
  assert.deepEqual(groups.map((group) => group.label), ['知识依赖', '输出模板']);
  assert.ok(groups.every((group) => group.items.length === 1));
});

test('drafts survive background artifact updates and expose conflicts', () => {
  const state = {
    chapterId: 'chapter-1',
    body: 'user draft',
    dirty: true,
    artifactRevision: 1,
    artifactId: 'art-old',
  };
  const next = mergeArtifactIntoDraft(state, {
    chapterId: 'chapter-1',
    body: 'server body',
    revision: 2,
    artifactId: 'art-new',
  });

  assert.equal(next.body, 'user draft');
  assert.equal(next.dirty, true);
  assert.equal(next.conflict.incomingBody, 'server body');
  assert.equal(next.conflict.artifactRevision, 2);
});

test('dirty draft stays dirty when the same artifact is polled again', () => {
  const next = mergeArtifactIntoDraft({
    chapterId: 'chapter-1',
    body: 'user draft',
    dirty: true,
    artifactRevision: 1,
    artifactId: 'art-1',
    baseRevision: 3,
  }, {
    chapterId: 'chapter-1',
    body: 'server body',
    revision: 1,
    artifactId: 'art-1',
  }, 4);
  assert.equal(next.body, 'user draft');
  assert.equal(next.dirty, true);
  assert.equal(next.baseRevision, 4);
  assert.equal(next.conflict, null);
  assert.equal(saveEditRequest({ projectId: 'p', revision: next.baseRevision, chapterId: next.chapterId, artifactRevision: next.artifactRevision, body: next.body }).revision, 4);
});

test('clean drafts adopt incoming artifact revisions', () => {
  const next = mergeArtifactIntoDraft({
    chapterId: 'chapter-1',
    body: 'old body',
    dirty: false,
    artifactRevision: 1,
    artifactId: 'art-old',
  }, {
    chapterId: 'chapter-1',
    body: 'server body',
    revision: 2,
    artifactId: 'art-new',
  });

  assert.equal(next.body, 'server body');
  assert.equal(next.artifactRevision, 2);
  assert.equal(next.artifactId, 'art-new');
  assert.equal(next.conflict, null);
});

test('save requests carry project and artifact revision CAS', () => {
  assert.deepEqual(saveEditRequest({
    projectId: 'scheme-a',
    revision: 7,
    chapterId: 'chapter-1',
    artifactRevision: 3,
    body: 'updated',
  }), {
    projectId: 'scheme-a',
    chapterId: 'chapter-1',
    revision: 7,
    artifactRevision: 3,
    body: 'updated',
  });
});

test('draft persistence survives an unmount without using credentials storage', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const key = draftStorageKey('native-session', 'scheme-a', 'chapter-1');
  writePersistedDraft(storage, key, {
    chapterId: 'chapter-1',
    body: 'unsaved body',
    dirty: true,
    artifactRevision: 4,
    artifactId: 'art-4',
  });
  assert.deepEqual(readPersistedDraft(storage, key), {
    chapterId: 'chapter-1',
    body: 'unsaved body',
    dirty: true,
    artifactRevision: 4,
    artifactId: 'art-4',
    baseRevision: 0,
    conflict: null,
  });
  clearPersistedDraft(storage, key);
  assert.equal(readPersistedDraft(storage, key), null);
});

test('conflict save keeps the authored base revision until explicit resolution', () => {
  const draft = mergeArtifactIntoDraft({
    chapterId: 'chapter-1',
    body: 'user body',
    dirty: true,
    artifactRevision: 4,
    artifactId: 'art-4',
  }, {
    chapterId: 'chapter-1',
    body: 'incoming body',
    revision: 5,
    artifactId: 'art-5',
  });
  assert.equal(draft.artifactRevision, 4);
  assert.equal(draft.conflict.artifactRevision, 5);
  assert.throws(() => saveEditRequest({
    projectId: 'scheme-a',
    revision: 8,
    chapterId: draft.chapterId,
    artifactRevision: draft.artifactRevision,
    body: draft.body,
    conflict: draft.conflict,
  }), /resolve artifact conflict/i);
  const overwrite = resolveDraftConflict(draft, 'overwrite');
  assert.equal(overwrite.artifactRevision, 5);
  assert.equal(overwrite.dirty, true);
  assert.equal(overwrite.conflict, null);
  assert.equal(saveEditRequest({
    projectId: 'scheme-a',
    revision: 8,
    chapterId: overwrite.chapterId,
    artifactRevision: overwrite.artifactRevision,
    body: overwrite.body,
  }).artifactRevision, 5);
});

test('incoming conflict resolution replaces the draft explicitly', () => {
  const draft = mergeArtifactIntoDraft({
    chapterId: 'chapter-1',
    body: 'user body',
    dirty: true,
    artifactRevision: 1,
    artifactId: 'art-1',
  }, {
    chapterId: 'chapter-1',
    body: 'incoming body',
    revision: 2,
    artifactId: 'art-2',
  });
  const resolved = resolveDraftConflict(draft, 'incoming');
  assert.equal(resolved.body, 'incoming body');
  assert.equal(resolved.dirty, false);
  assert.equal(resolved.artifactRevision, 2);
});

test('create request initializes current cwd without a directory picker', () => {
  assert.deepEqual(createProjectRequest(' scheme-a '), { projectId: 'scheme-a' });
  assert.throws(() => createProjectRequest(''), /project id/i);
});

test('results panel is view-only before conversation starts the scheme', () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  assert.match(source, /方案尚未开始/);
  assert.doesNotMatch(source, /项目 ID|开始生成方案|材料文件夹：materials\/input/);
});

test('results reads use the native connection and report startup failures visibly', async () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function apiJson('), source.indexOf('\nfunction draftStorage'));
  const calls = []; const snapshot = { state: { projectId: 'p' } };
  const api = new Function('apiUrl', 'fetch', `${fn}; return apiJson;`)(() => '/test-only', async () => ({ ok: true, async json() { return snapshot; } }));
  const connection = { rpc: { async call(...args) { calls.push(args); return { ok: true, value: snapshot }; } } };
  assert.deepEqual(await api('', 'native', { connection }), snapshot);
  assert.deepEqual(calls, [['/api', 'ccpgSchemeResults/read', { args: { payload: { sessionId: 'native', action: 'status' } } }]]);
  await api('/artifact', 'native', { connection, params: { projectId: 'p', chapterId: 'one' } });
  assert.equal(calls.at(-1)[2].args.payload.action, 'artifact');
  connection.rpc.call = async () => ({ ok: false, error: { code: 'internal', message: 'project-required: no workspace' } });
  await assert.rejects(api('', 'native', { connection }), (error) => error.code === 'project-required');
  await assert.rejects(api('/confirm', 'native', { connection }), /read action/);
  assert.doesNotMatch(fn, /fetch\(/);
  assert.match(source, /if \(!snapshot\).*error.*scheme-error.*role="alert"/);
});

test('artifact polling skips empty chapters, preserves drafts, and uses the newest snapshot', async () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const callback = source.slice(source.indexOf('const loadArtifact = useCallback('), source.indexOf('\n\n  useEffect', source.indexOf('const loadArtifact = useCallback(')));
  const calls = []; const errors = []; let artifact; let drafts = {};
  const snapshot = { state: { revision: 1, chapters: { one: { status: 'pending' } } } };
  const persisted = { chapterId: 'one', body: 'unsaved body', dirty: true, artifactId: 'old', artifactRevision: 1 };
  const incoming = { chapterId: 'one', body: 'submitted body', artifactId: 'new', revision: 2 };
  const load = new Function('useCallback', 'selected', 'snapshot', 'sessionId', 'projectId', 'apiJson', 'setArtifact', 'setDrafts', 'mergeArtifactIntoDraft', 'readPersistedDraft', 'draftStorage', 'draftStorageKey', 'setError', 'props', `${callback}; return loadArtifact;`)(
    (fn) => fn, { id: 'one' }, snapshot, 's1', 'p',
    async (...args) => { calls.push(args); return incoming; },
    (value) => { artifact = value; }, (update) => { drafts = update(drafts); },
    mergeArtifactIntoDraft, () => persisted, () => null, draftStorageKey, (value) => errors.push(value), { connection: {} },
  );
  await load();
  assert.equal(calls.length, 0);
  assert.equal(artifact, null);
  assert.deepEqual(drafts.one, persisted);
  const latest = { state: { revision: 5, chapters: { one: { artifactId: 'new' } } } };
  await load('one', latest);
  assert.equal(calls.length, 1);
  assert.equal(artifact, incoming);
  assert.equal(drafts.one.body, 'unsaved body');
  assert.equal(drafts.one.conflict.projectRevision, 5);
  assert.equal(drafts.one.conflict.incomingBody, 'submitted body');
  assert.deepEqual(errors, []);
});

test('session identity comes from native props only', () => {
  assert.equal(sessionIdFromProps({ sessionId: 'direct' }), 'direct');
  assert.equal(sessionIdFromProps({ session: { sessionId: 'session' } }), 'session');
  assert.equal(sessionIdFromProps({ owner: { session: { id: 'owner' } } }), 'owner');
  assert.equal(sessionIdFromProps({}), '');
});

test('AI edit references are precise and copyable', () => {
  assert.equal(
    artifactReference({ projectId: 'scheme-a', chapterId: 'chapter-1', artifactId: 'art-1', artifactRevision: 4 }),
    'CCPG scheme-a chapter=chapter-1 artifact=art-1 artifactRevision=4',
  );
});

test('client registers a native results tab and safe markdown rendering', () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  assert.match(source, /registerTab/);
  assert.match(source, /rehype-sanitize/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|<iframe|localStorage|chapter_confirm/);
  assert.doesNotMatch(source, /apiJson\('\/(?:edit|confirm)'/);
  assert.match(source, /remote\.commands/);
});

test('native results tab captures commands in the injected registration scope', () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(metadata.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-commands'));
  const applySource = source.slice(source.indexOf('export function apply(ctx)'), source.indexOf("export const name ="))
    .replace('export function', 'function')
    .replace(/<SchemeResultsTab \{\.\.\.props\} commands=\{([^}]+)\} connection=\{([^}]+)\} \/>/, '({ ...props, commands: $1, connection: $2 })');
  const applyClient = new Function('SchemeIcon', `${applySource}; return apply;`)(() => null);
  let injected = true; let tab; const commands = { execute() {} }; const connection = { rpc: { call() {} } };
  const scope = { effect(callback) { return callback(); }, betterSidebar: { registerTab(value) { tab = value; } }, get remote() { if (!injected) throw new Error('cannot get property remote without inject'); return { commands }; }, get connection() { if (!injected) throw new Error('connection outside inject'); return connection; } };
  applyClient({ inject(names, callback) { assert.deepEqual(names, ['betterSidebar', 'remote', 'remote.commands', 'connection']); callback(scope); } });
  injected = false;
  assert.equal(tab.component({ sessionId: 's1' }).commands, commands);
  assert.equal(tab.component({ sessionId: 's1' }).connection, connection);
});

test('result mutations use native user commands without model prompts or HTTP writes', async () => {
  const calls = [];
  const remote = { async execute(...args) {
    calls.push(args);
    return { ok: true, value: { commandId: 'user-1', result: { kind: 'success', text: JSON.stringify({ result: { revision: 2 } }) } } };
  } };
  const payload = { action: 'edit', projectId: 'p', chapterId: 'one', body: '# exact\n55', revision: 1, artifactRevision: 1 };
  assert.deepEqual(await executeUserAction(remote, 'session-1', payload), { result: { revision: 2 } });
  assert.equal(calls[0][0], 'session-1');
  assert.deepEqual(JSON.parse(calls[0][1].slice('/ccpg-scheme '.length)), payload);
  assert.deepEqual(calls[0][2], []);
  await assert.rejects(executeUserAction(null, 'session-1', payload), /unavailable/);
  await assert.rejects(executeUserAction(remote, '', payload), /session/);
  await assert.rejects(executeUserAction({ async execute() { return { ok: false, error: { message: 'transport refused' } }; } }, 's', payload), /transport refused/);
  await assert.rejects(executeUserAction({ async execute() { return { ok: true, value: { result: { kind: 'error', text: 'revision conflict' } } }; } }, 's', payload), /revision conflict/);
  await assert.rejects(executeUserAction({ async execute() { return { ok: true }; } }, 's', payload), /unavailable/);
});

test('Word download uses native revision-bound export and refuses stale or missing output', async () => {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('const downloadWord = async');
  assert.ok(start > 0, 'Word download must be exposed by the delivery view');
  const callback = source.slice(start, source.indexOf('\n\n  const saveDelivery', start));
  const calls = []; const downloads = []; const errors = []; const statuses = [];
  const state = { ready: true }; let response = { result: { wordPath: '/local/完整方案.docx', base64: 'UEs=' } };
  const download = new Function('deliveryState', 'deliveryBusy', 'setDeliveryBusy', 'setError', 'setStatus', 'executeUserAction', 'props', 'sessionId', 'projectId', 'delivery', 'attachmentBytes', 'downloadBlob', 'Blob', `${callback}; return downloadWord;`)(
    state, false, () => {}, (value) => errors.push(value), (value) => statuses.push(value),
    async (...args) => { calls.push(args); return response; }, { commands: {} }, 'session', 'p', { revision: 8 },
    (item) => Buffer.from(item.base64, 'base64'), (blob, name) => downloads.push({ blob, name }), Blob,
  );
  await download();
  assert.deepEqual(calls[0][2], { action: 'export', format: 'docx', projectId: 'p', revision: 8 });
  assert.equal(downloads[0].name, 'p.docx');
  assert.equal(downloads[0].blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.deepEqual(Buffer.from(await downloads[0].blob.arrayBuffer()), Buffer.from('PK'));
  state.ready = false;
  await download(); assert.equal(calls.length, 1);
  state.ready = true; response = { result: { directory: 'saved-without-word' } };
  await download(); assert.equal(downloads.length, 1);
  assert.match(errors.at(-1), /Word/);
  assert.equal(statuses.at(-1), '');
});
