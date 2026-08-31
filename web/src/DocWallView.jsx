// 文稿视图：左侧节点列表 + 右侧大卡横向条带（原型 v2 定稿的主从布局）。
// 数据原则 = 磁盘事实（run-results）投影 + SSE 实时叠加；异常恢复一律「重新投影」。
// 性能红线（方案 v1.1 §四）：卡内 ≤2000 字符截断、懒挂载、视频不预载、React.memo 隔离重渲。
import { memo, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Clock3, FileText, Film, ImageIcon, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { buildDocWallModel, clipDocContent } from './doc-wall-data.js';
import MarkdownDocument from './MarkdownDocument.jsx';
import { ArtifactPreviewButton, ArtifactPreviewModal, runArtifact } from './ArtifactPreview.jsx';
import { FeedbackDrawer, feedbackKey, useArtifactFeedback } from './docwall-feedback.jsx';
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

/* ---------- doc 卡正文：nodeStates 产物只有文件名，正文按需获取。
   优先消费批量预取缓存（BULK context，一次请求拉全条带），缓存未命中再单卡惰性拉取；
   拉取失败（运行被清理/历史 resume 目录已删）渲染占位，不白屏不报错 ---------- */
const BulkContext = createContext(null);
// run 级产物清单（卡内引用互链）：正文行内 code 引用的文件名命中清单即变预览链接
const FilesContext = createContext([]);

function useDocBody(doc) {
  const bulk = useContext(BulkContext);
  const cached = bulk?.get(`${doc.nodeId || ''}\u0000${doc.name}`);
  const [body, setBody] = useState(() => doc.content || cached?.content || '');
  const [state, setState] = useState(() => {
    if (doc.content || cached?.content) return 'ready';
    if (cached?.omitted) return 'idle'; // 批量时超预算被省略，回退单卡拉取
    return doc.downloadUrl ? 'idle' : 'missing';
  });
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
      // 与内联 content 同一红线：卡内只渲染截断稿，全文进预览弹窗
      if (alive) { setBody(clipDocContent(text)); setState('ready'); }
    }).catch(() => {
      if (alive) setState('missing');
    });
    return () => { alive = false; };
  }, [state, doc.downloadUrl]);
  return { state, body };
}

/* ---------- 文档卡（md 可读卡 / 图片 / 视频占位 / data chip 由 Strip 渲染） ---------- */
const DocCard = memo(function DocCard({ doc, onOpen, fresh, onComment, commentCount, revisionCount, commenting }) {
  const open = () => onOpen?.(doc);
  const files = useContext(FilesContext);
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
        <MarkdownDocument content={bodyText} files={files} />
      </div>
    );
  }
  const Icon = doc.kind === 'image' ? ImageIcon : doc.kind === 'video' ? Film : FileText;
  return (
    <article className={`docwall-card docwall-card-${doc.kind} ${fresh ? 'docwall-card-fresh' : ''} ${commenting ? 'docwall-card-commenting' : ''}`}>
      <header className="docwall-card-head" onClick={open}>
        <Icon size={14} aria-hidden="true" />
        <span className="docwall-card-name" title={doc.name}>{doc.name}</span>
        {revisionCount > 0 && <span className="docwall-card-badge" title={`${revisionCount} 个修订版本`}>✎{revisionCount}</span>}
        {onComment && (
          <button type="button"
            className={`btn btn-icon docwall-card-cmt ${commentCount ? 'docwall-card-cmt-on' : ''}`}
            title="评论 / 修改建议" aria-label={`评论 ${doc.name}`}
            onClick={(e) => { e.stopPropagation(); onComment(doc); }}>
            <MessageSquare size={13} />
            {commentCount > 0 && <span className="docwall-card-cmt-n">{commentCount}</span>}
          </button>
        )}
        <ArtifactPreviewButton artifact={doc} className="docwall-card-pv">⤢</ArtifactPreviewButton>
      </header>
      {body}
    </article>
  );
});

/* ---------- 流卡：agent 节点运行中的实时输出。
   docTail 存在（引擎扫到节点正在写的文本产物）优先渲染「正在生成：<文件名>」的尾部，
   否则回退 agent 对话文本（诚实标注「实时输出」） ---------- */
