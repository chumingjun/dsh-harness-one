import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import SheetWorker from './sheet.worker.js?worker&inline';
import { loadPreviewArrayBuffer } from '../index.js';

const PAGE_SIZE = 200;

function columnName(index) {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export default function SheetRenderer({ document }) {
  const [model, setModel] = useState({ loading: true, error: '', sheets: [], active: '' });
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const worker = new SheetWorker();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      worker.terminate();
      if (!cancelled) setModel({ loading: false, error: '工作簿解析超时，请下载后查看。', sheets: [], active: '' });
    }, 30000);
    setModel({ loading: true, error: '', sheets: [], active: '' });
    worker.onmessage = ({ data }) => {
      window.clearTimeout(timer);
      if (cancelled) return;
      if (!data?.ok) setModel({ loading: false, error: data?.error || '工作簿解析失败', sheets: [], active: '' });
      else setModel({ loading: false, error: '', sheets: data.sheets, active: data.sheets[0]?.name || '' });
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      if (!cancelled) setModel({ loading: false, error: event.message || '工作簿解析失败', sheets: [], active: '' });
    };
    loadPreviewArrayBuffer(document.previewUrl, { signal: controller.signal })
      .then((data) => worker.postMessage(data, [data]))
      .catch((reason) => {
        window.clearTimeout(timer);
        if (!cancelled && reason?.name !== 'AbortError') setModel({ loading: false, error: reason?.message || String(reason), sheets: [], active: '' });
      });
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); worker.terminate(); };
  }, [document.previewUrl]);

  const activeSheet = model.sheets.find((sheet) => sheet.name === model.active);
  const filteredRows = useMemo(() => {
    const rows = activeSheet?.rows || [];
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(needle))) : rows;
  }, [activeSheet, query]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const rows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [model.active, query]);

  return <div className="dsh-doc-preview-sheet">
    <div className="dsh-doc-preview-sheet-toolbar">
      <div className="dsh-doc-preview-sheet-tabs" role="tablist" aria-label="工作表">
        {model.sheets.map((sheet) => <button key={sheet.name} type="button" role="tab" aria-selected={sheet.name === model.active} className={sheet.name === model.active ? 'is-active' : ''} onClick={() => setModel((current) => ({ ...current, active: sheet.name }))}>{sheet.name}</button>)}
      </div>
      <label className="dsh-doc-preview-search"><Search aria-hidden="true" /><span className="dsh-doc-sr-only">搜索单元格</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" /></label>
      <div className="dsh-doc-preview-pager">
        <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} title="上一页" aria-label="上一页"><ChevronLeft aria-hidden="true" /></button>
        <span>{page + 1} / {pageCount}</span>
        <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)} title="下一页" aria-label="下一页"><ChevronRight aria-hidden="true" /></button>
      </div>
    </div>
    <div className="dsh-doc-preview-scroll dsh-doc-preview-sheet-body">
      {model.loading && <div className="dsh-doc-preview-message">正在加载工作簿…</div>}
      {model.error && <div className="dsh-doc-preview-message is-error">{model.error}</div>}
      {activeSheet && <table className="dsh-doc-preview-grid"><thead><tr><th aria-label="行号" />{Array.from({ length: activeSheet.columnCount }, (_, index) => <th key={index}>{columnName(index)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={page * PAGE_SIZE + rowIndex}><th>{page * PAGE_SIZE + rowIndex + 1}</th>{row.map((cell, cellIndex) => <td key={cellIndex} title={cell}>{cell}</td>)}</tr>)}</tbody></table>}
      {!model.loading && !model.error && !activeSheet && <div className="dsh-doc-preview-message">工作簿为空。</div>}
      {!model.loading && activeSheet && !rows.length && <div className="dsh-doc-preview-message">没有匹配的单元格。</div>}
    </div>
  </div>;
}
