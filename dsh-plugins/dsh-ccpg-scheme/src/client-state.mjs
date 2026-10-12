import { documentReview } from '../lib/document-review.js';

export const ITEM_STATE_LABELS = {
  complete: '已解析',
  'needs-review': '待内容核对',
  'needs-vision': '待模型解读',
  undecided: '待确认',
  missing: '缺失',
  optional: '可选',
  submitted: '已生成',
  confirmed: '已确认',
  pending: '未生成',
  downloaded: '已内置',
  skipped: '已跳过',
  interrupted: '已中断',
  running: '执行中',
  stale: '需更新',
};

export function itemStateLabel(value) {
  return ITEM_STATE_LABELS[value] || value || '待处理';
}

export function chapterRows(snapshot) {
  const manifest = snapshot?.manifest || {};
  const states = snapshot?.state?.chapters || {};
  return [...(manifest.chapters || [])]
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)))
    .map((chapter) => ({
      ...chapter,
      status: states[chapter.id]?.status || 'pending',
      stale: Boolean(states[chapter.id]?.stale),
      revision: states[chapter.id]?.revision || 0,
      artifactId: states[chapter.id]?.artifactId || '',
      pendingConfirmations: Boolean(states[chapter.id]?.pendingConfirmations),
    }));
}

export function deliveryViewState(snapshot, delivery, drafts = {}) {
  const chapters = chapterRows(snapshot);
  const available = chapters.length > 0 && chapters.every((chapter) => chapter.artifactId && !chapter.stale && ['submitted', 'confirmed'].includes(chapter.status));
  const dirty = Object.values(drafts).some((draft) => draft?.dirty);
  const stale = Boolean(delivery && delivery.revision !== snapshot?.state?.revision);
  const ready = Boolean(available && delivery && !stale && !dirty);
  return { available, dirty, stale, ready, canPublish: ready && delivery.complete === true };
}

export function chapterPublicationState(snapshot, chapterId, artifact, drafts = {}) {
  const chapter = snapshot?.manifest?.chapters?.find((item) => item.id === chapterId);
  const state = snapshot?.state?.chapters?.[chapterId];
  let reason = '';
  if (!chapter || !state?.artifactId || !['submitted', 'confirmed'].includes(state.status)) reason = '本章尚未生成';
  else if (state.stale || artifact?.artifactId !== state.artifactId || artifact?.chapterId !== chapterId || artifact?.revision !== state.revision) reason = '本章成果需更新，请等待加载最新版本';
  else if (Object.entries(drafts).some(([key, draft]) => key.split('@')[0] === chapterId && draft?.dirty)) reason = '请先保存本章正文和附件修改';
  else if (state.pendingConfirmations || !state.confirmed && (chapter.confirmations || []).some((item) => item.required === true)
    || documentReview({ ...artifact, confirmed: state.confirmed }).items.some((item) => !['confirmed', 'not_required'].includes(item.status))) reason = '请先处理本章待确认事项并确认本章';
  return { canPublish: !reason, reason };
}

export function publicationControls(snapshot, publication) {
  if (publication?.blocked) return { label: '发布结果待核对', disabled: true };
  if (!publication?.verified) return { label: '转为飞书云文档', disabled: false };
  if (publication.layoutVersion !== 2) return { label: '整理飞书目录', disabled: false };
  const synced = publication.chapters?.length > 0 && publication.chapters.every((item) => {
    const current = snapshot?.state?.chapters?.[item.chapterId];
    return current?.artifactId === item.artifactId && current?.revision === item.revision;
  });
  return { label: synced ? '已同步到飞书' : '更新飞书文档', disabled: synced };
}