function LiveCard({ progress, structured }) {
  const docTail = progress?.docTail;
  const text = structured ? '' : String(progress?.preview || '');
  const files = useContext(FilesContext);
  const bodyContent = docTail?.tail
    ? <MarkdownDocument content={`${docTail.tail}\n\n*……生成中（${docTail.name}，已写 ${docTail.size} 字节）*`} files={files} />
    : text ? <MarkdownDocument content={text} files={files} /> : null;
  return (
    <article className="docwall-card docwall-card-live">
      <header className="docwall-card-head">
        <Loader2 size={14} className="docspin" aria-hidden="true" />
        <span className="docwall-card-name">{docTail?.name ? `正在生成：${docTail.name}` : '实时输出'}</span>
        {structured && <span className="docwall-live-structured">结构化生成中</span>}
        {progress?.turns > 0 && <span className="docwall-live-turns">第 {progress.turns} 轮</span>}
      </header>
      <div className="docwall-card-body docwall-live-body">
        {bodyContent || <span className="docwall-live-wait">等待首个输出…</span>}
      </div>
    </article>
  );
}

/* ---------- 单节点条带 ---------- */
function NodeStrip({ node, liveProgress, onOpen, registerRef, freshIds, feedback, onComment, commentingKey }) {
  const [chipOpen, setChipOpen] = useState(false);
  const dataFiles = node.dataFiles || [];
  const strip = node.docs || [];
  const live = node.live && liveProgress !== undefined;
  const cardProps = (doc) => {
    const entry = feedback?.byArtifact.get(feedbackKey(doc));
    return {
      onComment,
      commentCount: entry?.comments.length || 0,
      revisionCount: entry?.revisions.length || 0,
      commenting: commentingKey === feedbackKey(doc),
    };
  };
  return (
    <section className="docwall-strip" aria-label={node.nodeLabel} ref={registerRef}>
      <header className="docwall-strip-head">
        <span className={`docwall-strip-status docwall-strip-status-${node.status}`}>{STATUS_ICON[node.status] || null}</span>
        <strong>{node.nodeLabel}</strong>
        {node.durationMs != null && <span className="docwall-strip-meta"><Clock3 size={11} />{formatDuration(node.durationMs)}</span>}
        <span className="docwall-strip-meta">{strip.length + dataFiles.length} 个文件</span>
        {node.error && <span className="docwall-strip-error" title={node.error}>{node.error}</span>}
      </header>
      <div className={`docwall-strip-cards ${strip.length > 0 && strip.length <= 2 ? 'docwall-strip-cards-sparse' : ''}`}>
        {live && <LiveCard progress={liveProgress} structured={liveProgress?.structured} />}
        {strip.map((doc) => <LazyMount key={doc.id}><DocCard doc={doc} onOpen={onOpen} fresh={freshIds?.has(doc.id)} {...cardProps(doc)} /></LazyMount>)}
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
  runResults, progressByNode = {}, nodeStates = {}, inspectedRunId, resultsReadyToken = 0,
  loading = false, loadError = '', onRetry, onRefresh,
  onRunHere, recentRuns = [], onInspectRun,
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

  // 评论与修订（issue #97）：换 run 重置抽屉；revision-ready SSE 到达时经 refreshToken 重拉
  const feedback = useArtifactFeedback(model.runId, resultsReadyToken);
  const [commentDoc, setCommentDoc] = useState(null);
  useEffect(() => { setCommentDoc(null); }, [model.runId]);

  // 批量预取：一次请求拉全 run 的 doc 产物截断正文（替代 37 卡 37 请求）。
  // 只对「无内联正文」的 doc 卡发起；key = `${nodeId}\u0000${name}`，与数据层去重键一致。
  const [bulk, setBulk] = useState(null);
  const bulkRunRef = useRef('');
  useEffect(() => {
    if (!model.hasRun || !model.runId) return undefined;
    const docItems = [];
    for (const node of model.nodes) {
      for (const doc of node.docs) {
        if (doc.kind === 'doc' && !doc.content && doc.nodeId) {
          docItems.push({ node: doc.nodeId, file: doc.path || doc.name, name: doc.name });
        }
      }
    }
    for (const doc of model.finals.docs) {
      if (doc.kind === 'doc' && !doc.content && doc.nodeId) {
        docItems.push({ node: doc.nodeId, file: doc.path || doc.name, name: doc.name });
      }
    }
    if (!docItems.length) { setBulk(new Map()); return undefined; }
    let alive = true;
    fetch(apiUrl('/artifacts/content'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: model.runId, items: docItems.map(({ node, file }) => ({ node, file })) }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then((data) => {
      if (!alive) return;
      const map = new Map();
      docItems.forEach(({ node, file, name }, i) => {
        map.set(`${node}\u0000${name}`, data.files?.[`${node}\u0000${file}`] || { omitted: true });
      });
      setBulk(map);
    }).catch(() => {
      if (alive) setBulk(new Map()); // 失败不阻塞渲染：各卡回退单卡惰性拉取
    });
    return () => { alive = false; };
  }, [model]);
  useEffect(() => { // 换运行重置批量缓存
    if (bulkRunRef.current !== (model.runId || '')) { bulkRunRef.current = model.runId || ''; setBulk(null); }
  }, [model.runId]);

  const onOpen = (doc) => { if (doc?.name) setPreviewDoc(doc); };

  // —— 新卡高亮：localStorage 记每 run 的已读时间戳，完成时间晚于它的卡标 fresh；
  // 离开文稿视图（卸载）时把已读戳推进到当前时刻 ——
  const readMarkRef = useRef(null);
  const readMarkKey = `wf1.docwall.read.${model.runId || 'none'}`;
  const [freshIds, setFreshIds] = useState(() => new Set());
  useEffect(() => {
    try {
      const lastRead = Number(localStorage.getItem(readMarkKey) || 0);
      readMarkRef.current = lastRead;
      const ids = new Set();
      const consider = (docs) => {
        for (const doc of docs) {
          const finished = doc.finishedAt ? Date.parse(doc.finishedAt) : 0;
          if (finished > lastRead) ids.add(doc.id);
        }
      };
      model.nodes.forEach((node) => consider(node.docs));
      consider(model.finals.docs);
      setFreshIds(ids);
    } catch { /* localStorage 不可用则无高亮 */ }
    return () => { // 卸载/换运行：已读推进
      try { localStorage.setItem(readMarkKey, String(Date.now())); } catch { /* noop */ }
    };
  }, [readMarkKey, model]);

  // —— 密度切换 S/M/L（卡宽 300/420/520）——
  const [density, setDensity] = useState(() => localStorage.getItem('wf1.docwall.density') || 'm');
  useEffect(() => { try { localStorage.setItem('wf1.docwall.density', density); } catch { /* noop */ } }, [density]);

  // —— 搜索 / 类型过滤 / 只看有产物（P5）：作用于卡片与侧栏计数，纯前端投影 ——
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all'); // all | doc | image | video
  const [onlyWithFiles, setOnlyWithFiles] = useState(false);
  const matchDoc = (doc) => (kindFilter === 'all' || doc.kind === kindFilter)
    && (!query || doc.name.toLowerCase().includes(query.toLowerCase()));
  const filteredNodes = useMemo(() => model.nodes.map((node) => {
    const docs = node.docs.filter(matchDoc);
    const dataFiles = query || kindFilter !== 'all' ? [] : node.dataFiles; // 非全部类型时隐藏 data chip 行避免误导
    return { ...node, docs, dataFiles };
  }), [model.nodes, query, kindFilter]);

  // —— 总览滚动定位 + scroll-spy（P4）：总览模式点行滚动到条带；滚动时反写高亮 ——
  const mainRef = useRef(null);
  const stripRefs = useRef(new Map());
  const spyLockRef = useRef(0); // 点击定位后短暂锁死 spy，避免滚动途中高亮乱跳
  const [spyNode, setSpyNode] = useState('');
  useEffect(() => {
    const main = mainRef.current;
    if (!main || selected !== 'overview') { setSpyNode(''); return undefined; }
    const onScroll = () => {
      if (Date.now() < spyLockRef.current) return;
      let current = '';
      for (const node of model.nodes) {
        const el = stripRefs.current.get(node.nodeId);
        if (el && el.getBoundingClientRect().bottom > 120) { current = node.nodeId; break; }
      }
      setSpyNode(current);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => main.removeEventListener('scroll', onScroll);
  }, [selected, model.nodes]);

  const locateNode = (nodeId) => {
    const main = mainRef.current;
    const el = stripRefs.current.get(nodeId);
    if (!main || !el) return;
    spyLockRef.current = Date.now() + 700;
    main.scrollTo({ top: el.offsetTop - 60, behavior: 'smooth' });
    setSpyNode(nodeId);
  };

  // —— 键盘导航：J/K（或 ↑/↓）在节点间移动定位，Esc 关预览，/ 聚焦搜索 ——
  // hooks 全部在早退分支之前（规则：hook 调用顺序不能条件化）
  const searchRef = useRef(null);
  const orderedNodeIds = useMemo(() => model.nodes.map((n) => n.nodeId), [model.nodes]);
  const moveFocus = (delta) => {
    if (selected === 'finals') { if (delta < 0) setSelected('overview'); return; }
    if (selected === 'overview') {
      const anchor = spyNode && orderedNodeIds.includes(spyNode) ? spyNode : orderedNodeIds[0];
      const idx = Math.max(0, orderedNodeIds.indexOf(anchor));
      const next = orderedNodeIds[Math.min(orderedNodeIds.length - 1, Math.max(0, idx + (delta > 0 ? 1 : delta < 0 && spyNode ? -1 : 0)))];
      if (next) locateNode(next);
      return;
    }
    const idx = orderedNodeIds.indexOf(selected);
    const next = orderedNodeIds[idx + (delta > 0 ? 1 : -1)];
    if (next) setSelected(next);
  };
  useEffect(() => {
    const root = mainRef.current?.closest('.docwall');
    if (!root) return undefined;
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'Escape') { setPreviewDoc(null); return; }
      if (previewDoc) return; // 弹窗开着只吃 Esc
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
      if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }); // 每渲染重挂：闭包里的 selected/spyNode/previewDoc 恒新

  // run 级产物清单（卡内引用互链）：过程 + 成果 + stateArtifacts 卡全部入清单
  const runFiles = useMemo(() => {
    const files = [];
    const seen = new Set();
    const push = (docs) => {
      for (const doc of docs || []) {
        const key = `${doc.nodeId || ''}:${doc.name}`;
        if (seen.has(key) || (!doc.downloadUrl && !doc.previewUrl)) continue;
        seen.add(key);
        files.push(doc);
      }
    };
    model.nodes.forEach((node) => { push(node.docs); push(node.dataFiles); });
    push(model.finals.docs);
    return files;
  }, [model]);

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
    // 空态引导（P8）：给出去处，而不是一句静默文案
    return (
      <div className="docwall docwall-center docwall-empty">
        <p>运行一次工作流后，过程文稿会铺在这里。</p>
        {onRunHere
          ? <button type="button" className="btn btn-primary" onClick={onRunHere}>▶ 去画布运行</button>
          : (recentRuns?.length ? (
            <div className="docwall-empty-runs">
              <div className="docwall-side-label">最近运行</div>
              {recentRuns.slice(0, 5).map((run) => (
                <button key={run.runId} type="button" className="docwall-row" onClick={() => onInspectRun?.(run.runId)}>
                  <span className="docwall-row-name">{run.workflowName || run.runId}</span>
                  <span className="docwall-row-cnt">{run.status}</span>
                </button>
              ))}
            </div>
          ) : null)}
      </div>
    );
  }

  const selectedNode = model.nodes.find((node) => node.nodeId === selected) || null;
  const overviewNodes = onlyWithFiles
    ? filteredNodes.filter((node) => node.docs.length + node.dataFiles.length > 0 || progressByNode[node.nodeId])
    : filteredNodes;
  const visibleNodes = selected === 'overview' ? overviewNodes : selectedNode ? [filteredNodes.find((n) => n.nodeId === selected) || selectedNode] : [];

  return (
    <BulkContext.Provider value={bulk}>
    <FilesContext.Provider value={runFiles}>
    <div className={`docwall docwall-density-${density}`}>
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
            className={`docwall-row ${(selected === node.nodeId || (selected === 'overview' && spyNode === node.nodeId)) ? 'docwall-row-on' : ''} ${node.docs.length + node.dataFiles.length === 0 ? 'docwall-row-zero' : ''}`}
            onClick={() => (selected === 'overview' ? locateNode(node.nodeId) : setSelected(node.nodeId))
              }>
            <span className={`docwall-dot docwall-dot-${node.status}`} aria-hidden="true" />
            <span className="docwall-row-name">{node.nodeLabel}</span>
            {node.docs.length + node.dataFiles.length > 0 && <span className="docwall-row-cnt">{node.docs.length + node.dataFiles.length}</span>}
          </button>
        ))}
      </aside>

      <div className="docwall-main" ref={mainRef}>
        <div className="docwall-toolbar">
          <strong>{model.workflowName || '当前运行'}</strong>
          <span className="docwall-toolbar-meta">{model.finals.docs.length + model.totals.docs} 份文稿</span>
          <span className="docwall-toolbar-spacer" />
          <input type="search" ref={searchRef} className="docwall-search" placeholder="搜索文件名…（/）" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="搜索文件名" />
          <select className="docwall-kind" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="按类型过滤">
            <option value="all">全部类型</option>
            <option value="doc">文档</option>
            <option value="image">图片</option>
            <option value="video">视频</option>
          </select>
          <div className="docwall-density" role="group" aria-label="卡片密度">
            {['s', 'm', 'l'].map((d) => (
              <button key={d} type="button" className={`docwall-density-btn ${density === d ? 'docwall-density-on' : ''}`}
                title={{ s: '紧凑', m: '适中', l: '宽松' }[d]} aria-pressed={density === d}
                onClick={() => setDensity(d)}>{d.toUpperCase()}</button>
            ))}
          </div>
          <button type="button" className={`btn btn-icon ${onlyWithFiles ? 'docwall-only-on' : ''}`} title={onlyWithFiles ? '显示全部节点' : '只看有产物的节点'}
            aria-label="只看有产物的节点" aria-pressed={onlyWithFiles} onClick={() => setOnlyWithFiles((v) => !v)}>◈</button>
          {model.runId && <a type="button" className="btn btn-icon" title="导出本次运行全部产物（zip）" aria-label="导出本次运行全部产物"
            href={apiUrl(`/runs/export?id=${encodeURIComponent(model.runId)}`)} download>⬇</a>}
          {onRefresh && <button type="button" className="btn btn-icon" title="刷新文稿" aria-label="刷新文稿" onClick={onRefresh}><RefreshCw size={14} /></button>}
        </div>

        {selected === 'finals' ? (
          <section className="docwall-strip" aria-label="成果">
            <header className="docwall-strip-head docwall-strip-head-final"><strong>◆ 成果</strong><span className="docwall-strip-meta">{model.finals.docs.length} 文档 · {model.finals.links.length} 链接</span></header>
            <div className="docwall-strip-cards">
              {model.finals.docs.map((doc) => {
                const entry = feedback.byArtifact.get(feedbackKey(doc));
                return <LazyMount key={doc.id}><DocCard doc={doc} onOpen={onOpen} fresh={freshIds.has(doc.id)}
                  onComment={setCommentDoc}
                  commentCount={entry?.comments.length || 0}
                  revisionCount={entry?.revisions.length || 0}
                  commenting={commentDoc && feedbackKey(commentDoc) === feedbackKey(doc)} /></LazyMount>;
              })}
              {model.finals.links.map((link) => (
                <a key={link.url} className="docwall-card docwall-card-link" href={link.url} target="_blank" rel="noreferrer">🔗 {link.label}</a>
              ))}
              {!model.finals.docs.length && !model.finals.links.length && <div className="docwall-strip-empty">本次运行没有 output 节点产物。</div>}
            </div>
          </section>
        ) : (
          visibleNodes.map((node) => (
            <NodeStrip key={node.nodeId} node={node} liveProgress={progressByNode[node.nodeId]} onOpen={onOpen}
              freshIds={freshIds}
              feedback={feedback}
              onComment={setCommentDoc}
              commentingKey={commentDoc ? feedbackKey(commentDoc) : ''}
              registerRef={(el) => stripRefs.current.set(node.nodeId, el)} />
          ))
        )}
        {selected === 'overview' && !visibleNodes.length && (
          <div className="docwall-strip-empty docwall-filter-empty">没有匹配的节点——试试清空搜索或切换类型过滤。</div>
        )}
      </div>
      {previewDoc && <PreviewExtra artifact={previewDoc} onClose={() => setPreviewDoc(null)} />}
      {commentDoc && <FeedbackDrawer doc={commentDoc} runId={model.runId} feedback={feedback} onClose={() => setCommentDoc(null)} />}
    </div>
    </FilesContext.Provider>
    </BulkContext.Provider>
  );
}

