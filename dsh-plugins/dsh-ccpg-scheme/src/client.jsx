import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { EditorContent, useEditor } from '@tiptap/react';
import JSZip from 'jszip';
import { mapDocumentImages } from '../lib/document-images.js';
import { BODY_EXTENSIONS } from './editor-extensions.mjs';
import { attachmentBytes, attachmentText, attachmentImage, resolveImageSource, safeDownloadName, safeImageSource, needsMarkdownFallback, PLACEHOLDER_SPLIT, PLACEHOLDER_TOKEN } from './content.mjs';
import { Check, CircleAlert, CloudUpload, Copy, Download, FileText, GitBranch, Loader2, MapPin, RefreshCw, Save } from 'lucide-react';
import {
  artifactReference,
  chapterDefinition,
  chapterRows,
  chapterReview,
  chapterPublicationState,
  publicationControls,
  deliveryViewState,
  documentOutline,
  clearPersistedDraft,
  draftStorageKey,
  executeUserAction,
  mergeArtifactIntoDraft,
  readPersistedDraft,
  referenceGroups,
  resolveDraftConflict,
  reviewItemAnchor,
  saveEditRequest,
  sessionIdFromProps,
  writePersistedDraft,
  itemStateLabel,
} from './client-state.mjs';
import './styles.css';

async function apiJson(path, sessionId, options = {}) {
  const action = { '': 'status', '/artifact': 'artifact', '/export': 'export' }[path];
  if (!action) throw new Error('unsupported results read action');
  if (!options.connection?.rpc?.call) throw new Error('DSH 原生连接尚未就绪。');
  const response = await options.connection.rpc.call('/api', 'ccpgSchemeResults/read', { args: { payload: { sessionId, action, ...options.params, ...options.body } } });
  if (!response.ok) {
    const error = new Error(response.error?.message || '无法读取方案成果。');
    error.code = error.message.startsWith('project-required:') ? 'project-required' : response.error?.code;
    throw error;
  }
  return response.value;
}

function draftStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function childText(children) {
  return React.Children.toArray(children).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return React.isValidElement(child) ? childText(child.props.children) : '';
  }).join('');
}

function highlightText(value) {
  return String(value).split(PLACEHOLDER_SPLIT).map((part, index) => PLACEHOLDER_TOKEN.test(part)
    ? <mark className="scheme-placeholder-highlight" key={`placeholder-${index}`}>{part}</mark>
    : part);
}

function highlightChildren(children) {
  return React.Children.toArray(children).flatMap((child, index) => {
    if (typeof child === 'string' || typeof child === 'number') return highlightText(child);
    if (!React.isValidElement(child) || child.props.children == null) return child;
    return React.cloneElement(child, { key: child.key || `highlight-${index}` }, highlightChildren(child.props.children));
  });
}

