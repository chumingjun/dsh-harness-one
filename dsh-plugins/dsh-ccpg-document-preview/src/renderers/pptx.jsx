import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Presentation } from 'lucide-react';
import PptxWorker from '@file-viewer/pptx/worker/pptx.worker.js?worker&inline';
import { loadPreviewArrayBuffer } from '../index.js';

export default function PptxRenderer({ document }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState({ loading: true, error: '' });
  const [viewerState, setViewerState] = useState({ viewer: null, zoom: 100, slides: 0, warnings: 0 });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let viewer;
    const root = containerRef.current;
    setStatus({ loading: true, error: '' });
    setViewerState({ viewer: null, zoom: 100, slides: 0, warnings: 0 });
    Promise.all([
      import('@file-viewer/pptx'), import('@file-viewer/pptx/styles.css'),
      loadPreviewArrayBuffer(document.previewUrl, { signal: controller.signal }),
    ]).then(async ([pptx, _styles, data]) => {
      if (!root || cancelled) return;
      root.replaceChildren();
      let warningCount = 0;
      viewer = await pptx.PptxViewer.open(data, root, {
        fitMode: 'contain', zoomPercent: 100,
        workerFactory: () => new PptxWorker(),
        onWarning: () => { warningCount += 1; },
      });
      if (!cancelled) setViewerState({ viewer, zoom: viewer.zoomPercent, slides: viewer.slideCount, warnings: warningCount });
    }).catch((reason) => {
      if (!cancelled && reason?.name !== 'AbortError') setStatus({ loading: false, error: reason?.message || String(reason) });
    }).finally(() => {
      if (!cancelled) setStatus((current) => ({ ...current, loading: false }));
    });
    return () => {
      cancelled = true;
      controller.abort();
      viewer?.destroy();
      root?.replaceChildren();
    };
  }, [document.previewUrl]);

  const setZoom = async (zoom) => {
    const next = Math.max(50, Math.min(200, zoom));
    await viewerState.viewer?.setZoom(next);
    setViewerState((current) => ({ ...current, zoom: next }));
  };

  return <div className="dsh-doc-preview-renderer">
    <div className="dsh-doc-preview-renderer-tools" aria-label="PPTX 查看控制">
      <button type="button" disabled={!viewerState.viewer || viewerState.zoom <= 50} onClick={() => setZoom(viewerState.zoom - 10)} title="缩小" aria-label="缩小"><Minus aria-hidden="true" /></button>
      <span>{viewerState.zoom}%</span>
      <button type="button" disabled={!viewerState.viewer || viewerState.zoom >= 200} onClick={() => setZoom(viewerState.zoom + 10)} title="放大" aria-label="放大"><Plus aria-hidden="true" /></button>
      <button type="button" disabled={!viewerState.viewer} onClick={() => viewerState.viewer?.enterPresentation()} title="放映" aria-label="放映"><Presentation aria-hidden="true" /></button>
      {viewerState.slides > 0 && <span>{viewerState.slides} 张幻灯片</span>}
      {viewerState.warnings > 0 && <span className="is-warning">部分复杂内容可能无法完整显示</span>}
    </div>
    <div className="dsh-doc-preview-scroll dsh-doc-preview-pptx">
      {status.loading && <div className="dsh-doc-preview-message">正在加载 PPTX…</div>}
      {status.error && <div className="dsh-doc-preview-message is-error">{status.error}</div>}
      <div ref={containerRef} className="dsh-doc-preview-pptx-body" />
    </div>
  </div>;
}
