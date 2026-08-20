// 运行历史抽屉：最近运行 + 点开看节点状态与输出 + 一键重放（原输入原图重跑）。
import { useEffect, useState } from 'react';
import { apiUrl } from './api.js';
import { Modal } from './ui.jsx';

const STATUS_LABEL = { running: '运行中', success: '成功', error: '失败', canceled: '已取消' };

export function RunHistory({ onClose, onSelect }) {
  const [runs, setRuns] = useState([]);

  const load = () => {
    fetch(apiUrl('/runs')).then((r) => r.json()).then((d) => setRuns(d.runs || [])).catch(() => {});
  };
  useEffect(load, []);

  return (
    <Modal title="运行历史" onClose={onClose}>
      <div className="rh-list">
        {runs.length === 0 && <p className="panel-empty">还没有运行记录。</p>}
        {runs.map((r) => (
          <button key={r.runId} className={`rh-row st-${r.status} ${r.live ? 'rh-live' : ''}`} onClick={() => { onSelect?.(r.runId); onClose(); }}>
            <span className={`rh-status st-${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
            <span className="rh-name">{r.workflowName || '草稿'}</span>
            <span className="rh-meta">
              {new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false })}
              {r.durationMs != null && ` · ${(r.durationMs / 1000).toFixed(1)}s`}
              {r.canceled && ' · 已取消'}
              {r.replayOf && ' · 重放'}
            </span>
            {r.live && <span className="badge badge-plan">LIVE</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
