// 运行切换器：成果面板顶部的运行胶囊条。LIVE 优先、时间倒序，点击切换当前查看的运行。
import { SOURCE_ICON, SOURCE_LABEL, capsuleTime, switcherCapsules } from './run-switcher.js';

const STATUS_DOT = { running: 'rs-dot-run', success: 'rs-dot-ok', error: 'rs-dot-err', canceled: 'rs-dot-cancel', interrupted: 'rs-dot-err' };

export function RunSwitcher({ runs, inspectedRunId, onSelect, onOpenHistory }) {
  const { shown, overflow } = switcherCapsules(runs);
  if (!shown.length) return null;
  return (
    <div className="run-switcher" role="tablist" aria-label="运行切换">
      {shown.map((r) => {
        const active = r.runId === inspectedRunId;
        return (
          <button
            key={r.runId}
            className={`run-pill ${active ? 'run-pill-on' : ''}`}
            role="tab"
            aria-selected={active}
            title={`${SOURCE_LABEL[r.source] || r.source} · ${r.live ? '运行中' : r.status}${r.startedAt ? ` · ${new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`}
            onClick={() => onSelect?.(r.runId)}
          >
            <span className={`rs-dot ${STATUS_DOT[r.status] || 'rs-dot-idle'}${r.live ? ' rs-dot-live' : ''}`} aria-hidden="true" />
            <span className="rs-icon" aria-hidden="true">{SOURCE_ICON[r.source] || '▶'}</span>
            <span className="rs-time">{capsuleTime(r.startedAt)}</span>
            {r.progress && <span className="rs-progress">{r.progress}</span>}
          </button>
        );
      })}
      {overflow > 0 && (
        <button className="run-pill run-pill-more" title="更多历史运行" onClick={onOpenHistory}>+{overflow}</button>
      )}
    </div>
  );
}
