// 试运行弹窗：手填/编辑假输入（默认取各上游最近运行输出，可禁用单个上游）、
// 进行中显示流式轮次与预览；结果与最近几次对比。
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './api.js';
import { parseJsonResponseText } from './json-response.js';
import { trialRequestUrls } from './trial-request.js';
import { Modal, useToast } from './ui.jsx';

export function TestRunModal({ node, upstreamNodes, upstreamPreviews, workflowId, workflowVariables, inputSchema, runInputs, triggerInput, onClose, onResult }) {
  const toast = useToast();
  // 每个上游：{ enabled, text }——text 默认 = 最近运行输出或示例占位
  const [inputs, setInputs] = useState(() => {
    const init = {};
    for (const u of upstreamNodes) {
      const prev = upstreamPreviews[u.id] ?? upstreamPreviews[u.label] ?? u.output;
      init[u.id] = { enabled: true, text: prev != null ? String(prev) : '' };
    }
    return init;
  });
  const [trigger, setTrigger] = useState(triggerInput || '');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { turns, preview }
  const [result, setResult] = useState(null); // { ok, output, error, at, meta }
  const [history, setHistory] = useState([]); // 最近几次试运行结果
  const [showDiff, setShowDiff] = useState(false);
  const esRef = useRef(null);
  const requestAbortRef = useRef(null);

  const hasUpstream = upstreamNodes.length > 0;

  // 流式进度：监听 agent-progress（runId 匹配 test_ 前缀即试运行）
  useEffect(() => {
    if (!running) return undefined;
    const es = new EventSource(apiUrl('/events'));
    esRef.current = es;
    es.addEventListener('agent-progress', (e) => {
      const p = JSON.parse(e.data);
      if (p.runId?.startsWith('test_')) setProgress(p);
    });
    return () => { es.close(); esRef.current = null; };
  }, [running]);

  useEffect(() => () => requestAbortRef.current?.abort(), []);

  const close = () => {
    requestAbortRef.current?.abort();
    onClose();
  };

  const run = async () => {
    setRunning(true);
    setProgress(null);
    setResult(null);
    const upstreamOutputs = {};
    const upstreamStructuredOutputs = {};
    const upstreamLabels = {};
    for (const u of upstreamNodes) {
      const st = inputs[u.id];
      if (!st?.enabled) continue;
      upstreamOutputs[u.id] = st.text;
      upstreamLabels[u.id] = u.label;
      if (u.structuredOutput !== undefined && st.text === String(u.output ?? '')) {
        upstreamStructuredOutputs[u.id] = u.structuredOutput;
      } else {
        const parsed = parseStructuredInput(st.text);
        if (parsed !== undefined) upstreamStructuredOutputs[u.id] = {
          version: 1,
          type: 'json',
          mediaType: 'application/json',
          value: parsed,
        };
      }
    }
    try {
      const url = apiUrl('/node/test');
      const controller = new AbortController();
      requestAbortRef.current = controller;
      const request = {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          node: { id: node.id, type: node.data.nodeType, data: stripRuntime(node.data) },
          upstreamOutputs, upstreamStructuredOutputs, upstreamLabels,
          workflowId,
          workflowVariables,
          inputSchema,
          runInputs,
          triggerInput: trigger,
        }),
      };
      const d = await fetchTrialJson(url, request);
      const r = { ...d, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) };
      setResult(r);
      setHistory((h) => [r, ...h].slice(0, 5));
      if (d.ok) toast('试运行完成', 'success');
      else toast(`试运行失败：${d.error}`, 'error');
      onResult?.(d);
    } catch (e) {
      if (e.name !== 'AbortError') {
        setResult({ ok: false, error: e.message, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        toast(`试运行失败：${e.message}`, 'error');
      }
    } finally {
      requestAbortRef.current = null;
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`▶ 试运行「${node.data.label || node.id}」`}
      onClose={close}
      footer={(
        <>
          <button className="btn" onClick={close}>关闭</button>
          <button className="btn btn-primary" disabled={running} onClick={run}>
            {running ? '运行中…' : '▶ 执行'}
          </button>
        </>
      )}
    >
      {/* 上游假输入 */}
      {hasUpstream && (
        <div className="test-inputs">
          <div className="test-sec-title">上游输入{running ? '' : '（可直接编辑）'}</div>
          {upstreamNodes.map((u) => (
            <div key={u.id} className={`test-input-row ${inputs[u.id]?.enabled ? '' : 'test-input-off'}`}>
              <label className="test-input-head">
                <input
                  type="checkbox"
                  checked={inputs[u.id]?.enabled ?? true}
                  onChange={(e) => setInputs((s) => ({ ...s, [u.id]: { ...s[u.id], enabled: e.target.checked } }))}
                />
                <span className="test-input-name">{`{{${u.label}}}`}</span>
                {upstreamPreviews[u.label] != null && <span className="test-from">来自上次运行</span>}
              </label>
              <textarea
                rows={3}
                value={inputs[u.id]?.text || ''}
                placeholder="填入该上游的模拟输出…"
                onChange={(e) => setInputs((s) => ({ ...s, [u.id]: { ...s[u.id], text: e.target.value } }))}
              />
            </div>
          ))}
          <div className="test-input-row">
            <div className="test-input-head"><span className="test-input-name">{'{{$trigger}}'}</span></div>
            <textarea rows={2} value={trigger} placeholder="触发输入（可选）"
              onChange={(e) => setTrigger(e.target.value)} />
          </div>
        </div>
      )}

      {/* 流式进度 */}
      {running && progress && (
        <div className="test-progress">
          <div className="test-sec-title">执行中 · 第 {progress.turns || '?'} 轮</div>
          {progress.preview && <pre>{String(progress.preview).slice(-400)}</pre>}
        </div>
      )}

      {/* 本次结果 */}
      {result && (
        <div className={`test-result ${result.ok ? '' : 'test-result-err'}`}>
          <div className="test-sec-title">
            {result.ok ? `✓ 结果（${result.at}${result.turns ? ` · ${result.turns} 轮` : ''}${result.model ? ` · ${result.model}` : ''}）` : `✕ 失败（${result.at}）`}
          </div>
          <pre>{result.ok ? result.output : result.error}</pre>
          {result.ok && result.input !== undefined && (
            <details className="test-structured">
              <summary>解析后的 JSON 入参</summary>
              <pre>{JSON.stringify(result.input, null, 2)}</pre>
            </details>
          )}
          {result.ok && result.structuredOutput?.type === 'json' && (
            <details className="test-structured" open>
              <summary>结构化输出预览</summary>
              <pre>{JSON.stringify(result.structuredOutput.value, null, 2)}</pre>
            </details>
          )}
          {result.ok && result.artifacts?.length > 0 && (
            <details className="test-structured" open>
              <summary>工作区产物（{result.artifacts.length}）</summary>
              <ul className="test-artifact-list">
                {result.artifacts.map((artifact) => <li key={artifact}>{artifact}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* 历史 */}
      {history.length > 1 && (
        <div className="test-history">
          <button className="btn btn-sm" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? '收起' : `对比最近 ${history.length} 次`}
          </button>
          {showDiff && (
            <div className="test-hist-list">
              {history.map((h, i) => (
                <div key={i} className={`test-hist-item ${h.ok ? '' : 'test-result-err'}`}>
                  <div className="test-hist-meta">{h.at} {h.ok ? '✓' : '✕'} {h.turns ? `${h.turns}轮` : ''}</div>
                  <pre>{String(h.ok ? h.output : h.error).slice(0, 600)}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

async function fetchTrialJson(url, request) {
  let lastError;
  const urls = trialRequestUrls(url);

  for (let index = 0; index < urls.length; index += 1) {
    const candidate = urls[index];
    try {
      const response = await fetch(candidate, request);
      const text = await response.text();
      const data = parseJsonResponseText(text, {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        url: candidate,
      });
      if (!response.ok) throw new Error(data.error || `试运行请求失败（HTTP ${response.status}）`);
      return data;
    } catch (error) {
      lastError = error;
      const canUseAlternate = index < urls.length - 1
        && /HTTP 404|返回了网页|空响应|Failed to fetch|Load failed/i.test(error.message || '');
      if (canUseAlternate) continue;
      if (index === urls.length - 1 && /返回了网页|空响应|Failed to fetch|Load failed/i.test(error.message || '')) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        try {
          const response = await fetch(candidate, request);
          const text = await response.text();
          const data = parseJsonResponseText(text, {
            status: response.status,
            contentType: response.headers.get('content-type') || '',
            url: candidate,
          });
          if (!response.ok) throw new Error(data.error || `试运行请求失败（HTTP ${response.status}）`);
          return data;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      throw lastError;
    }
  }
  throw lastError;
}

function parseStructuredInput(value) {
  const text = String(value ?? '').trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function stripRuntime(data) {
  const {
    runStatus, runOutput, runError, runChars, runtimeStructuredOutput,
    livePreview, artifacts, sessionId, durationMs, runtimeModel, test, ...rest
  } = data;
  return rest;
}
