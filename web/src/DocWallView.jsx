// 文稿视图：左侧节点列表 + 右侧大卡横向条带（原型 v2 定稿的主从布局）。
// 数据原则 = 磁盘事实（run-results）投影 + SSE 实时叠加；异常恢复一律「重新投影」。
// 性能红线（方案 v1.1 §四）：卡内 ≤2000 字符截断、懒挂载、视频不预载、React.memo 隔离重渲。
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Clock3, FileText, Film, ImageIcon, Loader2, RefreshCw } from 'lucide-react';
import { buildDocWallModel } from './doc-wall-data.js';
import MarkdownDocument from './MarkdownDocument.jsx';
import { ArtifactPreviewButton, ArtifactPreviewModal, runArtifact } from './ArtifactPreview.jsx';
import { apiUrl } from './api.js';

const STATUS_ICON = {
  running: <Loader2 size={13} className="docspin" />,
  success: <Check size={13} />,
  error: <AlertTriangle size={13} />,
  canceled: <AlertTriangle size={13} />,
};

function formatDuration(ms) {
  if (ms == null) return '';
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分` : `${(ms / 1000).toFixed(1)} 秒`;
}

/* ---------- 懒挂载包装：进入视口才挂子树，挂后保留（内容静态不卸载） ---------- */
function LazyMount({ children, placeholderHeight = 320 }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !ref.current || typeof IntersectionObserver === 'undefined') {
      if (typeof IntersectionObserver === 'undefined') setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: ref.current?.closest('.docwall-strip'), rootMargin: '200px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div ref={ref} className="docwall-lazy" style={visible ? undefined : { minHeight: placeholderHeight }}>
      {visible ? children : null}
    </div>
  );
}

/* ---------- doc 卡正文：nodeStates 产物只有文件名，进入视口后惰性拉取；
   拉取失败（运行被清理/历史 resume 目录已删）渲染占位，不白屏不报错 ---------- */
function useDocBody(doc) {
  const [body, setBody] = useState(() => doc.content || '');
  const [state, setState] = useState(() => (doc.content ? 'ready' : doc.downloadUrl ? 'idle' : 'missing'));
  const startedRef = useRef(false);
  useEffect(() => {
    // startedRef 防重入：状态只在完成时翻转，避免 setState 触发 effect 重跑
    // 把在途 fetch 的结果用 alive 丢弃（会永远卡在 loading）
    if (state !== 'idle' || startedRef.current || !doc.downloadUrl) return undefined;
    startedRef.current = true;
    let alive = true;
    fetch(doc.downloadUrl).then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    }).then((text) => {
      if (alive) { setBody(text); setState('ready'); }
    }).catch(() => {
      if (alive) setState('missing');
    });
    return () => { alive = false; };
  }, [state, doc.downloadUrl]);
  return { state, body };
}

/* ---------- 文档卡（md 可读卡 / 图片 / 视频占位 / data chip 由 Strip 渲染） ---------- */
const DocCard = memo(function DocCard({ doc, onOpen }) {
  const open = () => onOpen?.(doc);
  const { state, body: bodyText } = useDocBody(doc);
  let body;
  if (doc.kind === 'image') {
    body = (
      <div className="docwall-media">
        <img src={doc.previewUrl || doc.downloadUrl} alt={doc.name} loading="lazy" onClick={open} />
      </div>
    );
  } else if (doc.kind === 'video') {
    // 性能红线：视频卡不挂 <video>，时长未知渲染占位块，真视频只进预览弹窗
    body = <div className="docwall-media docwall-video-ph" onClick={open} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}><Film size={26} /><span>视频 · 点击预览</span></div>;
  } else if (state === 'missing') {
    body = (
      <div className="docwall-card-body docwall-card-missing">
        <AlertTriangle size={15} />
        <p>正文暂不可读（文件可能已随运行归档清理）。</p>
        {doc.downloadUrl && <a href={doc.downloadUrl} download onClick={(e) => e.stopPropagation()}>尝试下载</a>}
      </div>
    );
  } else if (state === 'loading' || state === 'idle') {
    // idle 瞬间即转 fetch；显示 loading 态（不 setState，防 effect 重跑）
    body = <div className="docwall-card-body docwall-card-loading"><Loader2 size={14} className="docspin" /> 正在读取正文…</div>;
  } else {
    body = (
      <div className="docwall-card-body" onClick={open} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
        <MarkdownDocument content={bodyText} files={[]} />
      </div>
    );
  }
  const Icon = doc.kind === 'image' ? ImageIcon : doc.kind === 'video' ? Film : FileText;
  return (
    <article className={`docwall-card docwall-card-${doc.kind}`}>
      <header className="docwall-card-head" onClick={open}>
        <Icon size={14} aria-hidden="true" />
        <span className="docwall-card-name" title={doc.name}>{doc.name}</span>
        <ArtifactPreviewButton artifact={doc} className="docwall-card-pv">⤢</ArtifactPreviewButton>
      </header>
      {body}
    </article>
  );
});

/* ---------- 流卡：agent 节点运行中的实时输出（方案 v1.1：诚实标注「实时输出」） ---------- */
function LiveCard({ progress, structured }) {
  const text = structured ? '' : String(progress?.preview || '');
  return (
    <article className="docwall-card docwall-card-live">
      <header className="docwall-card-head">
        <Loader2 size={14} className="docspin" aria-hidden="true" />
        <span className="docwall-card-name">实时输出</span>
        {structured && <span className="docwall-live-structured">结构化生成中</span>}
        {progress?.turns > 0 && <span className="docwall-live-turns">第 {progress.turns} 轮</span>}
      </header>
      <div className="docwall-card-body docwall-live-body">
        {text ? <MarkdownDocument content={text} files={[]} /> : <span className="docwall-live-wait">等待首个输出…</span>}
      </div>
    </article>
  );
}

/* ---------- 单节点条带 ---------- */
function NodeStrip({ node, liveProgress, onOpen }) {
  const [chipOpen, setChipOpen] = useState(false);
  const dataFiles = node.dataFiles || [];
  const strip = node.docs || [];
  const live = node.live && liveProgress !== undefined;
  return (
    <section className="docwall-strip" aria-label={node.nodeLabel}>
      <header className="docwall-strip-head">
        <span className={`docwall-strip-status docwall-strip-status-${node.status}`}>{STATUS_ICON[node.status] || null}</span>
        <strong>{node.nodeLabel}</strong>
        {node.durationMs != null && <span className="docwall-strip-meta"><Clock3 size={11} />{formatDuration(node.durationMs)}</span>}
        <span className="docwall-strip-meta">{strip.length + dataFiles.length} 个文件</span>
        {node.error && <span className="docwall-strip-error" title={node.error}>{node.error}</span>}
      </header>
      <div className={`docwall-strip-cards ${strip.length > 0 && strip.length <= 2 ? 'docwall-strip-cards-sparse' : ''}`}>
        {live && <LiveCard progress={liveProgress} structured={liveProgress?.structured} />}
        {strip.map((doc) => <LazyMount key={doc.id}><DocCard doc={doc} onOpen={onOpen} /></LazyMount>)}
        {strip.length === 0 && !dataFiles.length && !live && (
          <div className="docwall-strip-empty">本节点无文件产物</div>
        )}
      </div>
      {dataFiles.length > 0 && (
        <div className="docwall-chiprow">
          <button type="button" className="docwall-chip" onClick={() => setChipOpen((v) => !v)}>
            <ChevronRight size={12} style={{ transform: chipOpen ? 'rotate(90deg)' : 'none' }} />
            {dataFiles.length} 个中间文件
          </button>
          {chipOpen && dataFiles.map((file) => (
            <span key={file.id} className="docwall-chip docwall-chip-file">
              <ArtifactPreviewButton artifact={file} className="docwall-chip-pv">{file.name}</ArtifactPreviewButton>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- 主组件：模型计算 + 左右布局 ---------- */
export function DocWallView({
  runResults, progressByNode = {}, nodeStates = {}, inspectedRunId,
  loading = false, loadError = '', onRetry, onRefresh,
}) {
  const model = useMemo(
    () => buildDocWallModel({
      runResults,
      progressByNode,
      nodeStates,
      // nodeStates 产物只有裸文件名，URL 须经 apiUrl 注入 sessionId（scoped 路由必需）
      scopedArtifactUrl: (runId, nodeId, path) => runArtifact(runId, nodeId, path).downloadUrl,
    }),
    [runResults, progressByNode, nodeStates],
  );
  const [selected, setSelected] = useState('overview'); // 'overview' | 'finals' | nodeId
  const [previewDoc, setPreviewDoc] = useState(null); // 点卡页内预览（ArtifactPreviewModal），不跳浏览器
  useEffect(() => { setSelected('overview'); }, [inspectedRunId]);

  const onOpen = (doc) => { if (doc?.name) setPreviewDoc(doc); };

  if (loadError) {
    return (
      <div className="docwall docwall-center">
        <p className="docwall-load-error"><AlertTriangle size={15} />{loadError}</p>
        <button type="button" className="btn" onClick={onRetry}><RefreshCw size={14} />重试</button>
      </div>
    );
  }
  if (loading && !runResults?.runId) {
    return <div className="docwall docwall-center"><Loader2 size={17} className="docspin" /> 正在加载文稿…</div>;
  }
  if (!model.hasRun) {
    return <div className="docwall docwall-center docwall-empty">运行一次工作流后，过程文稿会铺在这里。</div>;
  }

  const selectedNode = model.nodes.find((node) => node.nodeId === selected) || null;
  const visibleNodes = selected === 'overview' ? model.nodes : selectedNode ? [selectedNode] : [];

  return (
    <div className="docwall">
      <aside className="docwall-side" aria-label="节点列表">
        <button type="button" className={`docwall-row ${selected === 'overview' ? 'docwall-row-on' : ''}`} onClick={() => setSelected('overview')}>
          <span className="docwall-row-name">总览 · 全部节点</span>
          <span className="docwall-row-cnt">{model.nodes.length}</span>
        </button>
        <button type="button" className={`docwall-row ${selected === 'finals' ? 'docwall-row-on' : ''}`} onClick={() => setSelected('finals')}>
          <span className="docwall-row-name">成果</span>
          <span className="docwall-row-cnt">{model.finals.docs.length}</span>
        </button>
        <div className="docwall-side-label">过程 · 执行顺序</div>
        {model.nodes.map((node) => (
          <button key={node.nodeId} type="button"
            className={`docwall-row ${selected === node.nodeId ? 'docwall-row-on' : ''} ${node.docs.length + node.dataFiles.length === 0 ? 'docwall-row-zero' : ''}`}
            onClick={() => setSelected(node.nodeId)}>
            <span className={`docwall-dot docwall-dot-${node.status}`} aria-hidden="true" />
            <span className="docwall-row-name">{node.nodeLabel}</span>
            {node.docs.length + node.dataFiles.length > 0 && <span className="docwall-row-cnt">{node.docs.length + node.dataFiles.length}</span>}
          </button>
        ))}
      </aside>

      <div className="docwall-main">
        <div className="docwall-toolbar">
          <strong>{model.workflowName || '当前运行'}</strong>
          <span className="docwall-toolbar-meta">{model.finals.docs.length + model.totals.docs} 份文稿</span>
          <span className="docwall-toolbar-spacer" />
          {onRefresh && <button type="button" className="btn btn-icon" title="刷新文稿" aria-label="刷新文稿" onClick={onRefresh}><RefreshCw size={14} /></button>}
        </div>

        {selected === 'finals' ? (
          <section className="docwall-strip" aria-label="成果">
            <header className="docwall-strip-head docwall-strip-head-final"><strong>◆ 成果</strong><span className="docwall-strip-meta">{model.finals.docs.length} 文档 · {model.finals.links.length} 链接</span></header>
            <div className="docwall-strip-cards">
              {model.finals.docs.map((doc) => <LazyMount key={doc.id}><DocCard doc={doc} onOpen={onOpen} /></LazyMount>)}
              {model.finals.links.map((link) => (
                <a key={link.url} className="docwall-card docwall-card-link" href={link.url} target="_blank" rel="noreferrer">🔗 {link.label}</a>
              ))}
              {!model.finals.docs.length && !model.finals.links.length && <div className="docwall-strip-empty">本次运行没有 output 节点产物。</div>}
            </div>
          </section>
        ) : (
          visibleNodes.map((node) => (
            <NodeStrip key={node.nodeId} node={node} liveProgress={progressByNode[node.nodeId]} onOpen={onOpen} />
          ))
        )}
      </div>
      {previewDoc && <ArtifactPreviewModal artifact={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  );
}
