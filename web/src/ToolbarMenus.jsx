// 工具栏下拉菜单：加节点（＋）与更多操作（⋯）。
// 复用 hover 快捷菜单的视觉（flow-node-additem 同款条目），双击画布弹的也是 AddNodeMenu。
// 点击外部关闭；Esc 关闭；条目带 SVG 图标（来自 NODE_REGISTRY）。

import { useEffect, useRef, useState } from 'react';
import { NODE_REGISTRY } from './registry.jsx';

function useOutsideClose(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    // mousedown 捕获：在菜单内按钮 click 冒泡前先判外部
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return ref;
}

/** ＋ 添加节点下拉：anchor 在工具栏；onPick(type) */
export function AddNodeMenu({ onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));
  return (
    <div className="tb-menu" ref={ref}>
      <button
        className={`btn ${open ? 'btn-menu-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="添加节点（或双击画布空白处）"
      >
        ＋ 添加 <span className={`tb-caret ${open ? 'tb-caret-open' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="tb-dropdown" role="menu">
          {NODE_REGISTRY.map((k) => (
            <button key={k.type} role="menuitem" className="tb-menu-item"
              style={{ '--item-color': k.color }}
              onClick={() => { setOpen(false); onPick(k.type); }}>
              <span className="tb-menu-icon" dangerouslySetInnerHTML={{ __html: k.icon }} />
              {k.label}
              {k.type === 'note' && <span className="tb-menu-sub">不参与运行</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 双击画布空白处弹出的加节点菜单（fixed 定位在光标处） */
export function CanvasAddMenu({ x, y, onPick, onClose }) {
  const ref = useOutsideClose(onClose);
  // 靠近视口右/下边缘时向左/上翻转
  const flipX = x > window.innerWidth - 180;
  const flipY = y > window.innerHeight - 320;
  return (
    <div
      className="tb-canvas-menu"
      ref={ref}
      style={{
        left: flipX ? undefined : x,
        right: flipX ? (window.innerWidth - x) : undefined,
        top: flipY ? undefined : y,
        bottom: flipY ? (window.innerHeight - y) : undefined,
      }}
      role="menu"
    >
      <div className="tb-canvas-title">添加节点</div>
      {NODE_REGISTRY.map((k) => (
        <button key={k.type} role="menuitem" className="tb-menu-item"
          style={{ '--item-color': k.color }}
          onClick={() => { onClose(); onPick(k.type); }}>
          <span className="tb-menu-icon" dangerouslySetInnerHTML={{ __html: k.icon }} />
          {k.label}
          {k.type === 'note' && <span className="tb-menu-sub">不参与运行</span>}
        </button>
      ))}
    </div>
  );
}

/** ⋯ 更多操作：低频项收纳 */
export function MoreMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));
  return (
    <div className="tb-menu" ref={ref}>
      <button
        className={`btn tb-icon-btn ${open ? 'btn-menu-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多操作"
        aria-label="更多操作"
      >⋯</button>
      {open && (
        <div className="tb-dropdown tb-dropdown-right" role="menu">
          {items.filter(Boolean).map((it) => (
            <button key={it.key} role="menuitem" className={`tb-menu-item ${it.danger ? 'tb-menu-danger' : ''}`}
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick?.(); }}>
              {it.icon && <span className="tb-menu-icon tb-menu-glyph">{it.icon}</span>}
              <span className="tb-menu-text">
                {it.label}
                {it.hint && <span className="tb-menu-sub">{it.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