function MarkdownBody({ body, reviewItems = [], images = {} }) {
  let headingIndex = 0;
  const headings = Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [`h${level}`, ({ children }) => {
    const anchor = `scheme-heading-${headingIndex++}`;
    const title = childText(children).replace(/[*`]/g, '').trim();
    const code = title.match(/^(\d+(?:\.\d+)+)(?:[.、]?\s|$)/)?.[1] || '';
    const marked = reviewItems.some((item) => (
      (item.sectionCode && item.sectionCode === code)
      || (item.sectionLabel && item.sectionLabel.trim() === title)
      || item.headingAnchor === anchor
    ));
    return React.createElement(`h${level}`, { id: anchor, className: marked ? 'scheme-review-heading' : undefined }, highlightChildren(children));
  }]));
  const textComponents = Object.fromEntries(['p', 'li', 'td', 'th', 'blockquote', 'dt', 'dd'].map((tag) => [tag, ({ children, node, ...props }) => React.createElement(tag, props, highlightChildren(children))]));
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, { ...defaultSchema, protocols: { ...defaultSchema.protocols, src: ['data'] } }]]} urlTransform={(url, key) => key === 'src' ? resolveImageSource(url, images) : defaultUrlTransform(url)} components={{ ...headings, ...textComponents, img: ({ src, alt }) => safeImageSource(src) ? <img src={src} alt={alt || ''} /> : <span role="status">[{alt || '图片'}：原图未保存]</span> }}>
      {body || ''}
    </ReactMarkdown>
  );
}

function RichBodyEditor({ value, onChange, reviewItems, images }) {
  const editor = useEditor({
    extensions: BODY_EXTENSIONS.map((extension) => extension.name === 'image' ? extension.configure({ images }) : extension),
    content: value || '',
    editorProps: { attributes: { class: 'scheme-editor-prose', spellCheck: 'false' } },
    onUpdate: ({ editor: instance }) => onChange(instance.storage.markdown.getMarkdown()),
  });

  useEffect(() => {
    if (!editor || editor.storage.markdown.getMarkdown() === value) return;
    editor.commands.setContent(value || '', false);
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    editor.storage.schemePlaceholderHighlight.reviewItems = reviewItems;
    editor.view.dispatch(editor.state.tr.setMeta('schemeReviewRefresh', true));
  }, [editor, reviewItems]);

  if (!editor) return <div className="scheme-muted">编辑器加载中...</div>;
  return <EditorContent editor={editor} className="scheme-editor" />;
}

function BodyEditor({ value, onChange, reviewItems, images }) {
  const [raw, setRaw] = useState(needsMarkdownFallback(value, images));
  const fallback = needsMarkdownFallback(value, images);
  return <>
    <div className="scheme-editor-mode">
      <button type="button" aria-pressed={!raw} disabled={fallback} onClick={() => setRaw(false)}>排版</button>
      <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>Markdown</button>
      {fallback && <span>包含 HTML 或未解析图片，保留原文编辑</span>}
    </div>
    {raw || fallback ? <textarea className="scheme-markdown-editor" aria-label="Markdown 正文" value={value || ''} onChange={(event) => onChange(event.target.value)} /> : <RichBodyEditor value={value} onChange={onChange} reviewItems={reviewItems} images={images} />}
  </>;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StatusBadge({ row }) {
  const labels = { pending: '未生成', prepared: '已准备', submitted: '已生成', confirmed: '已确认', cancelled: '已取消', skipped: '已跳过', stale: '需更新' };
  const label = row.stale ? '需更新' : row.pendingConfirmations ? '待确认' : labels[row.status] || row.status;
  return <span className="scheme-badge" data-status={row.stale ? 'stale' : row.status}>{label}</span>;
}

function EmptyProject() {
  return (
    <div className="scheme-empty">
      <FileText size={28} />
      <h2>方案成果</h2>
      <p>方案尚未开始。生成后的章节、材料和附件会在这里汇总。</p>
    </div>
  );
}

function ItemState({ value }) {
  return <span className="scheme-item-state" data-status={value}>{itemStateLabel(value)}</span>;
}

function ListsPanel({ artifact, snapshot, selectedId }) {
  const definition = chapterDefinition(snapshot, selectedId, artifact);
  const groups = referenceGroups(definition.references);
  return (
    <aside className="scheme-detail">
      <section>
        <h3>本章输入</h3>
        {definition.inputs.length ? definition.inputs.map((item) => (
          <div className="scheme-detail-item" key={item.id}>
            <strong>{item.name || item.id}</strong>
            <span>{item.required === 'unknown' ? '是否必填待确认' : item.required ? '必填' : '可选'}{item.material ? ` · ${item.material.name}` : ''}</span>
            <ItemState value={item.status} />
          </div>
        )) : <p className="scheme-muted">本章未定义项目输入</p>}
      </section>
      <section>
        <h3>前置章节</h3>
        {definition.dependencies.length ? definition.dependencies.map((item) => (
          <div className="scheme-detail-item" key={item.id}>
            <strong><GitBranch size={13} />{item.code} {item.title}</strong>
            <ItemState value={item.status} />
          </div>
        )) : <p className="scheme-muted">无前置章节</p>}
      </section>
      <section>
        <h3>输出项</h3>
        {definition.outputs.length ? definition.outputs.map((item) => (
          <div className="scheme-detail-item" key={item.id}>
            <strong>{item.label}</strong>
            <span>{item.kind === 'attachment' ? '附件' : '正文'}{item.dependencies?.length ? ` · 依赖 ${item.dependencies.join('、')}` : ''}</span>
            <ItemState value={item.status} />
          </div>
        )) : <p className="scheme-muted">未定义输出项</p>}
      </section>
      {groups.map((group) => (
        <section key={group.label}>
          <h3>{group.label}</h3>
          {group.items.map((item, index) => (
            <div className="scheme-detail-item" key={`${item.title}-${index}`}>
              <strong>{item.title}</strong>
              <span>{item.inputIds?.length ? `关联 ${item.inputIds.join('、')}` : '本章资源'}</span>
              {(item.source || item.original || item.content) && <small className="scheme-detail-resource">
                {item.source ? '来源已登记' : '插件内置'}
                {item.original ? ' · 原件' : ''}
                {item.content ? ' · Markdown 内容' : ''}
              </small>}
              <ItemState value={item.displayStatus} />
            </div>
          ))}
        </section>
      ))}
      <section>
        <h3>证据</h3>
        {(artifact?.evidence || []).length ? artifact.evidence.map((item, index) => (
          <p key={index}>{snapshot.state?.materials?.[item.source]?.name || snapshot.manifest?.chapters?.find((chapter) => snapshot.state?.artifacts?.[item.source]?.chapterId === chapter.id)?.title || item.name || '成果来源'}{item.source && !snapshot.state?.materials?.[item.source] && !snapshot.state?.artifacts?.[item.source] ? ` · ${item.source}` : ''}</p>
        )) : <p className="scheme-muted">暂无证据</p>}
      </section>
    </aside>
  );
}

function PublicationLinks({ publication }) {
  if (!publication) return null;
  return <div className="scheme-publication">
    {publication.verified ? '已保存到飞书' : '飞书发布尚未完成'}
    {/^https:\/\//i.test((publication.schemeFolder || publication.folder)?.url || '') && <a href={(publication.schemeFolder || publication.folder).url} target="_blank" rel="noreferrer">打开方案文件夹</a>}
    {publication.schemeFolder && publication.schemeFolder.token !== publication.folder?.token && /^https:\/\//i.test(publication.folder?.url || '') && <a href={publication.folder.url} target="_blank" rel="noreferrer">打开本章文件夹</a>}
    {/^https:\/\//i.test(publication.body?.url || '') && <a href={publication.body.url} target="_blank" rel="noreferrer">打开正文</a>}
    {publication.blocked && <span role="status">之前的发布结果待核对，已保留原文档</span>}
    {publication.history?.length > 1 && <details><summary>发布历史 · {publication.history.length} 次</summary>
      <ol>{[...publication.history].reverse().map((item, index) => <li key={`${item.at}-${index}`}>
        <time dateTime={item.at}>{item.at && new Date(item.at).toLocaleString()}</time>
        {/^https:\/\//i.test(item.body?.url || '') && <a href={item.body.url} target="_blank" rel="noreferrer">正文</a>}
        {/^https:\/\//i.test(item.folder?.url || '') && <a href={item.folder.url} target="_blank" rel="noreferrer">文件夹</a>}
      </li>)}</ol>
    </details>}
  </div>;
}

function DeliveryView({ delivery, deliveryState, busy, publication, cloudState, status, error, onReload, onDownload, onWord, onSave, onPublish, readOnly }) {
  const images = Object.fromEntries((delivery?.assets || []).map((item) => [item.path, `data:${item.mime};base64,${item.base64}`]));
  return <>
    <header className="scheme-header">
      <div>
        <h2>完整方案</h2>
        <p>正文与附件 · 版本 {delivery?.revision} · 附件 {delivery?.attachments?.length || 0} 份</p>
      </div>
      <div className="scheme-actions">
        {deliveryState.stale && <button type="button" onClick={onReload} disabled={busy || deliveryState.dirty}><RefreshCw size={15} />更新交付</button>}
        <button type="button" onClick={onDownload} disabled={busy || !deliveryState.ready}><Download size={15} />下载 ZIP</button>
        {!readOnly && <button type="button" onClick={onWord} disabled={busy || !deliveryState.ready}><Download size={15} />下载 Word</button>}
        {!readOnly && <button type="button" onClick={onSave} disabled={busy || !deliveryState.ready}><Save size={15} />保存到方案目录</button>}
        {!readOnly && <button type="button" onClick={onPublish} disabled={busy || !deliveryState.canPublish || cloudState.disabled} title={!delivery?.complete ? '完成并确认全部章节后可发布' : undefined}><CloudUpload size={15} />{cloudState.label}</button>}
      </div>
    </header>
    {error && <p className="scheme-error" role="alert">{error}</p>}
    {status && <p className="scheme-status" role="status">{status}</p>}
    {deliveryState.stale && <p className="scheme-warning">方案已有更新，请更新交付后再下载、保存或发布。</p>}
    {deliveryState.dirty && <p className="scheme-warning">章节仍有未保存的修改，请先保存后再交付。</p>}
    {delivery?.incomplete?.length > 0 && <p className="scheme-warning">交付前请处理：{delivery.incomplete.map((item) => `${item.code} ${item.title}（${item.status === 'pending-confirmation' ? '待核对' : item.status === 'stale' ? '需更新' : '未生成'}）`).join('、')}</p>}
    <PublicationLinks publication={publication} />
    <section className="scheme-document scheme-delivery-document">
      <MarkdownBody body={delivery?.markdown} images={images} />
      {delivery?.attachments?.length > 0 && <section className="scheme-delivery-attachments" aria-label="交付附件">
        <h3>附件</h3>
        {delivery.attachments.map((item) => <div key={`${item.chapterId}-${item.path}`}>
          <strong>{item.name}</strong>
          {attachmentImage(item) && <img src={attachmentImage(item)} alt={item.name} />}
        </div>)}
      </section>}
    </section>
  </>;
}

export function SchemeResultsTab(props) {
  const sessionId = sessionIdFromProps(props);
  const [projectId, setProjectId] = useState(props.projectId || '');
  const [snapshot, setSnapshot] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [artifact, setArtifact] = useState(null);
  const [attachmentId, setAttachmentId] = useState('');
  const [drafts, setDrafts] = useState({});
  const [mode, setMode] = useState('preview');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [projectRequired, setProjectRequired] = useState(false);
  const [delivery, setDelivery] = useState(null);
  const [showDelivery, setShowDelivery] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [publication, setPublication] = useState(null);
  const [chapterPublications, setChapterPublications] = useState({});
  const [showReview, setShowReview] = useState(false);

  const rows = useMemo(() => chapterRows(snapshot), [snapshot]);
  const deliveryState = deliveryViewState(snapshot, delivery, drafts);
  useEffect(() => {
    if (!deliveryState.available) setShowDelivery(false);
  }, [deliveryState.available]);
  const selected = rows.find((row) => row.id === selectedId) || rows[0];
  const currentArtifact = artifact?.chapterId === selected?.id ? artifact : null;
  const chapterPublication = chapterPublicationState(snapshot, selected?.id, currentArtifact, drafts);
  const publishedChapter = chapterPublications[selected?.id] || snapshot?.publications?.[selected?.id];
  const publishedDelivery = publication || snapshot?.publications?.full;
  const chapterCloudState = publicationControls(snapshot, publishedChapter);
  const deliveryCloudState = publicationControls(snapshot, publishedDelivery);
  const selectedAttachment = currentArtifact?.attachments?.find((item) => item.outputId === attachmentId);
  const documentKey = selectedAttachment ? `${selected?.id}@${attachmentId}` : selected?.id;
  const documentBody = selectedAttachment ? attachmentText(selectedAttachment) : currentArtifact?.body || '';
  const draft = drafts[documentKey] || { chapterId: documentKey, dirty: false, body: documentBody || '', artifactId: currentArtifact?.artifactId || '', artifactRevision: currentArtifact?.revision || 0, baseRevision: snapshot?.state?.revision || 0 };
  const editable = !selectedAttachment || typeof selectedAttachment.content === 'string';
  const chapterDraft = drafts[selected?.id];
  const review = chapterReview(currentArtifact, chapterDraft);
  const pendingReview = selected?.status === 'confirmed' ? [] : review.items.filter((item) => !['confirmed', 'not_required'].includes(item.status));
  const outline = documentOutline(review.body, selected?.outputs || []);
  const chapterLabel = selected ? `${selected.code || selected.order}. ${selected.title}` : '本章';

  const loadSnapshot = useCallback(async (knownProjectId = projectId) => {
    if (!sessionId) return;
    try {
      const result = await apiJson('', sessionId, { connection: props.connection, params: knownProjectId ? { projectId: knownProjectId } : {} });
      setSnapshot(result);
      setPublication(null);
      setChapterPublications({});
      setProjectId(result.state.projectId);
      setProjectRequired(false);
      setError('');
      if (!selectedId) setSelectedId(chapterRows(result)[0]?.id || '');
      return result;
    } catch (reason) {
      if (reason.code === 'project-required') setProjectRequired(true);
      else setError(reason.message || String(reason));
    }
  }, [projectId, selectedId, sessionId, props.connection]);

  const loadArtifact = useCallback(async (chapterId = selected?.id, currentSnapshot = snapshot) => {
    if (!sessionId || !chapterId || !projectId) return;
    try {
      const next = currentSnapshot?.state?.chapters?.[chapterId]?.artifactId
        ? await apiJson('/artifact', sessionId, { connection: props.connection, params: { projectId, chapterId } })
        : null;
      setArtifact(next);
      setDrafts((current) => ({
        ...current,
        [chapterId]: mergeArtifactIntoDraft(
          current[chapterId] || (!props.readOnly && readPersistedDraft(draftStorage(), draftStorageKey(sessionId, projectId, chapterId))) || { chapterId, dirty: false },
          next,
          currentSnapshot?.state?.revision,
        ),
        ...Object.fromEntries((next?.attachments || []).filter((item) => typeof item.content === 'string').map((item) => {
          const key = `${chapterId}@${item.outputId}`;
          return [key, mergeArtifactIntoDraft(current[key] || (!props.readOnly && readPersistedDraft(draftStorage(), draftStorageKey(sessionId, projectId, key))), { ...next, chapterId: key, body: item.content, confirmations: [] }, currentSnapshot?.state?.revision)];
        })),
      }));
    } catch (reason) {
      setArtifact(null);
      setDrafts((current) => ({
        ...current,
        [chapterId]: current[chapterId] || (!props.readOnly && readPersistedDraft(draftStorage(), draftStorageKey(sessionId, projectId, chapterId))) || { chapterId, body: '', dirty: false, conflict: null },
      }));
      if (reason.status !== 400) setError(reason.message || String(reason));
    }
  }, [projectId, selected?.id, sessionId, snapshot, props.connection, props.readOnly]);

  useEffect(() => {
    void loadSnapshot();
    return props.connection?.generation?.subscribe(() => { void loadSnapshot(); });
  }, [loadSnapshot, props.connection]);
  useEffect(() => { if (selected?.id) loadArtifact(selected.id); }, [selected?.id, loadArtifact]);
  useEffect(() => { setShowReview(false); setStatus(''); setError(''); }, [selected?.id]);
  useEffect(() => {
    if (!sessionId || !projectId) return undefined;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void loadSnapshot(projectId).then((next) => {
        if (next) return loadArtifact(selected?.id, next);
        return undefined;
      });
    };
    const timer = window.setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [loadArtifact, loadSnapshot, projectId, selected?.id, sessionId, snapshot?.state?.revision]);
  useEffect(() => {
    if (props.readOnly) return;
    const storage = draftStorage();
    if (!sessionId || !projectId || !storage) return;
    for (const [chapterId, value] of Object.entries(drafts)) {
      const key = draftStorageKey(sessionId, projectId, chapterId);
      if (value?.dirty) writePersistedDraft(storage, key, value);
      else clearPersistedDraft(storage, key);
    }
  }, [drafts, projectId, sessionId, props.readOnly]);

  const save = async () => {
    if (!snapshot || !selected || !currentArtifact) return;
    setStatus('保存中...'); setError('');
    try {
      await executeUserAction(props.commands, sessionId, {
        action: 'edit',
        ...(selectedAttachment ? { attachmentOutputId: selectedAttachment.outputId } : {}),
        ...saveEditRequest({
          projectId,
          revision: draft.baseRevision,
          chapterId: selected.id,
          artifactRevision: draft.artifactRevision,
          body: draft.body,
          ...(!selectedAttachment ? { reviewItems: review.items } : {}),
          conflict: draft.conflict,
        }),
      });
      setDrafts((current) => ({ ...current, [documentKey]: { ...current[documentKey], dirty: false, conflict: null } }));
      clearPersistedDraft(draftStorage(), draftStorageKey(sessionId, projectId, documentKey));
      const next = await loadSnapshot(projectId);
      if (next) await loadArtifact(selected.id, next);
      setStatus('已保存');
    } catch (reason) {
      setError(reason.status === 409 ? '保存冲突：已保留当前草稿，请刷新对比后再保存。' : (reason.message || String(reason)));
    }
  };

  const confirm = async () => {
    if (!snapshot || !selected || !currentArtifact || selectedAttachment || Object.entries(drafts).some(([key, value]) => key.split('@')[0] === selected.id && value.dirty)) return;
    if (pendingReview.length && !showReview) { setShowReview(true); return; }
    setStatus('确认中...'); setError('');
    try {
      await executeUserAction(props.commands, sessionId, { action: 'confirm', projectId, chapterId: selected.id, revision: snapshot.state.revision, artifactRevision: currentArtifact.revision });
      await loadSnapshot(projectId);
      setStatus('已确认');
    } catch (reason) {
      setError(reason.message || String(reason));
    }
  };

  const locateReviewItem = (item) => {
    const anchor = reviewItemAnchor(item, outline);
    setAttachmentId(''); setMode('preview');
    window.requestAnimationFrame(() => {
      const documentElement = document.querySelector('.scheme-document');
      ((anchor ? documentElement?.querySelector(`#${anchor}`) : null) || documentElement)?.scrollIntoView({ block: 'start' });
    });
  };

  const exportAll = async () => {
    if (!deliveryState.available || deliveryBusy || deliveryState.dirty) return;
    setDeliveryBusy(true);
    setStatus('汇总中...'); setError('');
    try {
      const result = await apiJson('/export', sessionId, { connection: props.connection, body: { projectId } });
      setDelivery(result);
      setShowDelivery(true);
      setStatus(result.complete ? '完整方案已汇总，附件单独交付' : '已汇总现有成果，请核对下方交付事项');
    } catch (reason) {
      setError(reason.message || String(reason));
    } finally { setDeliveryBusy(false); }
  };

  const downloadArchive = async () => {
    if (!deliveryState.ready || deliveryBusy) return;
    setDeliveryBusy(true);
    setError(''); setStatus('打包中...');
    try {
      const zip = new JSZip();
      zip.file('完整方案.md', delivery.markdown);
      for (const item of delivery.attachments) zip.file(item.path, attachmentBytes(item));
      for (const item of delivery.assets || []) zip.file(item.path, attachmentBytes(item));
      zip.file('交付清单.json', JSON.stringify({ ...delivery, markdown: undefined, assets: (delivery.assets || []).map(({ base64, ...item }) => item), attachments: delivery.attachments.map(({ content, base64, ...item }) => item) }, null, 2));
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${projectId || 'ccpg-scheme'}.zip`);
      setStatus('正文与附件已打包');
    } catch (reason) { setError(reason.message || String(reason)); setStatus(''); }
    finally { setDeliveryBusy(false); }
  };

  const downloadWord = async () => {
    if (!deliveryState.ready || deliveryBusy) return;
    setDeliveryBusy(true); setError(''); setStatus('正在生成 Word...');
    try {
      const response = await executeUserAction(props.commands, sessionId, { action: 'export', format: 'docx', projectId, revision: delivery.revision });
      const result = response.result;
      if (!result?.base64 || !result.wordPath) throw new Error('Word 导出未完成，请重试');
      downloadBlob(new Blob([attachmentBytes(result)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), `${projectId || 'ccpg-scheme'}.docx`);
      setStatus('正文已导出为 Word，附件可通过 ZIP 一并下载');
    } catch (reason) { setError(reason.message || String(reason)); setStatus(''); }
    finally { setDeliveryBusy(false); }
  };

  const saveDelivery = async () => {
    if (!deliveryState.ready || deliveryBusy) return;
    setDeliveryBusy(true); setError(''); setStatus('保存中...');
    try {
      const result = await executeUserAction(props.commands, sessionId, { action: 'export', projectId, revision: delivery.revision });
      setStatus(`已保存到方案目录：${result.result.directory}`);
    } catch (reason) { setError(reason.message || String(reason)); setStatus(''); }
    finally { setDeliveryBusy(false); }
  };

  const publishDelivery = async () => {
    if (!deliveryState.canPublish || deliveryBusy) return;
    setDeliveryBusy(true); setError(''); setStatus('正在保存到飞书...');
    try {
      const response = await executeUserAction(props.commands, sessionId, { action: 'publish', projectId, title: snapshot.manifest?.title || projectId, revision: delivery.revision });
      const result = response.result;
      if (!result?.ok || !result.verified) throw new Error(`${result?.code || 'unverified'}: ${result?.error || '飞书发布尚未核验，请在会话中核对结果后继续'}`);
      setPublication(result);
      setStatus(result.reused ? '已同步，继续使用原飞书文档' : result.updated ? '原飞书文档已更新，地址保持不变' : '正文与附件已保存到飞书并核验');
    } catch (reason) { setError(reason.message || String(reason)); setStatus(''); }
    finally { setDeliveryBusy(false); }
  };

  const publishChapter = async () => {
    if (!chapterPublication.canPublish || deliveryBusy) return;
    setDeliveryBusy(true); setError(''); setStatus('正在将本章保存到飞书...');
    try {
      const response = await executeUserAction(props.commands, sessionId, { action: 'publish', projectId, chapterId: selected.id, title: chapterLabel, revision: snapshot.state.revision, artifactRevision: currentArtifact.revision });
      const result = response.result;
      if (!result?.ok || !result.verified) throw new Error(`${result?.code || 'unverified'}: ${result?.error || '飞书发布尚未核验，请在会话中核对结果后继续'}`);
      setChapterPublications((current) => ({ ...current, [selected.id]: result }));
      setStatus(result.reused ? '本章已同步，继续使用原飞书文档' : result.updated ? '本章原飞书文档已更新，地址保持不变' : '本章正文与附件已保存到飞书并核验');
    } catch (reason) { setError(reason.message || String(reason)); setStatus(''); }
    finally { setDeliveryBusy(false); }
  };

  const downloadCurrent = async () => {
    if (!currentArtifact) return;
    try {
      const name = safeDownloadName(selectedAttachment?.name || `${selected.code || selected.order} ${selected.title}.md`);
      if (!selectedAttachment || /\.(md|markdown)$/i.test(name)) {
        const zip = new JSZip(); const paths = new Map();
        const markdown = mapDocumentImages(draft.body, (source, alt) => {
          const image = resolveImageSource(source, currentArtifact.images);
          if (!image) throw new Error('原图未保存，请在会话中补充原图后再下载');
          if (!paths.has(source)) {
            const mime = image.slice(5, image.indexOf(';'));
            const path = `图片/${paths.size + 1}-${safeDownloadName(alt || '插图')}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
            paths.set(source, path);
            zip.file(path, attachmentBytes({ base64: image.slice(image.indexOf(',') + 1) }));
          }
          return paths.get(source);
        });
        if (paths.size) {
          zip.file(name, markdown);
          downloadBlob(await zip.generateAsync({ type: 'blob' }), name.replace(/\.(md|markdown)$/i, '') + '.zip');
          return;
        }
      }
      downloadBlob(new Blob([selectedAttachment ? attachmentBytes(selectedAttachment) : draft.body], { type: selectedAttachment ? 'application/octet-stream' : 'text/markdown;charset=utf-8' }), name);
    } catch (reason) { setError(reason.message || String(reason)); }
  };

  const resolveConflict = (modeToUse) => {
    if (!selected?.id) return;
    setDrafts((current) => ({
      ...current,
      [documentKey]: resolveDraftConflict(current[documentKey], modeToUse),
    }));
  };

  const copyRef = async () => {
    if (!currentArtifact || draft.dirty) return;
    try {
    if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
    await navigator.clipboard.writeText(artifactReference({
      projectId,
      chapterId: currentArtifact.chapterId,
      artifactId: currentArtifact.artifactId,
      artifactRevision: currentArtifact.revision,
    }));
    setStatus('引用已复制');
    } catch (reason) { setError(reason.message || String(reason)); }
  };

  if (!sessionId) return <div className="scheme-empty"><p className="scheme-error">当前宿主未提供 sessionId。</p></div>;
  if (projectRequired) return props.readOnly ? <div className="scheme-empty">未找到方案成果</div> : <EmptyProject sessionId={sessionId} onReady={(id) => loadSnapshot(id)} />;
  if (!snapshot) return <div className="scheme-empty">{error ? <p className="scheme-error" role="alert">无法读取方案成果：{error}</p> : <><Loader2 className="scheme-spin" />读取方案成果...</>}</div>;

  return (
    <div className="scheme-shell">
    <header className="scheme-workspace-header">
      <strong>方案成果{props.readOnly ? ' · 只读' : ''}</strong>
      {deliveryState.available && <div className="scheme-actions">
        <button type="button" aria-pressed={showDelivery} disabled={deliveryBusy || deliveryState.dirty} title={deliveryState.dirty ? '先保存章节修改' : '查看合并正文与附件，选择下载或飞书转换'} onClick={exportAll}><FileText size={15} />查看全文与导出</button>
      </div>}
    </header>
    <div className="scheme-root" data-delivery={showDelivery || undefined}>
      <aside className="scheme-nav">
        <div className="scheme-title">
          <strong>{snapshot.manifest?.id || projectId}</strong>
          <span>{snapshot.projectCwd}</span>
        </div>
        <nav>
          {rows.map((row) => (
            <React.Fragment key={row.id}>
            <button type="button" title={`${row.code || row.order}. ${row.title}`} data-active={!showDelivery && row.id === selected?.id || undefined} onClick={() => { setShowDelivery(false); if (row.id !== selectedId) { setArtifact(null); setShowReview(false); } setSelectedId(row.id); setAttachmentId(''); setMode('preview'); }}>
              <span>{row.code || row.order}. {row.title}</span>
              <StatusBadge row={row} />
            </button>
            {!showDelivery && row.id === selected?.id && <div className="scheme-outline">
              {outline.map((item, index) => {
                const attachment = item.kind === 'attachment'
                  ? (currentArtifact?.attachments || []).find((candidate) => candidate.outputId === item.outputId)
                  : null;
                const available = item.kind === 'attachment' ? Boolean(attachment) : Boolean(item.anchor);
                return <button
                  type="button"
                  key={item.outputId || item.anchor || index}
                  disabled={!available}
                  data-active={item.kind === 'attachment' && attachmentId === item.outputId || undefined}
                  style={{ paddingLeft: `${10 + item.depth * 12}px` }}
                  title={available ? item.title : `${item.title} · 尚未生成`}
                  onClick={() => {
                    if (!available) return;
                    setMode('preview');
                    if (item.kind === 'attachment') setAttachmentId(item.outputId);
                    else {
                      setAttachmentId('');
                      window.requestAnimationFrame(() => document.querySelector(`.scheme-document #${item.anchor}`)?.scrollIntoView({ block: 'start' }));
                    }
                  }}
                >
                  {item.title}
                  {item.kind === 'attachment' && <span className="scheme-outline-kind">附件</span>}
                  {!available && <span className="scheme-outline-missing"> · 待生成</span>}
                </button>;
              })}
            </div>}
            </React.Fragment>
          ))}
        </nav>
      </aside>
      <main className="scheme-main">
        {showDelivery ? <DeliveryView delivery={delivery} deliveryState={deliveryState} busy={deliveryBusy} publication={publishedDelivery} cloudState={deliveryCloudState} status={status} error={error} onReload={exportAll} onDownload={downloadArchive} onWord={downloadWord} onSave={saveDelivery} onPublish={publishDelivery} readOnly={props.readOnly} /> : <>
        <header className="scheme-header">
          <div>
            <h2>{selectedAttachment ? selectedAttachment.name : selected ? `${selected.code || selected.order}. ${selected.title}` : '方案成果'}</h2>
            {currentArtifact && <p>{selectedAttachment ? '附件' : '章节正文'} · 版本 {currentArtifact.revision}</p>}
          </div>
          <div className="scheme-actions">
            {!props.readOnly && <button type="button" disabled={!currentArtifact || !editable} onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}>{mode === 'edit' ? '预览' : '编辑'}</button>}
            {!props.readOnly && <button type="button" onClick={save} disabled={!draft.dirty || !currentArtifact}><Save size={15} />保存</button>}
            {!props.readOnly && <button type="button" onClick={confirm} title={selectedAttachment ? '返回章节正文后确认本章' : undefined} disabled={!currentArtifact || Boolean(selectedAttachment) || Object.entries(drafts).some(([key, value]) => key.split('@')[0] === selected?.id && value.dirty)}><Check size={15} />确认本章</button>}
            <button type="button" onClick={copyRef} disabled={!currentArtifact || draft.dirty} title={draft.dirty ? '先保存草稿再复制成果引用' : '复制已保存成果引用'}><Copy size={15} />引用</button>
            <button type="button" onClick={downloadCurrent} disabled={!currentArtifact} title="下载当前正文或附件"><Download size={15} />下载</button>
            {!props.readOnly && !selectedAttachment && <button type="button" onClick={publishChapter} disabled={deliveryBusy || !chapterPublication.canPublish || chapterCloudState.disabled} title={chapterPublication.reason || '以当前用户身份将本章正文与附件保存到飞书'}><CloudUpload size={15} />{chapterCloudState.label}</button>}
            {!selectedAttachment && review.items.length > 0 && <button type="button" className="scheme-review-toggle" aria-expanded={showReview} aria-controls="scheme-review-items" onClick={() => setShowReview(!showReview)}><CircleAlert size={15} />{pendingReview.length ? `本章待确认 · ${pendingReview.length} 项` : '本章核对事项'}</button>}
          </div>
        </header>
        {error && <p className="scheme-error">{error}</p>}
        {status && <p className="scheme-status">{status}</p>}
        {!selectedAttachment && <PublicationLinks publication={publishedChapter} />}
        {!selectedAttachment && showReview && review.items.length > 0 && <section id="scheme-review-items" className="scheme-review-panel" aria-label={`${chapterLabel}待确认事项`}>
          <h3>{chapterLabel} · {pendingReview.length ? '待确认事项' : '核对事项'}</h3>
          <ol>{review.items.map((item, index) => <li key={`${item.id || 'review'}-${index}`}>
            <div className="scheme-review-location"><span>{item.sectionLabel || item.sectionCode || chapterLabel}</span><button type="button" onClick={() => locateReviewItem(item)} title={reviewItemAnchor(item, outline) ? '定位到对应正文' : '定位到本章正文'}><MapPin size={13} />定位</button></div>
            <p>{item.message || item.id}</p>
            {!props.readOnly && !/^inline-review-/.test(item.id || '') && <button type="button" disabled={selected?.status === 'confirmed'} onClick={() => setDrafts(current => ({
              ...current,
              [selected.id]: { ...draft, dirty: true, reviewItems: review.items.map((candidate, position) => position === index ? { ...candidate, status: candidate.status === 'confirmed' ? 'pending' : 'confirmed' } : candidate) },
            }))}><Check size={13} />{item.status === 'confirmed' || selected?.status === 'confirmed' ? '已核对' : '标记已核对'}</button>}
          </li>)}</ol>
        </section>}
        {draft.conflict && (
          <div className="scheme-warning">
            <span>后台已有新版本，当前草稿未被覆盖。</span>
            <button type="button" onClick={() => resolveConflict('incoming')}>使用后台版本</button>
            <button type="button" onClick={() => resolveConflict('overwrite')}>覆盖为我的草稿</button>
          </div>
        )}
        <section className="scheme-document">
          {!currentArtifact && !draft.dirty ? <p className="scheme-muted">本章尚未生成成果</p> : mode === 'edit'
            ? <BodyEditor
              key={`${documentKey}:${currentArtifact?.artifactId || ''}`}
              value={selectedAttachment ? draft.body : review.body}
              images={currentArtifact?.images}
              reviewItems={selectedAttachment ? [] : pendingReview}
              onChange={(body) => setDrafts((current) => ({
                ...current,
                [documentKey]: {
                  ...(current[documentKey] || {
                    chapterId: documentKey,
                    artifactRevision: currentArtifact?.revision || 0,
                    artifactId: currentArtifact?.artifactId || '',
                    baseRevision: snapshot.state.revision,
                  }),
                  body,
                  ...(review.items.length && !selectedAttachment ? { reviewItems: review.items } : {}),
                  dirty: true,
                },
              }))}
            />
            : selectedAttachment && attachmentImage(selectedAttachment) ? <figure><img src={attachmentImage(selectedAttachment)} alt={selectedAttachment.name} /><figcaption>{selectedAttachment.name}</figcaption></figure>
              : selectedAttachment && documentBody == null ? <p className="scheme-muted">{selectedAttachment.name}</p>
                : selectedAttachment && !/\.(md|markdown)$/i.test(selectedAttachment.name) ? <pre>{draft.body}</pre> : <MarkdownBody body={selectedAttachment ? draft.body : review.body} images={currentArtifact?.images} reviewItems={selectedAttachment ? [] : pendingReview} />}
        </section>
        </>}
      </main>
      {!showDelivery && <ListsPanel artifact={currentArtifact} snapshot={snapshot} selectedId={selected?.id} />}
    </div>
    </div>
  );
}

function SchemeIcon({ size = 14 }) {
  return <FileText size={size} />;
}

export function apply(ctx) {
  try {
    ctx.inject(['betterSidebar', 'remote', 'remote.commands', 'connection'], (scope) => {
      const commands = scope.remote.commands;
      const connection = scope.connection;
      scope.effect(() => scope.betterSidebar.registerTab({
        id: 'ccpg:scheme-results',
        title: () => '方案成果',
        icon: SchemeIcon,
        order: 6,
        single: true,
        component: (props) => <SchemeResultsTab {...props} commands={commands} connection={connection} />,
      }), 'ccpg-scheme: results tab');
    });
  } catch (error) {
    console.warn('[dsh-ccpg-scheme] native results tab unavailable', error);
  }
}

export const name = 'dsh-ccpg-scheme/client';
export const inject = ['slots'];
