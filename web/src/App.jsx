import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from '@xyflow/react';
import { apiUrl, setApiSessionId } from './api.js';
import {
  normalizeWorkflowDocument,
  serializeGraph,
  serializeWorkflowDocument,
  stripCanvasRuntimeNodeData,
} from './workflow-serialization.js';
import { eventBelongsToCanvas, eventBelongsToRun } from './run-event-routing.js';
import { useToast, PromptModal, ConfirmModal, Modal } from './ui.jsx';

const STATUS_CN = { running: '运行中', success: '成功', error: '失败', canceled: '已取消', interrupted: '异常中断', skipped: '跳过', waiting: '等待审批' };

import { FlowNode } from './FlowNode.jsx';
import { EdgeLine } from './EdgeLine.jsx';
import { NODE_REGISTRY, kindOf } from './registry.jsx';
import { AddNodeMenu, CanvasAddMenu, MoreMenu } from './ToolbarMenus.jsx';
import { NodePanel } from './NodePanel.jsx';
import { WorkflowList } from './WorkflowList.jsx';
import { RunHistory } from './RunHistory.jsx';
import { ResultPanel } from './ResultPanel.jsx';
import { FeishuCredModal } from './FeishuCredModal.jsx';
import { TestRunModal } from './TestRunModal.jsx';
import { NodeDetailModal } from './NodeDetailModal.jsx';
import { VariableCenter } from './VariableCenter.jsx';
import { TEMPLATES, TemplateModal } from './templates.jsx';