export function chapterDefinition(snapshot, chapterId, artifact = null) {
  const chapter = snapshot?.manifest?.chapters?.find((item) => item.id === chapterId) || {};
  const state = snapshot?.state || {};
  const current = state.chapters?.[chapterId] || {};
  const materials = state.materials || {};
  const bindings = current.bindings || current.token?.bindings || {};
  const decisions = current.token?.decisions || current.decisions || {};
  const chapterById = new Map((snapshot?.manifest?.chapters || []).map((item) => [item.id, item]));
  const knowledgeInputIds = new Set((chapter.references || [])
    .filter((item) => item.roles?.includes('knowledge'))
    .flatMap((item) => item.inputIds || []));
  return {
    inputs: (chapter.inputs || []).filter((input) => !knowledgeInputIds.has(input.id)).map((input) => {
      const materialId = bindings[input.id] || '';
      const material = materials[materialId];
      const required = decisions[input.id] === 'required' ? true : decisions[input.id] === 'not_required' ? false : input.required;
      return { ...input, required, materialId, material, status: material ? material.parseStatus || 'available' : required === 'unknown' ? 'undecided' : required ? 'missing' : 'optional' };
    }),
    dependencies: (chapter.dependencies || []).map((id) => {
      const definition = chapterById.get(id) || { id, code: id, title: id };
      const dependencyState = state.chapters?.[id] || {};
      return { id, code: definition.code || id, title: definition.title || id, status: dependencyState.status || 'pending', artifactId: dependencyState.artifactId || '' };
    }),
    outputs: (chapter.outputs || []).map((output) => {
      const generated = output.kind === 'attachment'
        ? (artifact?.attachments || []).some((item) => item.outputId === output.id)
        : Boolean(current.artifactId);
      return { ...output, label: outputOutlineItem(output, 0).title, status: current.stale ? 'stale' : generated ? 'submitted' : current.status === 'skipped' ? 'skipped' : 'pending' };
    }),
    references: (chapter.references || []).map((reference) => {
      const bound = (reference.inputIds || []).map((id) => materials[bindings[id]]).filter(Boolean);
      const skillDir = String(chapter.skill || '').replace(/\/SKILL\.md$/, '');
      const paths = [reference.original, reference.content].filter(Boolean).map((path) => `.dsh/${skillDir}/${path}`);
      const sourced = Object.values(materials).filter((item) => paths.includes(item.metadata?.sourcePath));
      const originals = sourced.filter((item) => !item.metadata?.derivedFrom);
      const candidates = [...bound, ...sourced.filter((item) => !item.metadata?.derivedFrom || originals.some((original) => original.id === item.metadata.derivedFrom && original.metadata?.sourceSha256 === item.metadata.sourceSha256))];
      const material = candidates.find((item) => item.parseStatus === 'complete') || candidates.at(-1);
      const sourceParseStatus = material?.parseStatus || reference.parseStatus || '';
      // A bundled resource marked needs-vision in legacy metadata is not a
      // current runtime blocker when its packaged files are available.
      const displayStatus = material?.parseStatus
        || (reference.status === 'downloaded' ? 'downloaded' : reference.status || sourceParseStatus || 'missing');
      return {
        ...reference,
        source: reference.source || '',
        original: reference.original || '',
        content: reference.content || '',
        material,
        materialId: material?.id || '',
        sourceParseStatus,
        displayStatus,
      };
    }),
  };
}

function outlineCode(value) {
  return String(value || '').match(/^(\d+(?:\.\d+)+)(?:[.、]?\s|$)/)?.[1] || '';
}

