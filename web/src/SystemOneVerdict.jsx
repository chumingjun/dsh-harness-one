// System One 判决卡：结论与分布同屏——只给结论、藏起次高概率是危险 UX。
// 试运行弹窗（TestRunModal）与节点面板最近运行输出（NodePanel sec-result）共用。
// 待定是琥珀不是红：0.3–0.7 不是失败，是「交给人复核」。
import { UsageMeta } from './UsageMeta.jsx';
import { sortedProbabilities, verdictTone } from './systemone-view.js';

const pct = (p) => `${Math.round(Number(p) * 100)}%`;
const fixed = (v) => Number(v).toFixed(2);

function NoulScale({ value, thresholds }) {
  const yes = thresholds?.yes ?? 0.7;
  const no = thresholds?.no ?? 0.3;
  const clamped = Math.min(Math.max(value, 0), 1);
  return (
    <div className="s1-scale" role="img" aria-label={`概率 ${fixed(value)}，否阈值 ${no}，是阈值 ${yes}`}>
      <div className="s1-scale-track">
        <span className="s1-scale-zone s1-zone-no" style={{ width: `${no * 100}%` }} />
        <span className="s1-scale-zone s1-zone-unsettled" style={{ left: `${no * 100}%`, width: `${(yes - no) * 100}%` }} />
        <span className="s1-scale-zone s1-zone-yes" style={{ left: `${yes * 100}%`, width: `${(1 - yes) * 100}%` }} />
        <span className="s1-scale-pointer" style={{ left: `${clamped * 100}%` }} />
      </div>
      <div className="s1-scale-ticks">
        <span style={{ left: `${no * 100}%` }}>{no}</span>
        <span style={{ left: `${yes * 100}%` }}>{yes}</span>
      </div>
    </div>
  );
}

function ProbBars({ probabilities, winner, legend }) {
  const rows = sortedProbabilities(probabilities);
  if (!rows.length) return null;
  return (
    <div className="s1-bars">
      {rows.map(([key, p]) => (
        <div key={key} className={`s1-bar-row ${key === winner ? 's1-bar-winner' : ''}`}>
          <span className="s1-bar-name" title={legend?.[key] ? `${key} · ${legend[key]}` : key}>
            {legend?.[key] ? `${key} ${legend[key]}` : key}
          </span>
          <span className="s1-bar-track"><span className="s1-bar-fill" style={{ width: `${Math.min(Number(p) * 100, 100)}%` }} /></span>
          <span className="s1-bar-pct">{pct(p)}</span>
        </div>
      ))}
    </div>
  );
}

export function SystemOneVerdict({ value, usage, durationMs, model, thresholds }) {
  if (!value || typeof value !== 'object') return null;
  const tone = verdictTone(value);
  const mode = value.mode;
  return (
    <div className={`s1-verdict s1-tone-${tone}`}>
      {mode === 'noul' && (
        <>
          <div className="s1-verdict-head">
            <span className="s1-verdict-label">{value.verdict === 'yes' ? '是' : value.verdict === 'no' ? '否' : '待定'}</span>
            <span className="s1-verdict-value">{fixed(value.value)}</span>
          </div>
          <NoulScale value={Number(value.value) || 0} thresholds={thresholds} />
        </>
      )}
      {mode === 'choice' && (
        <>
          <div className="s1-verdict-head">
            <span className="s1-verdict-label">{value.verdict}</span>
            <span className="s1-verdict-value">{pct(value.probabilities?.[value.verdict])}</span>
          </div>
          <ProbBars probabilities={value.probabilities} winner={value.verdict} />
        </>
      )}
      {mode === 'score' && (
        <>
          <div className="s1-verdict-head">
            <span className="s1-verdict-label">评分 {fixed(value.value)}</span>
          </div>
          <ProbBars probabilities={value.probabilities} legend={value.legend} />
        </>
      )}
      {value.confidence != null && <div className="s1-confidence">置信度 {fixed(value.confidence)}</div>}
      {value.stateTruncated && <div className="s1-truncated">判断依据超长，已截断后判断</div>}
      <div className="s1-meta">
        {durationMs != null && <span>{durationMs}ms</span>}
        {model && <span>{model}</span>}
        <UsageMeta usage={usage} />
      </div>
      <details className="s1-raw">
        <summary>原始 JSON</summary>
        <pre className="panel-output">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}