export default function App() {
  const toast = useToast();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [logOpen, setLogOpen] = useState(true);
  const [view, setView] = useState('canvas'); // 'canvas' | 'workflows'
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [currentWf, setCurrentWfRaw] = useState(null); // normalized workflow document, including id/name
  const [canvasScopeReady, setCanvasScopeReady] = useState(false);
  const currentWfIdRef = useRef(null); // SSE 监听器（只建一次）经 ref 读当前工作流 id
  const setCurrentWf = useCallback((wf) => {
    currentWfIdRef.current = wf?.id || null;
    setCurrentWfRaw(wf);
  }, []);
  const [runStatus, setRunStatus] = useState({ running: false, mode: '?', last: null, runId: null, done: 0, total: 0 });
  const [triggerInput, setTriggerInput] = useState('');
  const [runInputs] = useState({});
  const [eventsByRunId, setEventsByRunId] = useState({});
  const [runDetails, setRunDetails] = useState({});
  const [inspectedRunId, setInspectedRunId] = useState(null);
  const [resultsReadyByRunId, setResultsReadyByRunId] = useState({});
  const [hostSession, setHostSession] = useState({ id: null, canSaveToWorkspace: false });
  const terminalNodesByRunRef = useRef(new Map());
  const [canvasMenu, setCanvasMenu] = useState(null); // 双击画布 { x, y } 弹加节点菜单
  const [catalog, setCatalog] = useState({ tools: [], feishuEnabled: false });
  const [skills, setSkills] = useState([]);
  const [llmConfig, setLLMConfig] = useState({});
  const [runtime, setRuntime] = useState(null);
  const [lint, setLint] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [modal, setModal] = useState(null); // { type: 'confirm'|'prompt'|'rename', ... }
  const [progress, setProgress] = useState({}); // nodeId → { turns, preview }
  const [credOpen, setCredOpen] = useState(false);
  const [variableCenterOpen, setVariableCenterOpen] = useState(false);
  const [globalVariableEpoch, setGlobalVariableEpoch] = useState(0);
  const [larkStatus, setLarkStatus] = useState(null); // lark-cli 登录状态（⋯ 菜单入口数据源）
  const [focusLark, setFocusLark] = useState(false); // 从 ⋯ 打开设置时聚焦授权区
  const [testNode, setTestNode] = useState(null); // 试运行弹窗目标节点
  const [nodeDetail, setNodeDetail] = useState(null); // 日志行点击 → { runId, nodeId }
  // 断点续跑选择弹窗：待启动的图 + 可续跑的上次运行 + preview 返回的复用/重跑明细
  const [resumeChoice, setResumeChoice] = useState(null); // { lastRun, plan, startFresh, startResume }
  const [feishuCreds, setFeishuCreds] = useState([]);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const assistantOpsRef = useRef(null); // SSE assistant-patch → applyAssistantOps 桥（定义在后段）
  const assistantGraphRef = useRef(null); // 漏失 patch 时用服务端权威完整图恢复
  const assistantVersionRef = useRef(0);
  // 画布 AI 助手：本画布实例标识（localStorage 持久；宿主 dsh-ccpg-canvasui 经 postMessage 绑定）
  const canvasIdRef = useRef(localStorage.getItem('wf1:canvasId') || '');
  if (!canvasIdRef.current) {
    canvasIdRef.current = `cv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem('wf1:canvasId', canvasIdRef.current);
  }
  const hostSessionRef = useRef(null); // 宿主（官方 UI）注入的聊天 sessionId
  const reportCanvasTimer = useRef(null);
  const reportCanvasStateRef = useRef(null); // 定义在后段（依赖 toGraph），effect 里经 ref 调
  // 快捷键 handler 引用的操作经 ref 桥（定义在组件后段，避免闭包/顺序问题）
  const shortcutOpsRef = useRef({});
  const addChildNodeRef = useRef(null);
  // nodeTypes 引用稳定（React Flow 要求），onAddChild 经 ref 桥取最新实现
  const nodeTypes = useMemo(() => ({
    propertyNode: (props) => <FlowNode {...props} onAddChild={addChildNodeRef.current} />,
  }), []);
  // edgeTypes 引用稳定：自定义边（中点＋插入）
  // edgeTypes 引用稳定：自定义边（中点＋插入）；onInsert 由 styledEdges 的边 data 直接携带
  const edgeTypes = useMemo(() => ({
    insertable: EdgeLine,
  }), []);
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const runningRef = useRef(false);
  const activeRunIdRef = useRef(null);
  const workflowScopeEpochRef = useRef(0);
  const markDirty = useCallback(() => setDirty(true), []);
  // 撤销/重做栈：结构变更前快照 {nodes, edges}（引用当前不可变数组即可）
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const [undoInfo, setUndoInfo] = useState({ canUndo: false, canRedo: false });

  const snapshot = useCallback(() => {
    undoStack.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setUndoInfo({ canUndo: true, canRedo: false });
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setSelectedId(null);
    setSelectedEdgeId(null);
    markDirty();
    setUndoInfo({ canUndo: undoStack.current.length > 0, canRedo: true });
    toast('已撤销', 'info', 1400);
  }, [setNodes, setEdges, markDirty, toast]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedId(null);
    setSelectedEdgeId(null);
    markDirty();
    setUndoInfo({ canUndo: true, canRedo: redoStack.current.length > 0 });
    toast('已重做', 'info', 1400);
  }, [setNodes, setEdges, markDirty, toast]);

  // 初始加载：官方宿主注入 sessionId 后再读取工作区级数据。
  useEffect(() => {
    if (!hostSession.id) return undefined;
    (async () => {
      const g = await fetch(apiUrl('/graph')).then((r) => r.json()).catch(() => null);
      if (!g) return;
      let graphDoc = g;
      let bound = null;
      // 草稿图带绑定指针 → 恢复对应工作流（其文件内容为权威）；指针失效（工作流已删）则回退草稿并清指针。
      if (g.workflowId) {
        const res = await fetch(apiUrl(`/workflows/detail?id=${encodeURIComponent(g.workflowId)}`)).catch(() => null);
        if (res?.ok) {
          bound = normalizeWorkflowDocument(await res.json());
          graphDoc = bound.graph;
          setCurrentWf(bound);
        } else if (res?.status === 404) {
          fetch(apiUrl('/graph'), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodes: g.nodes, edges: g.edges }),
          }).catch(() => {});
        }
      }
      setNodes(graphDoc.nodes.map(toFlowNode));
      setEdges(graphDoc.edges.map(toFlowEdge));
      setCanvasScopeReady(true);
      // 图加载完成后补报 AI 助手（bind 若发生在加载前会拿到空图）。
      // 直接用加载到的 graphDoc 而非 toGraph()——setNodes 后 nodesRef 要到下一次渲染才刷新，
      // 同步读还是空图；graphDoc 就是画布此刻的真图。
      fetch(apiUrl('/assistant/canvas-state'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: canvasIdRef.current, graph: graphDoc, workflowId: bound?.id || null }),
      }).catch(() => {});
    })();
    (async () => {
      const j = (p) => fetch(apiUrl(p)).then((r) => r.json()).catch(() => null);
      // 并行拉取全部初始数据（原先逐条 await 串行，首屏时间被逐段叠加）
      const [catalogData, skillsData, llmData, runtimeData, credsData, larkData, runsData] = await Promise.all([
        j('/tools'), j('/skills'), j('/llm-config'), j('/runtime-config'), j('/feishu-credentials'), j('/lark-auth'), j('/runs'),
      ]);
      const graphData = await fetch(apiUrl('/graph')).then((r) => r.json()).catch(() => null);
      if (catalogData) setCatalog(catalogData);
      if (skillsData) setSkills(skillsData.skills || []);
      if (llmData) setLLMConfig(llmData);
      if (runtimeData) setRuntime(runtimeData.runtime || { available: false });
      if (credsData) setFeishuCreds(credsData.credentials || []);
      if (larkData) setLarkStatus(larkData.status || null);
      const latest = runsData?.runs?.[0];
      // 初次恢复也要按工作流对齐：草稿图带着 workflowId 时优先取该工作流的最近运行
      const draftWorkflowId = graphData?.workflowId;
      const aligned = draftWorkflowId
        ? (runsData?.runs || []).find((row) => row.workflowId === draftWorkflowId)
        : latest;
      if (aligned?.runId) {
        try {
          const response = await fetch(apiUrl(`/runs/detail?id=${encodeURIComponent(aligned.runId)}`));
          if (response.ok) {
            const detail = await response.json();
            setRunDetails((current) => ({ ...current, [aligned.runId]: detail }));
            if (!activeRunIdRef.current) {
              setInspectedRunId(aligned.runId);
              setRunStatus((current) => ({
                ...current,
                running: Boolean(aligned.live),
                runId: aligned.runId,
                last: aligned.status,
              }));
            }
          }
        } catch { /* 详情拉取失败不阻塞首屏 */ }
      }
    })();
  }, [hostSession.id, setNodes, setEdges]);

  // SSE：事件 → 节点状态 + 进度 + 结构化日志
  useEffect(() => {
    if (!canvasScopeReady) return undefined;
    const es = new EventSource(apiUrl('/events'));
    // 结构化运行事件：实时运行经 ref 路由，历史检查态不参与 SSE 过滤。
    const pushEntry = (entry) => {
      const timed = { t: Date.now(), ...entry };
      const runId = entry.runId || activeRunIdRef.current;
      if (runId) setEventsByRunId((current) => ({
        ...current,
        [runId]: [...(current[runId] || []).slice(-299), timed],
      }));
    };
    const appliesToActiveRun = (payload) => eventBelongsToRun(payload, activeRunIdRef.current);
    const belongsToCurrentCanvas = (payload) => eventBelongsToCanvas(payload, {
      canvasId: canvasIdRef.current,
      workflowId: currentWfIdRef.current,
    });
    const applyStatus = (p) => {
      if (!appliesToActiveRun(p)) return;
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== p.nodeId) return n;
          const data = { ...n.data, runStatus: p.status };
          if (p.status === 'running' && p.startedAt) data.runStartedAt = p.startedAt;
          if (p.status === 'success') { data.runChars = p.chars; data.runError = null; data.durationMs = p.durationMs; }
          if (p.turns != null) data.runTurns = p.turns;
          if (p.status === 'error' || p.status === 'canceled') data.runError = p.error;
          if (p.outputPreview != null) data.runOutput = p.outputPreview;
          if (p.hasTrace) data.hasTrace = true;
          if (p.model) data.runtimeModel = p.model;
          if (p.artifacts) { data.artifacts = p.artifacts; data.artifactsRunId = p.runId || null; }
          if (p.sessionId) data.sessionId = p.sessionId;
          return { ...n, data };
        })
      );
      if (p.status !== 'queued') {
        pushEntry({
          kind: 'node', status: p.status, nodeId: p.nodeId, runId: p.runId,
          nodeLabel: labelOf(nodesRef.current, p.nodeId).replace(/\(.*\)$/, ''),
          text: p.error ? p.error : undefined,
          meta: p.retrying ? `第 ${p.attempt} 次尝试` : p.toleratedError ? '失败后继续' : undefined,
          chars: p.chars, durationMs: p.durationMs,
        });
      }
      if (['success', 'error', 'canceled', 'skipped'].includes(p.status)) {
        const completed = terminalNodesByRunRef.current.get(p.runId) || new Set();
        completed.add(p.nodeId);
        terminalNodesByRunRef.current.set(p.runId, completed);
        setRunStatus((s) => (s.runId === p.runId ? { ...s, done: completed.size } : s));
      }
    };

    es.addEventListener('node-status', (e) => applyStatus(JSON.parse(e.data)));
    es.addEventListener('agent-progress', (e) => {
      const p = JSON.parse(e.data);
      if (!appliesToActiveRun(p)) return;
      setProgress((prev) => ({ ...prev, [p.nodeId]: p }));
      setNodes((nds) => nds.map((n) => (n.id === p.nodeId ? { ...n, data: { ...n.data, livePreview: p.preview, liveTurns: p.turns } } : n)));
      // 过程 tab 实时过程：运行中节点的轮次 + 输出预览随 SSE 进入时间线
      if (p.turns != null || p.preview) {
        pushEntry({
          kind: 'node', status: 'running', nodeId: p.nodeId, runId: p.runId,
          nodeLabel: labelOf(nodesRef.current, p.nodeId).replace(/\(.*\)$/, ''),
          turns: p.turns, preview: p.preview, live: true,
        });
      }
    });
    es.addEventListener('assistant-patch', (e) => {
      const p = JSON.parse(e.data);
      if (p.canvasId && p.canvasId !== canvasIdRef.current) return;
      // 旧工作流的在飞 patch：切换工作流瞬间版本闸门挡不住（cv.version 递增是合法的），
      // workflowId 必须严格对齐，草稿 null 与命名工作流也不能互相污染。
      if ((p.workflowId || null) !== (currentWfIdRef.current || null)) return;
      const version = Number(p.version) || 0;
      if (version && version <= assistantVersionRef.current) return;
      if (version && version !== assistantVersionRef.current + 1 && p.graph) {
        assistantGraphRef.current?.(p.graph, version, true);
        return;
      }
      assistantOpsRef.current?.(p.patch || [], version);
    });
    es.addEventListener('run-start', (e) => {
      const p = JSON.parse(e.data);
      if (!belongsToCurrentCanvas(p)) return;
      activeRunIdRef.current = p.runId;
      runningRef.current = true;
      terminalNodesByRunRef.current.set(p.runId, new Set());
      setInspectedRunId(p.runId);
      setRunStatus((s) => ({ ...s, running: true, runId: p.runId, done: 0, total: p.nodeIds.length }));
      pushEntry({ kind: 'run', runId: p.runId, status: 'start', text: `运行开始 · ${p.nodeIds.length} 个节点` });
    });
    es.addEventListener('run-end', (e) => {
      const p = JSON.parse(e.data);
      if (!appliesToActiveRun(p)) return;
      runningRef.current = false;
      setRunStatus((s) => (s.runId === p.runId ? { ...s, running: false, last: p.status } : s));
      pushEntry({ kind: 'run', runId: p.runId, status: p.status, text: `运行结束：${STATUS_CN[p.status] || p.status}${p.durationMs ? ` · ${(p.durationMs / 1000).toFixed(1)}s` : ''}` });
      const completedScopeEpoch = workflowScopeEpochRef.current;
      const hydrateRunDetail = async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
          const response = await fetch(apiUrl(`/runs/detail?id=${encodeURIComponent(p.runId)}`));
          if (!response.ok) continue;
          const detail = await response.json();
          setRunDetails((current) => ({ ...current, [p.runId]: detail }));
          if (workflowScopeEpochRef.current !== completedScopeEpoch) return;
          setNodes((nds) => nds.map((n) => {
            const output = detail.outputs?.[n.id];
            const structuredOutput = detail.structuredOutputs?.[n.id];
            if (output === undefined && structuredOutput === undefined) return n;
            return {
              ...n,
              data: {
                ...n.data,
                ...(output !== undefined ? { runOutput: String(output).slice(0, 4000), runChars: String(output).length } : {}),
                ...(structuredOutput !== undefined ? { runtimeStructuredOutput: structuredOutput } : {}),
                test: false,
              },
            };
          }));
          return;
        }
      };
      hydrateRunDetail().catch(() => {});
      if (p.status === 'success') toast('运行完成 ✓', 'success');
      else if (p.status === 'canceled') toast('运行已取消', 'warn');
      else toast('运行结束：有节点失败', 'error');
    });
    es.addEventListener('run-results-ready', (e) => {
      const p = JSON.parse(e.data);
      if (!appliesToActiveRun(p)) return;
      setResultsReadyByRunId((current) => ({ ...current, [p.runId]: Date.now() }));
      fetch(apiUrl(`/runs/detail?id=${encodeURIComponent(p.runId)}`))
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('成果尚未就绪')))
        .then((detail) => setRunDetails((current) => ({ ...current, [p.runId]: detail })))
        .catch(() => {});
    });
    es.addEventListener('run-persist-error', (e) => {
      const p = JSON.parse(e.data);
      if (!appliesToActiveRun(p)) return;
      pushEntry({ kind: 'sys', runId: p.runId, status: 'error', text: '成果保存失败，请稍后重试' });
      toast('成果保存失败，请稍后重试', 'error');
    });
    es.addEventListener('run-error', (e) => {
      const p = JSON.parse(e.data);
      const adopted = appliesToActiveRun(p);
      if (!adopted && !belongsToCurrentCanvas(p)) return;
      if (!adopted) activeRunIdRef.current = p.runId;
      runningRef.current = false;
      setRunStatus((s) => ({ ...s, running: false, runId: p.runId || s.runId, last: 'error' }));
      toast(`启动失败：${p.error}`, 'error');
      pushEntry({ kind: 'sys', runId: p.runId, status: 'error', text: p.error });
    });
    es.addEventListener('snapshot', (e) => {
      // 刷新恢复：节点状态 + 一组可点击的运行日志（否则刷新后日志面板会错误显示“尚未运行”）
      const p = JSON.parse(e.data);
      if (!belongsToCurrentCanvas(p)) return;
      activeRunIdRef.current = p.runId;
      setRunStatus((s) => ({
        ...s,
        runId: p.runId || s.runId,
        last: p.status === 'running' ? s.last : p.status,
      }));
      if (p.status === 'running') {
        runningRef.current = true;
        setRunStatus((s) => ({ ...s, running: true, runId: p.runId, mode: s.mode }));
      }
      const restored = [];
      for (const [nodeId, st] of Object.entries(p.nodeStates || {})) {
        setNodes((nds) => nds.map((n) => {
          if (n.id !== nodeId) return n;
          const data = { ...n.data, runStatus: st.status };
          if (st.status === 'running' && st.startedAt) data.runStartedAt = st.startedAt;
          if (st.chars != null) data.runChars = st.chars;
          if (st.turns != null) data.runTurns = st.turns;
          if (st.error) data.runError = st.error;
          if (st.durationMs != null) data.durationMs = st.durationMs;
          if (st.model) data.runtimeModel = st.model;
          if (st.artifacts) { data.artifacts = st.artifacts; data.artifactsRunId = p.runId || null; }
          if (st.sessionId) data.sessionId = st.sessionId;
          const out = (p.outputs || {})[nodeId];
          if (out != null) data.runOutput = String(out).slice(0, 4000);
          return { ...n, data };
        }));
        if (st.status !== 'queued') {
          restored.push({
            t: Date.now(), kind: 'node', runId: p.runId, nodeId,
            nodeLabel: labelOf(nodesRef.current, nodeId).replace(/\(.*\)$/, ''),
            status: st.status, text: st.error,
            chars: st.chars, durationMs: st.durationMs,
          });
        }
      }
      if (p.runId) {
        setInspectedRunId((current) => current || p.runId);
        setRunDetails((current) => ({ ...current, [p.runId]: { ...p, runId: p.runId } }));
      }
      if (restored.length && p.runId) {
        setEventsByRunId((current) => current[p.runId]?.length ? current : ({
          ...current,
          [p.runId]: [...restored, {
            t: Date.now(), kind: 'run', runId: p.runId, status: p.status,
            text: p.status === 'running' ? '运行已恢复' : `最近运行：${STATUS_CN[p.status] || p.status}`,
          }],
        }));
      }
    });
    return () => es.close();
  }, [canvasScopeReady, setNodes, toast]);

  // Esc 关闭面板；Cmd+S 保存；Cmd+Z 撤销 / Shift 重做；Delete 删除选中；Cmd+D 复制选中；F 定位错误
  const isTypingTarget = (e) => {
    const t = e.target;
    return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  };
  useEffect(() => {
    const onKey = (e) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (target?.closest('[data-template-editor], .cm-editor')) return;
      if (e.key === 'Escape') { setSelectedId(null); setSelectedEdgeId(null); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if (isTypingTarget(e)) return; // 以下快捷键在输入框中不劫持
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 选中判定：RF 的 n.selected（框选/多选）+ 当前打开面板的节点兜底
        const selIds = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
        if (selectedId) selIds.add(selectedId);
        if (selIds.size) {
          e.preventDefault();
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur(); // 面板输入框失焦，避免后续按键继续写进去
          shortcutOpsRef.current.deleteNodes([...selIds]);
          return;
        }
        const selEdge = edgesRef.current.find((ed) => ed.selected);
        if (selEdge) { e.preventDefault(); shortcutOpsRef.current.deleteEdge(selEdge.id); }
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        shortcutOpsRef.current.duplicateSelection();
      }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); shortcutOpsRef.current.focusFirstError(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toGraph = useCallback(() => serializeGraph(nodesRef.current, edgesRef.current), []);

  const doLint = useCallback(async (graph) => {
    try {
      const res = await fetch(apiUrl('/graph/lint'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: graph || toGraph() }),
      });
      const r = await res.json();
      setLint(r);
      return r;
    } catch { return { ok: true, issues: [] }; }
  }, [toGraph]);

  const save = useCallback(async ({ silent } = {}) => {
    const graph = toGraph();
    let response;
    let document = null;
    if (currentWf?.id) {
      document = serializeWorkflowDocument(currentWf, nodesRef.current, edgesRef.current);
      response = await fetch(apiUrl('/workflows'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(document),
      });
    } else {
      response = await fetch(apiUrl('/graph'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graph),
      });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error || `保存失败（HTTP ${response.status}）`;
      if (!silent) toast(message, 'error');
      throw new Error(message);
    }
    if (document) setCurrentWf({ ...document, updatedAt: data.updatedAt || document.updatedAt });
    setDirty(false);
    await doLint(graph);
    if (!silent) toast(currentWf ? `已保存「${currentWf.name}」` : '已保存草稿', 'success');
    return { graph, graphFingerprint: data.graphFingerprint || null };
  }, [toGraph, currentWf, toast, doLint]);

  // 自动保存：有改动 2.5s 静默保存；同一节流窗内同步画布状态给 AI 助手工具。
  // 注意依赖只有 dirty：save() 内部经 nodesRef/edgesRef 读最新图，若把 nodes/edges
  // 放进依赖，拖动时每个 pointermove 都会重置定时器，保存被无限推迟（饥饿）。
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      save({ silent: true })
        .then(() => reportCanvasStateRef.current?.())
        .catch((error) => toast(error?.message || '自动保存失败', 'error'));
    }, 2500);
    return () => clearTimeout(t);
  }, [dirty, save, toast]);

  // 离开页面前提醒未保存
  useEffect(() => {
    const h = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // 切换工作流时让运行面板跟随：显示该工作流最近一次运行（详情懒加载），没有则清空。
  // 不清 runDetails 缓存——切回来时历史详情直接命中。
  const syncRunPanelToWorkflow = useCallback((workflowId) => {
    fetch(apiUrl('/runs')).then((r) => r.json()).then((d) => {
      if ((currentWfIdRef.current || null) !== (workflowId || null)) return;
      const rows = d.runs || [];
      const latest = rows.find((row) => row.workflowId === workflowId);
      if (!latest) { setInspectedRunId(null); return; }
      setInspectedRunId(latest.runId);
      if (!latest.live) {
        fetch(apiUrl(`/runs/detail?id=${encodeURIComponent(latest.runId)}`))
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('运行记录不存在'))))
          .then((detail) => {
            if ((currentWfIdRef.current || null) !== (workflowId || null)) return;
            setRunDetails((current) => ({ ...current, [latest.runId]: detail }));
          })
          .catch(() => { /* 面板显示列表摘要兜底 */ });
      }
    }).catch(() => { /* 列表拉不到就维持现状 */ });
  }, []);

  const openWorkflow = useCallback(async (wf) => {
    const res = await fetch(apiUrl(`/workflows/detail?id=${encodeURIComponent(wf.id)}`));
    if (!res.ok) { toast(`打开失败：${wf.name}`, 'error'); return; }
    const data = normalizeWorkflowDocument(await res.json());
    workflowScopeEpochRef.current += 1;
    activeRunIdRef.current = null;
    runningRef.current = false;
    setNodes(data.graph.nodes.map(toFlowNode));
    setEdges(data.graph.edges.map(toFlowEdge));
    setCurrentWf(data);
    setRunStatus({ running: false, mode: '?', last: null, runId: null, done: 0, total: 0 });
    setProgress({});
    setSelectedId(null);
    setView('canvas');
    setDirty(false);
    // 镜像到草稿图并写入绑定指针：刷新/重开页面后仍恢复到该工作流。
    fetch(apiUrl('/graph'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: data.graph.nodes, edges: data.graph.edges, workflowId: data.id }),
    }).catch(() => {});
    // 运行面板跟随：切到哪条工作流就显示哪条的最近一次运行；没跑过则清空面板
    syncRunPanelToWorkflow(data.id);
    toast(`已打开「${data.name}」`);
  }, [setNodes, setEdges, toast, syncRunPanelToWorkflow]);

  const newWorkflow = useCallback((created) => {
    const document = normalizeWorkflowDocument(created);
    workflowScopeEpochRef.current += 1;
    activeRunIdRef.current = null;
    runningRef.current = false;
    setNodes(document.graph.nodes.map(toFlowNode));
    setEdges(document.graph.edges.map(toFlowEdge));
    setCurrentWf(document);
    setRunStatus({ running: false, mode: '?', last: null, runId: null, done: 0, total: 0 });
    setProgress({});
    setSelectedId(null);
    setView('canvas');
    setDirty(false);
    // 同 openWorkflow：镜像草稿图并写入绑定指针。
    fetch(apiUrl('/graph'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: document.graph.nodes, edges: document.graph.edges, workflowId: document.id }),
    }).catch(() => {});
    syncRunPanelToWorkflow(document.id);
    setTemplateOpen(true); // 空画布 → 弹模板库引导
  }, [setNodes, setEdges, syncRunPanelToWorkflow]);

  const applyTemplate = useCallback((tpl) => {
    snapshot();
    const idMap = new Map();
    const nodes = tpl.graph.nodes.map((n) => {
      const id = `n_${n.type}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      idMap.set(n.id, id);
      return toFlowNode({ id, type: n.type, position: n.position, data: { ...n.data } });
    });
    const edges = tpl.graph.edges.map((e, i) => toFlowEdge({ id: `e_${Date.now().toString(36)}_${i}`, source: idMap.get(e.source), target: idMap.get(e.target), branch: e.branch }));
    setNodes(nodes);
    setEdges(edges);
    setTemplateOpen(false);
    markDirty();
    toast(`已应用模板「${tpl.name}」`, 'success');
  }, [setNodes, setEdges, toast, markDirty, snapshot]);

  const resetGraph = useCallback(async () => {
    setModal({
      type: 'confirm',
      title: '重置为示例工作流',
      message: currentWf ? `将用示例图覆盖当前工作流「${currentWf.name}」，确定？` : '将用示例图覆盖当前草稿，确定？',
      confirmText: '重置',
      danger: true,
      onConfirm: async () => {
        setModal(null);
        snapshot();
        await fetch(apiUrl('/graph/reset'), { method: 'POST' });
        const g = await fetch(apiUrl('/graph')).then((r) => r.json());
        setNodes(g.nodes.map(toFlowNode));
        setEdges(g.edges.map(toFlowEdge));
        setDirty(false);
        toast('已重置为示例工作流', 'success');
      },
    });
  }, [setNodes, setEdges, currentWf, toast, snapshot]);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    const runScopeEpoch = workflowScopeEpochRef.current;
    const runWorkflowId = currentWfIdRef.current;
    const graph = toGraph();
    const check = await doLint(graph);
    if (!check.ok) {
      const bad = check.issues.find((i) => i.level === 'error');
      toast(`无法运行：${bad?.message || '图有错误'}`, 'error');
      return;
    }
    let saved;
    try {
      saved = await save({ silent: true });
    } catch (error) {
      toast(`无法运行：${error?.message || '保存失败'}`, 'error');
      return;
    }
    // 断点续跑：上次运行失败/取消且图未变时，让用户选重新跑还是接着跑
    const startFresh = () => {
      setProgress({});
      setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, runStatus: 'idle', runError: null, runOutput: undefined, runtimeStructuredOutput: undefined, livePreview: undefined, liveTurns: undefined, runTurns: undefined, runStartedAt: undefined } })));
      return fetch(apiUrl('/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graph: saved.graph,
          graphFingerprint: saved.graphFingerprint,
          triggerInput,
          runInputs,
          workflowId: runWorkflowId,
          workflowName: currentWf?.name,
          canvasId: canvasIdRef.current,
        }),
      })
        .then((res) => res.json().then((data) => ({ res, data })))
        .then(({ res, data }) => {
          if (!res.ok) { toast(`启动失败：${data.error}`, 'error'); return null; }
          return data.runId;
        })
        .catch(() => { toast('启动失败：网络错误', 'error'); return null; });
    };
    const startResume = async () => {
      const res = await fetch(apiUrl('/runs/resume'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: resumeCandidate.runId, canvasId: canvasIdRef.current }),
      });
      const data = await res.json();
      if (!res.ok) { toast(`续跑失败：${data.error}`, 'error'); return null; }
      return data.runId;
    };
    // 找上次可续跑运行：同工作流（或同草稿）、非 live、resumable
    let resumeCandidate = null;
    try {
      const listRes = await fetch(apiUrl('/runs'));
      if (listRes.ok) {
        const { runs = [] } = await listRes.json();
        const latestRun = runs.find((r) => (r.workflowId || null) === (runWorkflowId || null)) || null;
        resumeCandidate = latestRun?.resumable && !latestRun.live ? latestRun : null;
      }
    } catch { /* 历史不可读不阻塞正常运行 */ }
    let runId;
    if (resumeCandidate) {
      // 先问服务端这次能复用多少：明细随画布改动逐节点判定（不再要求全图一致）
      let plan = null;
      try {
        const previewRes = await fetch(apiUrl('/runs/resume'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: resumeCandidate.runId, canvasId: canvasIdRef.current, preview: true }),
        });
        if (previewRes.ok) plan = await previewRes.json();
      } catch { /* preview 失败按无明细处理，不阻塞选择 */
        plan = null;
      }
      if (plan && !plan.reusableNodes?.length) {
        // 画布改动覆盖了全部已完成节点的上游：无从复用，直接全新运行
        runId = await startFresh();
      } else {
        const choice = await new Promise((resolve) => {
          setResumeChoice({
            lastRun: resumeCandidate,
            plan,
            startFresh: () => resolve('fresh'),
            startResume: () => resolve('resume'),
          });
        });
        setResumeChoice(null);
        if (choice === 'resume') {
          // 保留画布上已完成节点的状态展示；只清未完成节点的错误残留
          setNodes((nds) => nds.map((n) => (['error', 'canceled', 'running'].includes(n.data?.runStatus)
            ? { ...n, data: { ...n.data, runStatus: 'idle', runError: null } }
            : n)));
          runId = await startResume();
          if (runId) {
            const reused = plan?.reusableNodes?.length ?? resumeCandidate.progress?.succeeded ?? '?';
            const rerunCount = plan?.rerunNodes?.length ?? 0;
            toast(rerunCount > 0
              ? `已续跑：复用 ${reused} 个已完成节点，${rerunCount} 个因画布修改将重跑`
              : `已续跑：复用上次 ${reused} 个已完成节点`, 'success');
          }
        } else {
          runId = await startFresh();
        }
      }
    } else {
      runId = await startFresh();
    }
    if (!runId) return;
    const stillCurrentScope = workflowScopeEpochRef.current === runScopeEpoch
      && currentWfIdRef.current === runWorkflowId;
    if (runId && stillCurrentScope) {
      activeRunIdRef.current = runId;
      runningRef.current = true;
      setInspectedRunId(runId);
      setRunStatus((current) => ({ ...current, running: true, runId, done: 0, total: graph.nodes.length }));
    }
  }, [save, setNodes, toGraph, triggerInput, runInputs, currentWf, toast, doLint]);

  const cancelRun = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const res = await fetch(apiUrl('/run/cancel'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
    const d = await res.json();
    if (d.ok) toast('已发送取消请求', 'warn');
  }, [toast]);

  // 单节点试运行
  const openTestNode = useCallback((node) => setTestNode(node), []);

  const onTestResult = useCallback((d) => {
    if (!d?.ok || !testNode) return;
    const output = String(d.output ?? '');
    setNodes((nds) => nds.map((n) => (n.id === testNode.id ? {
      ...n,
      data: {
        ...n.data,
        runStatus: 'success',
        runOutput: output.slice(0, 4000),
        runChars: output.length,
        runtimeStructuredOutput: d.structuredOutput,
        test: true,
      },
    } : n)));
  }, [testNode, setNodes]);

  const addNode = useCallback((type, position) => {
    const id = `n_${type}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const presets = Object.fromEntries(NODE_REGISTRY.map((k) => [k.type, k.preset()]));
    const pos = position || findFreeSpot(nodesRef.current);
    snapshot();
    setNodes((nds) => [...nds, toFlowNode({ id, type, position: pos, data: presets[type] })]);
    setSelectedId(id);
    markDirty();
    return id;
  }, [setNodes, markDirty, snapshot]);

  // 快捷加下游：hover 菜单触发。新节点放源节点右侧（多条出边时向下错开），自动连线
  const addChildNode = useCallback((sourceId, type) => {
    const src = nodesRef.current.find((n) => n.id === sourceId);
    if (!src) return;
    snapshot();
    const outCount = edgesRef.current.filter((e) => e.source === sourceId).length;
    const presets = Object.fromEntries(NODE_REGISTRY.map((k) => [k.type, k.preset()]));
    const id = `n_${type}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    setNodes((nds) => [...nds, toFlowNode({
      id, type,
      position: { x: src.position.x + 320, y: src.position.y + outCount * 130 },
      data: presets[type],
    })]);
    // 条件源节点：第一条出边 true、之后 true/false 交替补齐
    let branch;
    if (src.data.nodeType === 'condition') {
      const existing = edgesRef.current.filter((e) => e.source === sourceId);
      const hasTrue = existing.some((e) => (e.branch || e.data?.branch) === 'true');
      const hasFalse = existing.some((e) => (e.branch || e.data?.branch) === 'false');
      branch = !hasTrue ? 'true' : !hasFalse ? 'false' : 'true';
    }
    setEdges((eds) => [...eds, toFlowEdge({ id: `e_${Date.now().toString(36)}`, source: sourceId, target: id, branch })]);
    setSelectedId(id);
    markDirty();
  }, [setNodes, setEdges, snapshot, markDirty]);
  addChildNodeRef.current = addChildNode;

  // 面板编辑防抖入栈：第一次按键改动前压快照，1s 静默后视为一次编辑单元结束
  const panelEditTimer = useRef(null);
  const panelEditSnapshotTaken = useRef(false);
  const panelSnapshot = useCallback(() => {
    if (panelEditSnapshotTaken.current) return;
    panelEditSnapshotTaken.current = true;
    snapshot();
  }, [snapshot]);
  const panelEditCommit = useCallback(() => {
    clearTimeout(panelEditTimer.current);
    panelEditTimer.current = setTimeout(() => { panelEditSnapshotTaken.current = false; }, 1000);
  }, []);

  const updateNodeData = useCallback((id, patch) => {
    const current = nodesRef.current.find((node) => node.id === id)?.data;
    if (!current || Object.entries(patch).every(([key, value]) => Object.is(current[key], value))) return;

    // C 层改名联动：label 变更时同步更新所有下游模板里的 {{旧名}} / {{@旧名}}
    if (patch.label !== undefined) {
      setNodes((nds) => {
        const src = nds.find((n) => n.id === id);
        const oldLabel = src?.data?.label;
        const newLabel = patch.label;
        if (!oldLabel || oldLabel === newLabel || !newLabel) {
          return nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
        }
        const re = new RegExp(`\\{\\{\\s*(@?)${escapeRe(oldLabel)}\\s*\\}\\}`, 'g');
        let replaced = 0;
        const next = nds.map((n) => {
          if (n.id === id) return { ...n, data: { ...n.data, ...patch } };
          const d = n.data;
          let changed = false;
          const data = { ...d };
          for (const f of ['inputTemplate', 'text']) {
            if (typeof d[f] === 'string' && d[f].includes(oldLabel)) {
              data[f] = d[f].replace(re, (_m, at) => { replaced++; return `{{${at}${newLabel}}}`; });
              changed = true;
            }
          }
          return changed ? { ...n, data } : n;
        });
        if (replaced > 0) toast(`已同步更新 ${replaced} 处下游变量引用「${oldLabel}」→「${newLabel}」`, 'info', 3600);
        return next;
      });
      markDirty();
      return;
    }
    // 面板编辑纳入撤销栈（防抖成一次编辑单元）
    panelSnapshot();
    panelEditCommit();
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  }, [setNodes, markDirty, toast, panelSnapshot, panelEditCommit]);

  const deleteNode = useCallback((id) => {
    const n = nodesRef.current.find((x) => x.id === id);
    // C 层：查下游模板里对该节点名的引用，删除确认里警告
    const label = n?.data?.label || '';
    let refCount = 0;
    if (label) {
      const legacyRe = new RegExp(`\{\{\s*(@?)${escapeRe(label)}\s*\}\}`);
      const canonicalRe = new RegExp(`node\\[(["'])${escapeRe(id)}\\1\\]\\.data`);
      for (const other of nodesRef.current) {
        if (other.id === id) continue;
        for (const f of ['inputTemplate', 'text', 'prompt', 'note', 'url', 'headers', 'body']) {
          const template = other.data?.[f];
          if (typeof template === 'string' && (legacyRe.test(template) || canonicalRe.test(template))) refCount += 1;
        }
      }
    }
    setModal({
      type: 'confirm',
      title: '删除节点',
      message: `删除节点「${n?.data?.label || id}」及其连线？`
        + (refCount > 0 ? `\n\n⚠ 有 ${refCount} 个下游模板引用了 {{${label}}}，删除后这些变量将失效。` : ''),
      confirmText: '删除',
      danger: true,
      onConfirm: () => {
        setModal(null);
        snapshot();
        setNodes((nds) => nds.filter((n) => n.id !== id));
        setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
        if (selectedId === id) setSelectedId(null);
        markDirty();
        toast('节点已删除（Cmd+Z 撤销）', 'warn', 2600);
      },
    });
  }, [setNodes, setEdges, selectedId, markDirty, toast, snapshot]);

  const deleteEdge = useCallback((id) => {
    snapshot();
    setEdges((eds) => eds.filter((e) => e.id !== id));
    setSelectedEdgeId(null);
    markDirty();
  }, [setEdges, markDirty, snapshot]);

  // 批量删除（Delete 键 / 多选后删除）；note 节点不弹确认
  const deleteNodes = useCallback((ids) => {
    const set = new Set(ids);
    const targets = nodesRef.current.filter((n) => set.has(n.id));
    if (!targets.length) return;
    if (targets.length === 1 && targets[0].data.nodeType !== 'note') { deleteNode(targets[0].id); return; }
    if (targets.every((n) => n.data.nodeType === 'note')) {
      // 纯注释：静默删除
      snapshot();
      setNodes((nds) => nds.filter((n) => !set.has(n.id)));
      setEdges((eds) => eds.filter((e) => !set.has(e.source) && !set.has(e.target)));
      setSelectedId(null);
      markDirty();
      toast('注释已删除（Cmd+Z 撤销）', 'info', 2200);
      return;
    }
    const hasNote = targets.some((n) => n.data.nodeType === 'note');
    setModal({
      type: 'confirm',
      title: `删除 ${targets.length} 个节点`,
      message: `删除所选 ${targets.length} 个节点及其连线？${hasNote ? '（含注释节点）' : ''}`,
      confirmText: '删除',
      danger: true,
      onConfirm: () => {
        setModal(null);
        snapshot();
        setNodes((nds) => nds.filter((n) => !set.has(n.id)));
        setEdges((eds) => eds.filter((e) => !set.has(e.source) && !set.has(e.target)));
        setSelectedId(null);
        markDirty();
        toast(`已删除 ${targets.length} 个节点（Cmd+Z 撤销）`, 'warn', 2600);
      },
    });
  }, [setNodes, setEdges, markDirty, toast, snapshot, deleteNode]);

  // Cmd+D 复制选中节点（偏移放置，注释节点也支持）
  const duplicateSelection = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected || n.id === selectedId);
    if (!sel.length) { toast('先选中一个节点再复制', 'info', 1800); return; }
    snapshot();
    const idMap = new Map();
    const now = Date.now().toString(36);
    const copies = sel.map((n, i) => {
      const id = `n_${n.data.nodeType}_${now}${Math.random().toString(36).slice(2, 5)}`;
      idMap.set(n.id, id);
      return {
        ...n,
        id,
        selected: false,
        position: { x: n.position.x + 60, y: n.position.y + 60 + i * 24 },
        data: { ...n.data, label: `${n.data.label || n.id} 副本`, runStatus: 'idle', runOutput: undefined, runError: null, livePreview: undefined },
      };
    });
    const innerEdges = edgesRef.current
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e, i) => ({ ...e, id: `e_${now}_dup${i}`, source: idMap.get(e.source), target: idMap.get(e.target), selected: false }));
    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...copies]);
    setEdges((eds) => [...eds, ...innerEdges]);
    markDirty();
    toast(`已复制 ${copies.length} 个节点${innerEdges.length ? `（含 ${innerEdges.length} 条内部连线）` : ''}`, 'success', 2200);
  }, [selectedId, setNodes, setEdges, markDirty, toast, snapshot]);

  // F 键 / lint 点击：定位第一个错误节点（视口居中 + 选中打开面板）
  const focusNode = useCallback((nodeId) => {
    const n = nodesRef.current.find((x) => x.id === nodeId);
    if (!n) return;
    setSelectedId(nodeId);
    setSelectedEdgeId(null);
    fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 3 });
  }, [fitView]);
  const focusFirstError = useCallback(() => {
    const bad = nodesRef.current.find((n) => n.data.runStatus === 'error' && n.data.nodeType !== 'note')
      || (lint?.issues || []).map((i) => nodesRef.current.find((n) => n.id === i.nodeId && n.data.nodeType !== 'note')).find(Boolean);
    if (!bad) { toast('当前没有错误节点', 'info', 1600); return; }
    focusNode(bad.id);
    toast(`已定位：${bad.data.label || bad.id}`, 'info', 2200);
  }, [lint, focusNode, toast]);

  // 快捷键 ref 桥：每次渲染同步最新实现
  shortcutOpsRef.current = { deleteNodes, duplicateSelection, focusFirstError, deleteEdge };

  const onConnect = useCallback((params) => {
    if (params.source === params.target) return;
    const eds = edgesRef.current;
    if (eds.some((e) => e.source === params.source && e.target === params.target)) return;
    // 防环：从 target 深搜能否回到 source
    const adj = new Map();
    for (const e of eds) { if (!adj.has(e.source)) adj.set(e.source, []); adj.get(e.source).push(e.target); }
    const stack = [params.target];
    const seen = new Set();
    let cyclic = false;
    while (stack.length) {
      const id = stack.pop();
      if (id === params.source) { cyclic = true; break; }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(adj.get(id) || []));
    }
    if (cyclic) { toast('连接被拒绝：会形成环', 'error'); return; }
    snapshot();
    // 条件节点第二条出边自动标 false 分支
    const srcNode = nodesRef.current.find((n) => n.id === params.source);
    let branch;
    if (srcNode?.data.nodeType === 'condition') {
      const existing = eds.filter((e) => e.source === params.source);
      branch = existing.length === 0 ? 'true' : existing.every((e) => (e.branch || e.data?.branch) === 'true') ? 'false' : 'true';
    }
    setEdges(() => {
      const added = addEdge({ ...params, id: `e_${Date.now().toString(36)}` }, eds);
      return added.map((e) => (e.source === params.source && e.target === params.target && branch && !e.branch ? { ...e, branch } : e));
    });
    markDirty();
  }, [setEdges, toast, markDirty, snapshot]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);

  // ---- 画布 AI 助手桥（官方 UI「工作流」tab 内嵌本画布）----
  // 画布状态上报（节流 1.2s）：携带已确认版本；服务端若发现这是旧图，返回权威图纠正。
  const reportCanvasState = useCallback((immediate) => {
    const send = () => fetch(apiUrl('/assistant/canvas-state'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId: canvasIdRef.current, version: assistantVersionRef.current, graph: toGraph(), workflowId: currentWf?.id || null }),
    }).then((r) => r.json()).then((d) => {
      if (d?.applied === false && d.graph && Number(d.version) > assistantVersionRef.current) {
        assistantGraphRef.current?.(d.graph, Number(d.version), true);
      }
    }).catch(() => {});
    if (immediate) { clearTimeout(reportCanvasTimer.current); send(); return; }
    clearTimeout(reportCanvasTimer.current);
    reportCanvasTimer.current = setTimeout(send, 1200);
  }, [toGraph, currentWf]);
  reportCanvasStateRef.current = reportCanvasState;

  // 显式契约：当前工作流一变（打开/新建/切换），立刻把新图 + workflowId 上报助手服务端，
  // 让对话侧 canvas_* 工具同步指向最新工作流。此前依赖 reportCanvasState 身份变化触发
  // 嵌入 effect 重跑——是隐式耦合，调整任意一侧 hook 依赖都会无声断掉。
  useEffect(() => {
    reportCanvasStateRef.current?.(true);
  }, [currentWf?.id]);

  // SSE 漏包/重连恢复：以服务端权威完整图替换当前画布。
  const applyAssistantGraph = useCallback((graph, version, notify = false) => {
    if (!graph?.nodes || Number(version) <= assistantVersionRef.current) return;
    snapshot();
    assistantVersionRef.current = Number(version);
    setNodes(graph.nodes.map(toFlowNode));
    setEdges((graph.edges || []).map(toFlowEdge));
    setSelectedId(null);
    setSelectedEdgeId(null);
    markDirty();
    setTimeout(() => fitView({ duration: 350, padding: 0.2 }), 100);
    if (notify) toast('已同步 AI 最新画布', 'success', 2600);
  }, [setNodes, setEdges, snapshot, markDirty, fitView, toast]);
  assistantGraphRef.current = applyAssistantGraph;

  // AI 补丁 → 画布落图：一批 ops 一次快照（一次 Cmd+Z 撤销整批）
  const applyAssistantOps = useCallback((ops, version = 0) => {
    const presets = Object.fromEntries(NODE_REGISTRY.map((k) => [k.type, k.preset()]));
    snapshot();
    if (version) assistantVersionRef.current = Number(version);
    let lastAdded = null;
    for (const op of ops || []) {
      if (op.op === 'addNode') {
        setNodes((nds) => [...nds, toFlowNode({ id: op.id, type: op.type, position: op.position, data: { ...presets[op.type], ...(op.data || {}) } })]);
        lastAdded = op.id;
      } else if (op.op === 'updateNode') {
        setNodes((nds) => nds.map((n) => (n.id === op.id ? { ...n, data: { ...n.data, ...op.data } } : n)));
      } else if (op.op === 'deleteNode') {
        setNodes((nds) => nds.filter((n) => n.id !== op.id));
        setEdges((eds) => eds.filter((e) => e.source !== op.id && e.target !== op.id));
      } else if (op.op === 'connect') {
        setEdges((eds) => [...eds, toFlowEdge({ id: op.id, source: op.from, target: op.to, branch: op.branch })]);
      } else if (op.op === 'deleteEdge') {
        setEdges((eds) => eds.filter((e) => e.id !== op.id));
      } else if (op.op === 'updateEdge') {
        setEdges((eds) => eds.map((e) => (e.id === op.id ? { ...e, branch: op.branch } : e)));
      }
    }
    markDirty();
    if (lastAdded) {
      setSelectedId(lastAdded);
      setTimeout(() => fitView({ nodes: [{ id: lastAdded }], duration: 400, padding: 3 }), 120);
    }
    toast('✨ AI 已修改画布（Cmd+Z 可撤销）', 'success', 3200);
    // 落图后立即上报（不等节流），AI 的下一次校验拿到的一定是新图
    setTimeout(() => reportCanvasState(true), 250);
  }, [setNodes, setEdges, snapshot, markDirty, toast, fitView, reportCanvasState]);
  assistantOpsRef.current = applyAssistantOps;

  // 宿主 postMessage：wf1-session（官方 UI 会话绑定）→ 绑定 + 拿 persona
  useEffect(() => {
    const onMessage = (ev) => {
      if (ev.origin !== window.location.origin) return;
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'wf1-session' && d.sessionId) {
        hostSessionRef.current = d.sessionId;
        setApiSessionId(d.sessionId);
        setHostSession({ id: d.sessionId, canSaveToWorkspace: false });
        fetch(apiUrl('/assistant/bind'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: d.sessionId, canvasId: canvasIdRef.current, version: assistantVersionRef.current, graph: toGraph(), workflowId: currentWf?.id || null }),
        }).then((r) => r.json()).then((result) => {
          setHostSession({ id: d.sessionId, canSaveToWorkspace: result?.canSaveToWorkspace === true });
          if (result?.graph && Number(result.version) > assistantVersionRef.current) {
            assistantGraphRef.current?.(result.graph, Number(result.version), true);
          }
        }).catch(() => {});
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [toGraph, currentWf]);

  // 被嵌入官方 UI 时：加载即上报 ready + 初始图；定时补拉权威版本，恢复 SSE 漏包。
  const embedded = window.parent !== window;
  useEffect(() => {
    if (!embedded) return;
    try { window.parent.postMessage({ type: 'wf1-ready' }, window.location.origin); } catch { /* 宿主未监听 */ }
    // 宿主按 wf1-ready 重发 sessionId（画布内刷新按钮 reload 后的身份重建）；
    // 保险起见稍等后仍未收到则再要一次（宿主 ready 标记已 true 的窗口期）。
    const reRequest = setTimeout(() => {
      if (!hostSessionRef.current) {
        try { window.parent.postMessage({ type: 'wf1-ready' }, window.location.origin); } catch { /* 宿主未监听 */ }
      }
    }, 600);
    reportCanvasState(true);
    let stopped = false;
    const sync = () => fetch(apiUrl(`/assistant/canvas-state?canvasId=${encodeURIComponent(canvasIdRef.current)}`))
      .then((r) => r.json())
      .then((d) => {
        if (!stopped && d?.graph && Number(d.version) > assistantVersionRef.current) {
          assistantGraphRef.current?.(d.graph, Number(d.version), true);
        }
      })
      .catch(() => {});
    const timer = setInterval(sync, 2000);
    sync();
    return () => { stopped = true; clearInterval(timer); clearTimeout(reRequest); };
  }, [embedded, reportCanvasState]);

  const workflowVariables = currentWf?.variables;
  const inputSchema = currentWf?.inputSchema;
  const selectedEdge = useMemo(() => edges.find((e) => e.id === selectedEdgeId) || null, [edges, selectedEdgeId]);
  const selectedSourceNode = useMemo(() => (selectedEdge ? nodes.find((n) => n.id === selectedEdge.source) : null), [selectedEdge, nodes]);

  // 连线中点插入：删原边，新节点放线中点，source→新→target；条件分支标签保留到 source→新 边
  const insertNodeOnEdge = useCallback((edgeId, type) => {
    const edge = edgesRef.current.find((e) => e.id === edgeId);
    if (!edge) return;
    const src = nodesRef.current.find((n) => n.id === edge.source);
    const dst = nodesRef.current.find((n) => n.id === edge.target);
    if (!src || !dst) return;
    snapshot();
    const presets = Object.fromEntries(NODE_REGISTRY.map((k) => [k.type, k.preset()]));
    const id = `n_${type}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const mid = {
      x: Math.round((src.position.x + dst.position.x) / 2) + 24,
      y: Math.round((src.position.y + dst.position.y) / 2) + 18,
    };
    setNodes((nds) => [...nds, toFlowNode({ id, type, position: mid, data: presets[type] })]);
    const now = Date.now().toString(36);
    const branch = edge.branch || edge.data?.branch;
    setEdges((eds) => [
      ...eds.filter((e) => e.id !== edgeId),
      toFlowEdge({ id: `e_${now}a`, source: edge.source, target: id, branch }),
      toFlowEdge({ id: `e_${now}b`, source: id, target: edge.target }),
    ]);
    setSelectedId(id);
    markDirty();
    toast(`已在连线间插入「${NODE_REGISTRY.find((k) => k.type === type)?.label || type}」节点`, 'success', 2400);
  }, [setNodes, setEdges, snapshot, markDirty, toast]);

  // 边样式：状态着色 + 条件分支标签；走自定义 EdgeLine（中点＋插入），样式透传。
  // 拆两层 memo：状态映射只依赖节点的【运行状态】序列（拖动/改数据不重建边），
  // 布局变化才重建边对象——styledEdges 随 [edges, statusKey, insertNodeOnEdge] 重建。
  const edgeStatusKey = useMemo(
    () => nodes.map((n) => `${n.id}:${n.data?.runStatus || 'idle'}`).join('|'),
    [nodes],
  );
  const styledEdges = useMemo(() => {
    const statusOf = new Map();
    for (const part of edgeStatusKey.split('|')) {
      const [id, st] = part.split(':');
      statusOf.set(id, st);
    }
    const EDGE_COLOR = { success: '#10b981', running: '#f59e0b', error: '#ef4444', skipped: '#9ca3af', canceled: '#94a3b8' };
    return edges.map((e) => {
      const src = statusOf.get(e.source) || 'idle';
      const color = EDGE_COLOR[src] || '#94a3b8';
      const active = src === 'success' || src === 'running';
      const branch = e.branch || e.data?.branch;
      return {
        ...e,
        type: 'insertable',
        // onInsert 直接注入边 data：styledEdges 随 [edges,statusKey] 重建，insertNodeOnEdge 引用稳定
        data: { onInsert: insertNodeOnEdge, branch },
        label: branch ? (branch === 'true' ? '是' : '否') : undefined,
        labelStyle: { fill: '#A8A29E', fontSize: 11 },
        labelBgStyle: { fill: '#1D1A16' },
        animated: src === 'running',
        style: { stroke: color, strokeWidth: active ? 2.5 : 1.5, strokeDasharray: branch === 'false' ? '6 3' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      };
    });
  }, [edges, edgeStatusKey, insertNodeOnEdge]);

  const upstreamNodes = useMemo(() => {
    if (!selectedNode) return [];
    return edges
      .filter((e) => e.target === selectedNode.id)
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter(Boolean)
      .map((n) => ({
        id: n.id,
        label: n.data.label || n.id,
        output: previewOutputForNode(n),
        structuredOutput: previewStructuredOutputForNode(n),
        nodeState: n.data.runStatus ? {
          status: previewStatusForNode(n),
          chars: n.data.runChars,
          durationMs: n.data.durationMs,
          model: n.data.runtimeModel,
        } : undefined,
      }));
  }, [edges, nodes, selectedNode]);

  const upstreamNodesOf = (id) => upstreamNodesOfFactory(edges, nodes)(id);
  const previewsOf = (id) => {
    const out = {};
    for (const u of upstreamNodesOf(id)) {
      const n = nodes.find((x) => x.id === u.id);
      const preview = previewOutputForNode(n);
      if (preview !== undefined) {
        out[u.id] = preview;
        out[u.label] = preview;
      }
    }
    return out;
  };

  // 上游变量预览：各上游节点最近一次运行的输出（B 层数据源）
  const upstreamPreviews = useMemo(() => {
    const out = {};
    for (const u of upstreamNodes) {
      const n = nodes.find((x) => x.id === u.id);
      const preview = previewOutputForNode(n);
      if (preview !== undefined) {
        out[u.id] = preview;
        out[u.label] = preview;
      }
    }
    return out;
  }, [upstreamNodes, nodes]);

  const doneCount = useMemo(() => nodes.filter((n) => ['success', 'error', 'skipped', 'canceled'].includes(n.data.runStatus)).length, [nodes]);

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="toolbar-brand">Workflow One</strong>
        <nav className="view-tabs">
          <button className={`view-tab ${view === 'canvas' ? 'view-tab-on' : ''}`} onClick={() => setView('canvas')}>画布</button>
          <button className={`view-tab ${view === 'workflows' ? 'view-tab-on' : ''}`} onClick={() => setView('workflows')}>工作流</button>
          <button className={`view-tab ${historyOpen ? 'view-tab-on' : ''}`} onClick={() => setHistoryOpen(true)}>历史</button>
        </nav>
        {view === 'canvas' && currentWf && <span className="mode-badge toolbar-workflow-badge" title={`当前编辑的工作流：${currentWf.name}`}>{currentWf.name}{dirty ? ' •' : ''}</span>}
        {runtime && (
          <span className={`mode-badge toolbar-runtime-badge ${runtime.available ? 'mode-glm' : ''}`} title={runtime.available ? 'agent 节点默认由 dsh (DeepSeek Harness) 驱动' : (runtime.reasons || []).join('；')}>
            {runtime.available ? '⚡ dsh 底座' : '内置循环（dsh 不可用）'}
          </span>
        )}
        <div className="toolbar-spacer" />
        {view === 'canvas' && (
          <>
            {runStatus.running && <span className="mode-badge mode-glm toolbar-progress-badge">{doneCount}/{runStatus.total || nodes.length} 节点</span>}
            <button className="btn tb-refresh-btn toolbar-compact-hide" onClick={() => window.location.reload()} title="重新加载当前画布" aria-label="刷新画布"><span aria-hidden="true">⟳</span> 刷新</button>
            <AddNodeMenu onPick={(type) => addNode(type)} />
            <button className="btn tb-icon-btn toolbar-compact-hide" onClick={undo} disabled={!undoInfo.canUndo} title="撤销（Cmd+Z）" aria-label="撤销">↩</button>
            <button className="btn tb-icon-btn toolbar-compact-hide" onClick={redo} disabled={!undoInfo.canRedo} title="重做（Cmd+Shift+Z）" aria-label="重做">↪</button>
            <button className="btn tb-icon-btn" onClick={save} title={dirty ? '保存（Cmd+S）· 有未保存改动' : '保存（Cmd+S）'} aria-label="保存">
              <span className={dirty ? 'save-dot' : ''}>💾</span>
            </button>
            <MoreMenu items={[
              { key: 'refresh', icon: '⟳', label: '刷新画布', compactOnly: true, onClick: () => window.location.reload() },
              { key: 'undo', icon: '↩', label: '撤销', hint: 'Cmd+Z', compactOnly: true, disabled: !undoInfo.canUndo, onClick: undo },
              { key: 'redo', icon: '↪', label: '重做', hint: 'Cmd+Shift+Z', compactOnly: true, disabled: !undoInfo.canRedo, onClick: redo },
              larkStatus?.installed ? { key: 'lark', icon: '◈', label: larkStatus.user?.tokenStatus === 'valid' ? `飞书已登录：${larkStatus.user.userName}` : '飞书登录 / 设置', onClick: () => { setFocusLark(true); setCredOpen(true); } } : null,
              { key: 'variables', icon: '⌘', label: '变量与输入', hint: '实例变量 / 工作流变量 / 运行输入', onClick: () => setVariableCenterOpen(true) },
              { key: 'settings', icon: '⚙', label: '设置', hint: '凭据 / 飞书', onClick: () => setCredOpen(true) },
              { key: 'templates', icon: '▤', label: '模板库', onClick: () => setTemplateOpen(true) },
              { key: 'reset', icon: '⟲', label: '重置为示例', danger: true, onClick: resetGraph },
            ]} />
            {runStatus.running ? (
              <button className="btn btn-danger tb-run-btn" onClick={cancelRun} aria-label="取消运行"><span aria-hidden="true">■</span><span className="tb-run-label">取消</span></button>
            ) : (
              <button className="btn btn-primary tb-run-btn" onClick={run} aria-label="运行工作流"><span aria-hidden="true">▶</span><span className="tb-run-label">运行</span></button>
            )}
          </>
        )}
        {runStatus.last && <span className="run-last">上次: {runStatus.last}</span>}
      </header>

      <div className="main">
        {view === 'workflows' ? (
          <div className="wf-view">
            <WorkflowList currentId={currentWf?.id} onOpen={openWorkflow} onNew={newWorkflow} />
          </div>
        ) : (
          <>
        <div
          className="canvas-wrap"
          onDoubleClick={(e) => {
            // 双击画布空白（pane 本体，非节点/句柄/控件）在光标处弹加节点菜单
            const t = e.target;
            if (t.classList?.contains('react-flow__pane') || t.classList?.contains('react-flow__background')) {
              setCanvasMenu({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={styledEdges}
            onNodesChange={(chg) => { onNodesChange(chg); if (chg.some((c) => c.type === 'position' || c.type === 'remove')) markDirty(); }}
            onEdgesChange={(chg) => { onEdgesChange(chg); if (chg.some((c) => c.type === 'remove')) markDirty(); }}
            onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedId(n.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, e) => { setSelectedEdgeId(e.id); setSelectedId(null); }}
            onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); setCanvasMenu(null); }}
            zoomOnDoubleClick={false}
            onPaneContextMenu={(e) => {
              e.preventDefault();
              setCanvasMenu({ x: e.clientX, y: e.clientY });
            }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            selectionOnDrag={false}
            panOnDrag
            multiSelectionKeyCode={['Meta', 'Shift']}
            selectionKeyCode="Shift"
            deleteKeyCode={null}
            snapToGrid
            snapGrid={[20, 20]}
            fitView
            minZoom={0.15}
            maxZoom={2.5}
            connectionLineStyle={{ stroke: '#94a3b8', strokeWidth: 2 }}
          >
            <Background variant="dots" gap={22} size={1.4} color="#3A352E" />
            <Controls />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => ({ agent: '#8B5CF6', input: '#38BDF8', script: '#F97316', condition: '#F59E0B', http: '#34D399', output: '#A3E635', note: '#78716C' })[n.data?.nodeType] || '#57534E'}
              maskColor="rgba(20,18,15,0.7)"
            />
          </ReactFlow>
          {lint?.issues?.length > 0 && (
            <div className="lint-bar">
              <strong>图检查（{lint.issues.length}）</strong>
              {lint.issues.slice(0, 4).map((i, idx) => (
                <button key={idx} className={`lint-item ${i.level === 'error' ? 'lint-error' : 'lint-warn'}`}
                  onClick={() => i.nodeId && focusNode(i.nodeId)}
                  title={i.nodeId ? '点击定位到该节点' : undefined}>
                  {i.level === 'error' ? '✗' : '⚠'} {i.message}
                </button>
              ))}
              {lint.issues.length > 4 && <span className="sec-hint">…还有 {lint.issues.length - 4} 条</span>}
            </div>
          )}
        </div>

        {selectedNode ? (
          <NodePanel
            node={selectedNode}
            onChange={updateNodeData}
            onDelete={deleteNode}
            onTest={openTestNode}
            onClose={() => setSelectedId(null)}
            availableTools={catalog.tools}
            skills={skills}
            feishuEnabled={catalog.feishuEnabled}
            feishuCreds={feishuCreds}
            llmConfig={llmConfig}
            upstreamNodes={upstreamNodes}
            upstreamPreviews={upstreamPreviews}
            graph={toGraph()}
            workflowId={currentWf?.id}
            runId={runStatus.runId}
            workflowVariables={workflowVariables}
            inputSchema={inputSchema}
            runInputs={runInputs}
            triggerInput={triggerInput}
            globalVariableEpoch={globalVariableEpoch}
            progress={progress[selectedNode.id]}
          />
        ) : null}

        {selectedEdge && (
          <aside className="panel node-panel">
            <header className="node-panel-head">
              <span className="type-chip type-edge">连线</span>
              <span className="title-input">{selectedSourceNode?.data?.label || selectedEdge.source} → {nodes.find((n) => n.id === selectedEdge.target)?.data?.label || selectedEdge.target}</span>
              <button className="btn-icon" title="删除连线" onClick={() => deleteEdge(selectedEdge.id)}>🗑</button>
            </header>
            {selectedSourceNode?.data.nodeType === 'condition' ? (
              <section className="panel-sec">
                <h4>分支 <span className="sec-hint">条件节点命中哪侧走这条边</span></h4>
                <div className="tool-chips">
                  {[['true', '命中（是）'], ['false', '未命中（否）']].map(([v, label]) => (
                    <button key={v} className={`chip ${(selectedEdge.branch || selectedEdge.data?.branch) === v ? 'chip-on' : ''}`}
                      onClick={() => updateEdgeBranch(selectedEdge.id, v)}>{label}</button>
                  ))}
                </div>
              </section>
            ) : (
              <section className="panel-sec"><p className="sec-hint">普通数据流连线。点击画布空白处关闭。</p></section>
            )}
          </aside>
        )}

        <div className={`result-panel-shell ${logOpen ? '' : 'panel-collapsed'}`}>
          <button className="btn btn-sm panel-toggle" onClick={() => setLogOpen((v) => !v)}
            aria-label={logOpen ? '收起成果面板' : '展开成果面板'}>
            {logOpen ? '▶ 收起' : '◀ 展开'}
          </button>
          {logOpen && <ResultPanel
            runDetail={runDetails[inspectedRunId]}
            events={eventsByRunId[inspectedRunId] || []}
            status={inspectedRunId === runStatus.runId ? runStatus : runDetails[inspectedRunId]}
            sessionId={hostSession.id}
            canSaveToWorkspace={hostSession.canSaveToWorkspace}
            resultsReadyToken={resultsReadyByRunId[inspectedRunId] || 0}
            triggerInput={triggerInput}
            onTriggerChange={setTriggerInput}
            onOpenHistory={() => setHistoryOpen(true)}
            onClose={() => setLogOpen(false)}
            onFocusNode={focusNode}
            onOpenNodeDetail={(runId, nodeId) => setNodeDetail({ runId, nodeId })}
          />}
        </div>
          </>
        )}
      </div>

      {canvasMenu && (
        <CanvasAddMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          onPick={(type) => {
            // 菜单位置 → 画布坐标，节点落在双击处
            const pos = screenToFlowPosition({ x: canvasMenu.x, y: canvasMenu.y });
            addNode(type, pos);
          }}
          onClose={() => setCanvasMenu(null)}
        />
      )}
      {resumeChoice && (
        <Modal
          title="检测到未完成的运行"
          onClose={() => { resumeChoice.startFresh(); }}
          footer={(
            <>
              <button className="btn" onClick={resumeChoice.startFresh}>重新运行</button>
              <button className="btn btn-primary" onClick={resumeChoice.startResume}>从上次继续</button>
            </>
          )}
        >
          <p className="panel-note" style={{ marginBottom: 8 }}>
            上次运行（{new Date(resumeChoice.lastRun.startedAt).toLocaleString('zh-CN', { hour12: false })}）
            {resumeChoice.lastRun.status === 'interrupted' ? '异常中断' : resumeChoice.lastRun.status === 'error' ? '失败' : '被取消'}，
            已完成 <strong>{resumeChoice.lastRun.progress?.succeeded ?? '?'}/{resumeChoice.lastRun.progress?.total ?? '?'}</strong> 个节点。
          </p>
          {resumeChoice.plan ? (
            <>
              <p className="sec-hint">
                「从上次继续」将复用 {resumeChoice.plan.reusableNodes.length} 个已完成节点的输出
                {resumeChoice.plan.rerunNodes.length > 0 && (
                  <>；<strong>{resumeChoice.plan.rerunNodes.length} 个因画布修改将重跑</strong>（{resumeChoice.plan.rerunNodes.join('、')}）</>
                )}，其余未完成节点照常补跑。「重新运行」全部节点从头执行。
              </p>
              {resumeChoice.plan.reusableNodes.length > 0 && (
                <p className="sec-hint">复用节点：{resumeChoice.plan.reusableNodes.join('、')}</p>
              )}
            </>
          ) : (
            <p className="sec-hint">「从上次继续」复用已完成节点的输出，只补跑未完成部分。「重新运行」全部节点从头执行。</p>
          )}
        </Modal>
      )}
      {historyOpen && <RunHistory onClose={() => setHistoryOpen(false)}
        onResume={(runId, resumedNodes, rerunNodes) => {
          activeRunIdRef.current = runId;
          runningRef.current = true;
          setInspectedRunId(runId);
          setRunStatus((current) => ({ ...current, running: true, runId }));
          const rerunCount = rerunNodes?.length ?? 0;
          toast(rerunCount > 0
            ? `已从上次运行续跑（复用 ${resumedNodes} 个节点，${rerunCount} 个因画布修改重跑）`
            : `已从上次运行续跑（复用 ${resumedNodes} 个已完成节点）`, 'success');
        }}
        onSelect={(runId) => {
        setInspectedRunId(runId);
        const applyDetail = (detail) => {
          // 历史恢复：把该次运行的节点状态/输出投影回画布（与 SSE snapshot 同形）
          for (const [nodeId, st] of Object.entries(detail.nodeStates || {})) {
            setNodes((nds) => nds.map((n) => {
              if (n.id !== nodeId) return n;
              const data = { ...n.data, runStatus: st.status };
              if (st.startedAt) data.runStartedAt = st.startedAt;
              if (st.chars != null) data.runChars = st.chars;
              if (st.turns != null) data.runTurns = st.turns;
              if (st.error) data.runError = st.error;
              if (st.durationMs != null) data.durationMs = st.durationMs;
              if (st.model) data.runtimeModel = st.model;
              if (st.artifacts) { data.artifacts = st.artifacts; data.artifactsRunId = runId; }
              const out = (detail.outputs || {})[nodeId];
              if (out != null) data.runOutput = String(out).slice(0, 4000);
              return { ...n, data };
            }));
          }
          const restored = Object.entries(detail.nodeStates || {})
            .filter(([, st]) => st.status !== 'queued')
            .map(([nodeId, st]) => ({
              t: Date.now(), kind: 'node', runId, nodeId,
              nodeLabel: labelOf(nodesRef.current, nodeId).replace(/\(.*\)$/, ''),
              status: st.status, text: st.error, chars: st.chars, durationMs: st.durationMs,
            }));
          setEventsByRunId((current) => ({ ...current, [runId]: [...restored, {
            t: Date.now(), kind: 'run', runId, status: detail.status,
            text: `历史运行：${STATUS_CN[detail.status] || detail.status}`,
          }] }));
          setRunStatus((current) => ({ ...current, running: false, runId, last: detail.status }));
        };
        const cached = runDetails[runId];
        if (cached) applyDetail(cached);
        fetch(apiUrl(`/runs/detail?id=${encodeURIComponent(runId)}`))
          .then((response) => response.ok ? response.json() : Promise.reject(new Error('运行记录不存在')))
          .then((detail) => {
            setRunDetails((current) => ({ ...current, [runId]: detail }));
            applyDetail(detail);
          })
          .catch(() => toast('加载历史运行失败', 'error'));
      }} />}
      {nodeDetail && (
        <NodeDetailModal runId={nodeDetail.runId} nodeId={nodeDetail.nodeId} onClose={() => setNodeDetail(null)} />
      )}
      {testNode && (
        <TestRunModal
          node={testNode}
          upstreamNodes={upstreamNodesOf(testNode.id)}
          upstreamPreviews={previewsOf(testNode.id)}
          workflowId={currentWf?.id}
          workflowVariables={workflowVariables}
          inputSchema={inputSchema}
          runInputs={runInputs}
          triggerInput={triggerInput}
          onClose={() => setTestNode(null)}
          onResult={onTestResult}
        />
      )}
      {credOpen && <FeishuCredModal focusLark={focusLark} onClose={() => { setCredOpen(false); setFocusLark(false); }} onChanged={() => {
        fetch(apiUrl('/tools')).then((r) => r.json()).then(setCatalog).catch(() => {});
        fetch(apiUrl('/feishu-credentials')).then((r) => r.json()).then((d) => setFeishuCreds(d.credentials || [])).catch(() => {});
        fetch(apiUrl('/lark-auth')).then((r) => r.json()).then((d) => setLarkStatus(d.status || null)).catch(() => {});
      }} />}
      {variableCenterOpen && (
        <VariableCenter
          workflowVariables={workflowVariables}
          inputSchema={inputSchema}
          onClose={() => setVariableCenterOpen(false)}
          onGlobalChanged={(revision) => setGlobalVariableEpoch(revision)}
        />
      )}
      {templateOpen && <TemplateModal onClose={() => setTemplateOpen(false)} onApply={applyTemplate} />}
      {modal?.type === 'confirm' && (
        <ConfirmModal title={modal.title} message={modal.message} danger={modal.danger} confirmText={modal.confirmText}
          onCancel={() => setModal(null)} onConfirm={modal.onConfirm} />
      )}
      {modal?.type === 'prompt' && (
        <PromptModal title={modal.title} initial={modal.initial} placeholder={modal.placeholder} confirmText={modal.confirmText}
          onCancel={() => setModal(null)} onConfirm={modal.onConfirm} />
      )}
    </div>
  );

  function updateEdgeBranch(edgeId, branch) {
    snapshot();
    setEdges((eds) => eds.map((e) => (e.id === edgeId ? { ...e, branch } : e)));
    markDirty();
  }
}

function toFlowNode(n) {
  const persistedData = stripCanvasRuntimeNodeData(n.data);
  return {
    id: n.id,
    type: 'propertyNode',
    position: n.position,
    data: {
      ...persistedData,
      nodeType: n.type,
      tools: persistedData.tools || [],
      attachments: persistedData.attachments || [],
      planMode: Boolean(persistedData.planMode),
      skills: persistedData.skills || [],
      continueOnFail: Boolean(persistedData.continueOnFail),
      allowPrivate: Boolean(persistedData.allowPrivate),
      runStatus: 'idle',
    },
  };
}

function toFlowEdge(e) {
  return { ...e, branch: e.branch || e.data?.branch };
}

function previewStatusForNode(node) {
  if (node?.data?.runStatus && node.data.runStatus !== 'idle') return node.data.runStatus;
  if (node?.data?.nodeType === 'input' && node.data.text) return 'success';
  return node?.data?.runStatus;
}

function previewOutputForNode(node) {
  if (node?.data?.runOutput !== undefined) return node.data.runOutput;
  if (node?.data?.nodeType === 'input' && node.data.text) return String(node.data.text);
  return undefined;
}

function previewStructuredOutputForNode(node) {
  if (node?.data?.runtimeStructuredOutput !== undefined) return node.data.runtimeStructuredOutput;
  if (node?.data?.nodeType === 'input' && node.data.text) {
    return {
      version: 1,
      type: 'json',
      value: {
        text: String(node.data.text),
        triggerInput: '',
        upstreamText: '',
      },
    };
  }
  return undefined;
}

function labelOf(nodes, id) {
  const n = nodes.find((x) => x.id === id);
  return n?.data?.label ? `${n.data.label}(${id})` : id;
}

function upstreamNodesOfFactory(edges, nodes) {
  return (id) => edges
    .filter((e) => e.target === id)
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter(Boolean)
    .map((n) => ({ id: n.id, label: n.data.label || n.id }));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function findFreeSpot(nodes) {
  // 找一个不与现有节点重叠的位置（网格步进探测）
  const occupied = nodes.map((n) => n.position);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      const x = 120 + c * 340;
      const y = 80 + r * 150;
      if (!occupied.some((p) => Math.abs(p.x - x) < 240 && Math.abs(p.y - y) < 110)) return { x, y };
    }
  }
  return { x: 120 + Math.random() * 480, y: 100 + Math.random() * 260 };
}
