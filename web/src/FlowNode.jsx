// 节点视觉 v5：类型元数据/徽标/摘要全部来自 registry.jsx（新增节点类型零改动这里）。
// 自定义节点必须渲染 Handle 才能拖拽建线、锚定已有连线。

import { Handle, Position } from '@xyflow/react';
import { NODE_REGISTRY, kindOf } from './registry.jsx';

const STATUS_STYLE = {
  idle: {},
  queued: { border: '2px solid #94a3b8' },
  running: { border: '2px solid #f59e0b', boxShadow: '0 0 12px rgba(245,158,11,.6)' },
  waiting: { border: '2px dashed #db2777', boxShadow: '0 0 12px rgba(219,39,119,.4)' },
  success: { border: '2px solid #10b981' },
  error: { border: '2px solid #ef4444' },
  skipped: { border: '2px dashed #9ca3af', opacity: 0.6 },
  canceled: { border: '2px dotted #94a3b8', opacity: 0.7 },
};

const STATUS_TEXT = {
  queued: '排队中', running: <span className="flow-node-running"><span className="spinner" />执行中</span>,
  waiting: '⏸ 待审批',
  error: '✗ 失败', skipped: '跳过', canceled: '已取消',
};

const CHILD_TYPES = NODE_REGISTRY.map((k) => ({ type: k.type, icon: k.icon, label: k.label }));

export function FlowNode({ data, selected, id, onAddChild }) {
  const meta = kindOf(data.nodeType);
  const status = data.runStatus || 'idle';
  const turns = status === 'running' ? data.liveTurns : data.runTurns;
  const statusText = status === 'success'
    ? `✓ ${data.runChars ?? 0} 字${turns != null ? ` · ${turns} 轮` : ''}`
    : `${STATUS_TEXT[status] || ''}${status === 'running' && turns != null ? ` 第 ${turns} 轮` : ''}${status !== 'running' && turns != null ? ` · ${turns} 轮` : ''}`;
  const badges = [
    ...extraBadges(data),
    ...((meta.badges || (() => []))(data) || []),
  ].filter(Boolean);

  return (
    <div className="flow-node" style={{ borderColor: meta.color, ...STATUS_STYLE[status] }}>
      <Handle type="target" position={Position.Left} className="flow-handle flow-handle-target" />
      <div className="flow-node-head" style={{ background: meta.color }}>
        <span className="flow-node-title"><span dangerouslySetInnerHTML={{ __html: meta.icon }} />{data.label || meta.label}</span>
        <span className="flow-node-badge">{statusText}</span>
      </div>
      <div className="flow-node-body">
        <p className="flow-node-hint">{clip(meta.summary(data), 60)}</p>
        {badges.length > 0 && (
          <p className="flow-node-badges">
            {badges.map((b, i) => <span key={i} className={`badge ${b.cls || ''}`} title={b.title}>{b.text}</span>)}
          </p>
        )}
        {status === 'running' && data.livePreview && (
          <p className="flow-node-live">{clip(data.livePreview, 64)}</p>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="flow-handle flow-handle-source" />
      {/* hover 快捷加下游节点：点 + 展开类型菜单，选中即在右侧生成并自动连线 */}
      {onAddChild && (
        <div className="flow-node-addwrap">
          <button
            type="button"
            className="flow-node-addbtn"
            aria-label="添加下一个节点"
            title="快速添加下一个节点（自动连线）"
            onClick={(e) => {
              e.stopPropagation();
              const wrap = e.currentTarget.closest('.flow-node-addwrap');
              // 关掉其他节点已开的菜单，再切换当前（并提升节点层级防遮挡）
              document.querySelectorAll('.flow-node-addwrap.add-open').forEach((w) => {
                if (w !== wrap) w.classList.remove('add-open');
              });
              wrap?.classList.toggle('add-open');
            }}
          >＋</button>
          <div className="flow-node-addmenu" role="menu">
            {CHILD_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                role="menuitem"
                className="flow-node-additem"
                onClick={(e) => {
                  e.stopPropagation();
                  e.currentTarget.closest('.flow-node-addwrap')?.classList.remove('add-open');
                  onAddChild(id, t.type);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              ><span dangerouslySetInnerHTML={{ __html: t.icon }} />{t.label}</button>
            ))}
          </div>
        </div>
      )}
      {selected && <div className="flow-node-selected-tag">选中</div>}
    </div>
  );
}

// registry 之外的展示型徽标（附件/飞书链接等类型内细节）
function extraBadges(data) {
  const out = [];
  if (data.nodeType === 'input') {
    if (data.attachments?.length > 0) out.push({ text: `📎 ${data.attachments.length} 附件` });
    if (/feishu\.cn\//.test(data.text || '')) out.push({ text: '📕 飞书' });
  }
  return out;
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
