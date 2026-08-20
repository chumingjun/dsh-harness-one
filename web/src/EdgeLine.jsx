// 自定义连线：中点 hover ＋ 气泡 → 弹类型菜单 → insertNode(edgeId, type) 插入节点。
// 视觉与节点 hover ＋（flow-node-addbtn）同款；菜单条目复用 tb-menu-item。

import { useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import { NODE_REGISTRY } from './registry.jsx';

export function EdgeLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label, labelStyle, data }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  useEffect(() => {
    const closeOther = (event) => {
      if (event.detail !== id) setOpen(false);
    };
    const closeOutside = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('wf1:edge-menu', closeOther);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('wf1:edge-menu', closeOther);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [id]);

  const toggle = (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('wf1:edge-menu', { detail: id }));
    document.querySelectorAll('.flow-node-addwrap.add-open').forEach((w) => w.classList.remove('add-open'));
    setOpen((value) => !value);
  };

  const pick = (e, type) => {
    e.stopPropagation();
    setOpen(false);
    data?.onInsert?.(id, type);
  };

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <span
            className="edge-branch-tag"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 14}px)`, color: labelStyle?.fill }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
      <EdgeLabelRenderer>
        <div
          ref={wrapRef}
          className={`edge-addwrap nodrag nopan${open ? ' add-open' : ''}`}
          data-edge-label={label || ''}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button
            type="button"
            className="edge-addbtn"
            aria-label="在此连线插入节点"
            title="在此插入节点"
            onClick={toggle}
            onPointerDown={(e) => e.stopPropagation()}
          >＋</button>
          {open && (
            <div className="edge-addmenu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
              <div className="tb-canvas-title">插入节点</div>
              {NODE_REGISTRY.filter((k) => k.type !== 'note').map((k) => (
                <button
                  key={k.type}
                  role="menuitem"
                  className="tb-menu-item"
                  style={{ '--item-color': k.color }}
                  onClick={(e) => pick(e, k.type)}
                >
                  <span className="tb-menu-icon" dangerouslySetInnerHTML={{ __html: k.icon }} />
                  {k.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