/* ---------- 预览弹窗辅助工具条：DocumentPreviewDialog 属 document-preview 插件不可扩展，
   在其后挂自己的小浮层——复制全文（md/txt/csv）与复制链接 ---------- */
function PreviewExtra({ artifact, onClose }) {
  const [copied, setCopied] = useState('');
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(''), 1600); } catch { /* 剪贴板不可用静默 */ }
  };
  const copyText = async () => {
    try {
      const res = await fetch(artifact.downloadUrl);
      if (!res.ok) throw new Error(String(res.status));
      await copy(await res.text(), '已复制全文');
    } catch { setCopied('复制失败'); setTimeout(() => setCopied(''), 1600); }
  };
  return <>
    <ArtifactPreviewModal artifact={artifact} onClose={onClose} />
    <div className="docwall-preview-extra">
      {['doc'].includes(artifact.kind) && <button type="button" className="btn btn-sm" onClick={copyText}>{copied === '已复制全文' ? '✓ 已复制全文' : '复制全文'}</button>}
      {artifact.previewUrl && <button type="button" className="btn btn-sm" onClick={() => copy(window.location.origin + artifact.previewUrl, '已复制链接')}>{copied === '已复制链接' ? '✓ 已复制链接' : '复制链接'}</button>}
      {copied && copied !== '已复制全文' && copied !== '已复制链接' && <span className="docwall-copy-err">{copied}</span>}
    </div>
  </>;
}
