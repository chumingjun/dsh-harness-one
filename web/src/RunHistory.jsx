// 运行历史抽屉：最近运行 + 进度（3/4）+ 点开看节点状态与输出 + 重放 / 断点续跑。
import { useEffect, useState } from 'react';
import { apiUrl } from './api.js';
import { Modal } from './ui.jsx';

const STATUS_LABEL = { running: '运行中', success: '成功', error: '失败', canceled: '已取消' };

function progressText(r) {
  const p = r.progress;
  if (!p || !p.total) return '';
  return `${p.done}/${p.total}`;
}

export function RunHistory({ onClose, onSelect, onResume }) {
  const [runs, setRuns] = useState([]);
  const [resuming, setResuming] = useState('');

  const load = () => {
    fetch(apiUrl('/runs')).then((r) => r.json()).then((d) => setRuns(d.runs || [])).catch(() => {});
  };
  useEffect(load, []);

  const resumeRun = async (runId) => {
    if (resuming) return;
    setResuming(runId);
    try {
      const res = await fetch(apiUrl('/runs/resume'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '续跑失败');
      onResume?.(data.runId, data.resumedNodes);
      onClose();
    } catch (e) {
      alert(`无法续跑：${e.message}`);
      load();
    } finally {
      setResuming('');
    }
  };

  return (
    <Modal title="运行历史" onClose={onClose}>
      <div className="rh-list">
        {runs.length === 0 && <p className="panel-empty">还没有运行记录。</p>}
        {runs.map((r) => (
          <div key={r.runId} className={`rh-row-wrap ${r.live ? 'rh-live' : ''}`}>
            <button className={`rh-row st-${r.status}`} onClick={() => { onSelect?.(r.runId); onClose(); }}>
              <span className={`rh-status st-${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
              <span className="rh-name">{r.workflowName || '草稿'}</span>
              <span className="rh-meta">
                {new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false })}
                {r.durationMs != null && ` · ${(r.durationMs / 1000).toFixed(1)}s`}
                {r.canceled && ' · 已取消'}
                {r.replayOf && ' · 重放'}
                {r.resumedFrom && ' · 续跑'}
              </span>
              {progressText(r) && <span className="rh-progress">{progressText(r)}</span>}
              {r.live && <span className="badge badge-plan">LIVE</span>}
            </button>
            {r.resumable && (
              <button className="btn btn-sm rh-resume" disabled={resuming === r.runId}
                title="从上次完成的节点之后继续运行（图未修改时可用）"
                onClick={() => resumeRun(r.runId)}>
                {resuming === r.runId ? '启动中…' : `续跑 ${progressText(r)}`}
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
