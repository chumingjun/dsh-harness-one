import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Expand, Eye, Minimize, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { documentPreviewKind, loadPreviewText, normalizePreviewDocument } from './index.js';
import './styles.css';

const PdfRenderer = lazy(() => import('./renderers/pdf.jsx'));
const DocxRenderer = lazy(() => import('./renderers/docx.jsx'));
const SheetRenderer = lazy(() => import('./renderers/sheet.jsx'));
const PptxRenderer = lazy(() => import('./renderers/pptx.jsx'));
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Loading() {
  return <div className="dsh-doc-preview-message">正在准备预览…</div>;
}

function TextRenderer({ document, kind, maxTextBytes }) {
  const [state, setState] = useState({ loading: true, error: '', text: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: '', text: '' });
    loadPreviewText(document.previewUrl, { signal: controller.signal, maxBytes: maxTextBytes })
      .then((text) => setState({ loading: false, error: '', text }))
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setState({ loading: false, error: reason?.message || String(reason), text: '' });
      });
    return () => controller.abort();
  }, [document.previewUrl, maxTextBytes]);

  const text = useMemo(() => {
    if (kind !== 'json' || !state.text) return state.text;
    try { return JSON.stringify(JSON.parse(state.text), null, 2); } catch { return state.text; }
  }, [kind, state.text]);

  if (state.loading) return <Loading />;
  if (state.error) return <div className="dsh-doc-preview-message is-error">{state.error}</div>;
  if (!text) return <div className="dsh-doc-preview-message">文件为空。</div>;
  if (kind === 'markdown') return <Markdown text={text} />;
  if (kind === 'csv') return <Csv text={text} />;
  return <div className="dsh-doc-preview-scroll"><pre className={`dsh-doc-preview-text is-${kind}`}>{text}</pre></div>;
}

// react-markdown + GFM：完整表格/任务列表/删除线/脚注等；此前手写解析器只会
// 标题/代码块/列表/段落，表格、粗体、行内代码、链接、引用全部原样漏出。
function Markdown({ text }) {
  return (
    <article className="dsh-doc-preview-scroll dsh-doc-preview-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          table: ({ node, ...props }) => <div className="md-table-wrap"><table {...props} /></div>,
        }}
      >{text}</ReactMarkdown>
    </article>
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function Csv({ text }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  return <div className="dsh-doc-preview-scroll dsh-doc-preview-table"><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
    const Tag = rowIndex === 0 ? 'th' : 'td';
    return <Tag key={cellIndex}>{cell}</Tag>;
  })}</tr>)}</tbody></table></div>;
}

function PreviewContent({ document, kind, maxTextBytes }) {
  if (!document.previewUrl) return <div className="dsh-doc-preview-message is-error">接口未提供安全预览地址。</div>;
  if (['text', 'markdown', 'json', 'csv'].includes(kind)) return <TextRenderer document={document} kind={kind} maxTextBytes={maxTextBytes} />;
  if (kind === 'image') return <div className="dsh-doc-preview-scroll dsh-doc-preview-image"><img src={document.previewUrl} alt={document.name} /></div>;
  if (kind === 'html') return <iframe className="dsh-doc-preview-frame" src={document.previewUrl} sandbox="" title={`预览 ${document.name}`} />;
  if (kind === 'pdf') return <PdfRenderer document={document} />;
  if (kind === 'docx') return <DocxRenderer document={document} />;
  if (kind === 'sheet') return <SheetRenderer document={document} />;
  if (kind === 'pptx') return <PptxRenderer document={document} />;
  return <div className="dsh-doc-preview-message">该文件类型暂不支持预览，旧 DOC 和 PPT 请下载后查看。</div>;
}

export function DocumentPreviewDialog({ document: input, open = true, onClose, maxTextBytes = 2 * 1024 * 1024, title = '文档预览' }) {
  const document = useMemo(() => normalizePreviewDocument(input), [input]);
  const kind = documentPreviewKind(document.name, document.mimeType);
  const dialogRef = useRef(null);
  const previousFocus = useRef(null);
  const titleId = useId();
  const [fullscreen, setFullscreen] = useState(false);

  const toggleFullscreen = useCallback(async () => {
    const dialog = dialogRef.current;
    if (!dialog || !window.document.fullscreenEnabled) return;
    try {
      if (window.document.fullscreenElement === dialog) await window.document.exitFullscreen();
      else await dialog.requestFullscreen();
    } catch {
      // The application-level dialog already occupies the viewport.
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    previousFocus.current = window.document.activeElement;
    const overflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => dialogRef.current?.focus());
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !window.document.fullscreenElement) {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])]
        .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFullscreenChange = () => setFullscreen(window.document.fullscreenElement === dialogRef.current);
    window.document.addEventListener('keydown', onKeyDown);
    window.document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.document.body.style.overflow = overflow;
      window.document.removeEventListener('keydown', onKeyDown);
      window.document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (window.document.fullscreenElement === dialogRef.current) window.document.exitFullscreen().catch(() => {});
      previousFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return <div className="dsh-doc-preview-backdrop" role="presentation">
    <section ref={dialogRef} className="dsh-doc-preview-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="dsh-doc-preview-header">
        <div className="dsh-doc-preview-heading">
          <span id={titleId}>{title}</span>
          <strong title={document.name}>{document.name}</strong>
        </div>
        <div className="dsh-doc-preview-actions">
          {typeof window !== 'undefined' && window.document.fullscreenEnabled && <button type="button" onClick={toggleFullscreen} title={fullscreen ? '退出浏览器全屏' : '浏览器全屏'} aria-label={fullscreen ? '退出浏览器全屏' : '浏览器全屏'}>{fullscreen ? <Minimize aria-hidden="true" /> : <Expand aria-hidden="true" />}</button>}
          {document.downloadUrl && <a href={document.downloadUrl} download title="下载原文件" aria-label="下载原文件"><Download aria-hidden="true" /></a>}
          <button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览"><X aria-hidden="true" /></button>
        </div>
      </header>
      <main className="dsh-doc-preview-content">
        <Suspense fallback={<Loading />}><PreviewContent document={document} kind={kind} maxTextBytes={maxTextBytes} /></Suspense>
      </main>
    </section>
  </div>;
}

export function DocumentPreviewButton({ document, className = '', children, disabled = false, portal = true, title }) {
  const [open, setOpen] = useState(false);
  const normalized = useMemo(() => normalizePreviewDocument(document), [document]);
  const supported = Boolean(documentPreviewKind(normalized.name, normalized.mimeType));
  const dialog = open ? <DocumentPreviewDialog document={normalized} onClose={() => setOpen(false)} /> : null;
  return <>
    <button type="button" className={`dsh-doc-preview-button ${className}`.trim()} disabled={disabled || !supported || !normalized.previewUrl}
      onClick={() => setOpen(true)} title={title || `预览 ${normalized.name}`} aria-label={title || `预览 ${normalized.name}`}>
      {children || <><Eye aria-hidden="true" /><span>预览</span></>}
    </button>
    {dialog && portal && typeof window !== 'undefined' ? createPortal(dialog, window.document.body) : dialog}
  </>;
}

export { documentMimeType, documentPreviewKind, canPreviewDocument, normalizePreviewDocument } from './index.js';
