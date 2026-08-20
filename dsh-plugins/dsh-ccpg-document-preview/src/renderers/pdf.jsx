import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import { loadPreviewArrayBuffer } from '../index.js';

let workerConfigured = false;

export default function PdfRenderer({ document }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState({ loading: true, error: '' });
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let task;
    setStatus({ loading: true, error: '' });

    async function render() {
      const pdfjs = await import('pdfjs-dist');
      if (!workerConfigured) {
        const worker = new PdfWorker();
        pdfjs.GlobalWorkerOptions.workerPort = worker;
        workerConfigured = true;
      }
      const data = await loadPreviewArrayBuffer(document.previewUrl, { signal: controller.signal });
      task = pdfjs.getDocument({ data });
      const pdf = await task.promise;
      const root = containerRef.current;
      if (!root || cancelled) return;
      root.replaceChildren();
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(pageNumber);
        const unscaled = page.getViewport({ scale: 1, rotation });
        const maxWidth = Math.max(320, Math.min(root.clientWidth - 32, 1440));
        const viewport = page.getViewport({ scale: (maxWidth / unscaled.width) * scale, rotation });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = window.document.createElement('canvas');
        canvas.className = 'dsh-doc-preview-pdf-page';
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        root.appendChild(canvas);
        await page.render({
          canvasContext: canvas.getContext('2d'), viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        }).promise;
        page.cleanup();
      }
    }

    render().catch((reason) => {
      if (!cancelled && reason?.name !== 'AbortError') setStatus({ loading: false, error: reason?.message || String(reason) });
    }).finally(() => {
      if (!cancelled) setStatus((current) => ({ ...current, loading: false }));
    });
    return () => {
      cancelled = true;
      controller.abort();
      task?.destroy();
      containerRef.current?.replaceChildren();
    };
  }, [document.previewUrl, rotation, scale]);

  return <div className="dsh-doc-preview-renderer">
    <div className="dsh-doc-preview-renderer-tools" aria-label="PDF 查看控制">
      <button type="button" onClick={() => setScale((value) => Math.max(.5, value - .25))} disabled={scale <= .5} title="缩小" aria-label="缩小"><Minus aria-hidden="true" /></button>
      <span>{Math.round(scale * 100)}%</span>
      <button type="button" onClick={() => setScale((value) => Math.min(2, value + .25))} disabled={scale >= 2} title="放大" aria-label="放大"><Plus aria-hidden="true" /></button>
      <button type="button" onClick={() => setRotation((value) => (value + 90) % 360)} title="顺时针旋转" aria-label="顺时针旋转"><RotateCcw className="is-clockwise" aria-hidden="true" /></button>
    </div>
    <div className="dsh-doc-preview-scroll dsh-doc-preview-pdf">
      {status.loading && <div className="dsh-doc-preview-message">正在加载 PDF…</div>}
      {status.error && <div className="dsh-doc-preview-message is-error">{status.error}</div>}
      <div ref={containerRef} className="dsh-doc-preview-pdf-pages" />
    </div>
  </div>;
}