function compareOutlineCodes(left, right) {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function outputOutlineItem(item, sourceIndex) {
  const name = String(item?.name || item?.id || '').trim();
  const code = item?.kind === 'attachment'
    ? outlineCode(item?.id) || outlineCode(name)
    : outlineCode(name) || outlineCode(item?.id);
  const title = code && !outlineCode(name) ? `${code} ${name}` : name;
  return {
    title,
    code,
    outputId: item?.id || '',
    kind: item?.kind || 'body',
    depth: code ? Math.max(1, code.split('.').length - 1) : 1,
    anchor: '',
    sourceIndex,
  };
}

export function documentOutline(body = '', outputs = []) {
  const headings = []; let fence = null; let index = 0;
  for (const line of String(body).split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (!heading) continue;
    const title = heading[2].replace(/[*`]/g, '');
    const code = outlineCode(title);
    const anchor = `scheme-heading-${index++}`;
    if (heading[1].length === 1 && !code) continue;
    headings.push({ title, code, anchor, kind: 'body', depth: code ? Math.max(1, code.split('.').length - 1) : Math.max(1, heading[1].length - 1), sourceIndex: headings.length });
  }
  const definitions = outputs
    .filter((item) => item.kind === 'body' || item.kind === 'attachment')
    .map((item, outputIndex) => outputOutlineItem(item, headings.length + outputIndex));
  const merged = [...headings];
  const bodyDefinitions = definitions.filter((item) => item.kind === 'body');
  const titleKey = (title) => title.replace(/^\d+(?:\.\d+)*[.、]?\s*/, '').trim();
  for (const item of definitions) {
    if (!item.title || merged.some((heading) => heading.outputId && heading.outputId === item.outputId)
      || (item.kind === 'body' && (
        !item.code && bodyDefinitions.length === 1 && String(body).trim()
        || merged.some((heading) => heading.kind === 'body' && (item.code && heading.code === item.code || titleKey(heading.title) === titleKey(item.title)))
      ))) continue;
    merged.push(item);
  }
  return merged
    .sort((left, right) => {
      if (left.code && right.code) return compareOutlineCodes(left.code, right.code);
      if (left.code) return -1;
      if (right.code) return 1;
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ sourceIndex, ...item }) => item);
}

function mergeReviewItems(...groups) {
  const items = [];
  for (const item of groups.flat()) {
    const location = item.sectionCode || item.sectionLabel || '';
    const index = items.findIndex((prior) => (
      item.id && !/^(body|inline)-review-/.test(item.id) && prior.id === item.id
    ) || (
      String(prior.message || '').trim() === String(item.message || '').trim()
      && (!location || !(prior.sectionCode || prior.sectionLabel) || location === (prior.sectionCode || prior.sectionLabel))
    ));
    if (index < 0) items.push(item);
    else if (item.id === items[index].id && item.status) items[index] = { ...items[index], status: item.status };
  }
  return items;
}

export function chapterReview(artifact, draft) {
  const currentDraft = !artifact || draft?.chapterId === artifact.chapterId ? draft : null;
  const saved = documentReview({ body: artifact?.body || '', confirmations: artifact?.confirmations || [] });
  return documentReview({
    body: currentDraft?.body ?? artifact?.body ?? '',
    confirmations: [...saved.items, ...(currentDraft?.reviewItems || [])],
  });
}

export function reviewItemAnchor(item, outline) {
  return (outline.find((heading) => (
    item.sectionCode && heading.code === item.sectionCode
  ) || (
    item.sectionLabel && heading.title === item.sectionLabel
  )) || outline.find((heading) => item.headingAnchor && heading.anchor === item.headingAnchor))?.anchor || '';
}

export function referenceGroups(references = []) {
  const labels = { 'knowledge': '知识依赖', 'output-template': '输出模板', 'reference-example': '参考案例', 'collection-template': '采集模板' };
  const groups = new Map();
  for (const reference of references) {
    for (const label of new Set((reference.roles?.length ? reference.roles : ['other']).map((role) => labels[role] || '其他资源'))) {
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(reference);
    }
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}

export function sessionIdFromProps(props = {}) {
  return String(
    props.sessionId
      || props.session?.sessionId
      || props.session?.id
      || props.scope?.sessionId
      || props.owner?.sessionId
      || props.owner?.session?.sessionId
      || props.owner?.session?.id
      || '',
  );
}

export function createProjectRequest(projectId) {
  const value = String(projectId || '').trim();
  if (!value) throw new Error('project id is required');
  return { projectId: value };
}

export function mergeArtifactIntoDraft(draft, artifact, projectRevision) {
  if (!artifact) return draft;
  const incomingRevision = artifact.revision || 0;
  const incomingId = artifact.artifactId || '';
  const incomingReviewItems = documentReview({ body: artifact.body || '', confirmations: artifact.confirmations || [] }).items;
  if (
    draft?.dirty
    && draft.chapterId === artifact.chapterId
    && draft.artifactRevision === incomingRevision
    && draft.artifactId === incomingId
  ) {
    return {
      ...draft,
      reviewItems: mergeReviewItems(incomingReviewItems, draft.reviewItems || []),
      baseRevision: projectRevision ?? draft.baseRevision ?? 0,
      conflict: draft.conflict || null,
    };
  }
  if (
    draft?.dirty
    && draft.chapterId === artifact.chapterId
    && (draft.artifactRevision !== incomingRevision || draft.artifactId !== incomingId)
  ) {
    return {
      ...draft,
      conflict: {
        artifactId: incomingId,
        artifactRevision: incomingRevision,
        projectRevision: projectRevision || draft.baseRevision || 0,
        incomingBody: artifact.body || '',
        incomingReviewItems,
      },
    };
  }
  return {
    chapterId: artifact.chapterId,
    body: artifact.body || '',
    reviewItems: incomingReviewItems,
    dirty: false,
    artifactRevision: incomingRevision,
    artifactId: incomingId,
    baseRevision: projectRevision || draft.baseRevision || 0,
    conflict: null,
  };
}

export function draftStorageKey(sessionId, projectId, chapterId) {
  return ['ccpg-scheme-draft', sessionId, projectId, chapterId].map((value) => encodeURIComponent(String(value || ''))).join(':');
}

export function readPersistedDraft(storage, key) {
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writePersistedDraft(storage, key, draft) {
  if (!storage || !key || !draft?.dirty) return;
  storage.setItem(key, JSON.stringify({
    chapterId: draft.chapterId,
    body: draft.body || '',
    dirty: true,
    artifactRevision: draft.artifactRevision || 0,
    artifactId: draft.artifactId || '',
    baseRevision: draft.baseRevision || 0,
    conflict: draft.conflict || null,
    ...(draft.reviewItems ? { reviewItems: draft.reviewItems } : {}),
  }));
}

export function clearPersistedDraft(storage, key) {
  if (!storage || !key) return;
  storage.removeItem(key);
}

export function resolveDraftConflict(draft, mode) {
  if (!draft?.conflict) return draft;
  if (mode === 'incoming') {
    return {
      ...draft,
      body: draft.conflict.incomingBody,
      reviewItems: draft.conflict.incomingReviewItems || [],
      artifactRevision: draft.conflict.artifactRevision,
      artifactId: draft.conflict.artifactId,
      baseRevision: draft.conflict.projectRevision || draft.baseRevision || 0,
      dirty: false,
      conflict: null,
    };
  }
  if (mode === 'overwrite') {
    return {
      ...draft,
      reviewItems: mergeReviewItems(draft.conflict.incomingReviewItems || [], draft.reviewItems || []),
      artifactRevision: draft.conflict.artifactRevision,
      artifactId: draft.conflict.artifactId,
      baseRevision: draft.conflict.projectRevision || draft.baseRevision || 0,
      conflict: null,
      dirty: true,
    };
  }
  return draft;
}

export function saveEditRequest({ projectId, revision, chapterId, artifactRevision, body, reviewItems, conflict }) {
  if (!Number.isSafeInteger(Number(revision)) || Number(revision) < 1) {
    throw new Error('project revision is required');
  }
  if (!Number.isSafeInteger(Number(artifactRevision)) || Number(artifactRevision) < 0) {
    throw new Error('artifact revision is required');
  }
  if (conflict) throw new Error('resolve artifact conflict before saving');
  return { projectId, chapterId, revision, artifactRevision, body, ...(Array.isArray(reviewItems) ? { reviewItems } : {}) };
}

export function artifactReference({ projectId, chapterId, artifactId, artifactRevision }) {
  return `CCPG ${projectId} chapter=${chapterId} artifact=${artifactId} artifactRevision=${artifactRevision}`;
}

export async function executeUserAction(commands, sessionId, payload) {
  if (!sessionId) throw new Error('native session is required');
  if (!commands?.execute) throw new Error('native user command unavailable');
  const response = await commands.execute(sessionId, `/ccpg-scheme ${JSON.stringify(payload)}`, []);
  if (!response?.ok) throw new Error(response?.error?.message || 'native user command failed');
  const outcome = response.value?.result;
  if (!outcome) throw new Error('native user command unavailable');
  if (outcome.kind !== 'success') throw new Error(outcome.text || 'native user command failed');
  return JSON.parse(outcome.text || '{}');
}

