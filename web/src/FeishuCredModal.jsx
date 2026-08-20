// 飞书应用凭据设置弹窗：多套凭据的增删/设默认；secret 不回显。
// 飞书账号扫码登录在 dsh 官方 Web UI 的设置面板（dsh-ccpg-larkauth 插件）。
import { useEffect, useState } from 'react';
import { apiUrl } from './api.js';
import { Modal } from './ui.jsx';
import { useToast } from './ui.jsx';

export function FeishuCredModal({ onClose, onChanged }) {
  const toast = useToast();
  const [list, setList] = useState([]);
  const [envFallback, setEnvFallback] = useState(false);
  const [form, setForm] = useState({ name: '', appId: '', appSecret: '' });
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(apiUrl('/feishu-credentials')).then((r) => r.json())
      .then((d) => { setList(d.credentials || []); setEnvFallback(Boolean(d.envFallback)); })
      .catch(() => {});
  };
  useEffect(load, []);

  const add = async () => {
    if (!form.appId.trim() || !form.appSecret.trim()) { toast('App ID 和 Secret 都要填', 'error'); return; }
    setBusy(true);
    const res = await fetch(apiUrl('/feishu-credentials'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) { toast(d.error || '添加失败', 'error'); return; }
    toast(`已添加「${d.credential.name}」`, 'success');
    setForm({ name: '', appId: '', appSecret: '' });
    load();
    onChanged?.();
  };

  const setDefault = async (id) => {
    await fetch(apiUrl('/feishu-credentials'), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setDefault', id }),
    });
    toast('已设为默认凭据', 'success');
    load();
    onChanged?.();
  };

  const remove = async (c) => {
    await fetch(apiUrl(`/feishu-credentials?id=${encodeURIComponent(c.id)}`), { method: 'DELETE' });
    toast(`已删除「${c.name}」`, 'warn');
    load();
    onChanged?.();
  };

  return (
    <Modal title="⚙ 飞书应用凭据" onClose={onClose}>
      <div className="cred-layout">
        <aside className="cred-aside">
          <p className="cred-aside-title">关于凭据</p>
          <p className="cred-aside-text">
            在飞书开放平台创建企业自建应用，把 App ID / App Secret 填到这里。
          </p>
          <ul className="cred-aside-tips">
            <li>可配多套（如不同项目各一套），输出节点可选用</li>
            <li>未选用时走「默认」凭据</li>
            <li>Secret 只存本机，永不回显</li>
            {envFallback && <li>环境变量里另有一套兜底（画布凭据优先）</li>}
          </ul>
        </aside>
        <div className="cred-main-col">
          <div className="cred-list">
            <div className="cred-list-head">
              <span>已配置（{list.length}）</span>
            </div>
            {list.length === 0 && <div className="cred-empty">还没有凭据，在右侧添加第一套 →</div>}
            {list.map((c) => (
              <div key={c.id} className={`cred-row ${c.isDefault ? 'cred-default' : ''}`}>
                <div className="cred-main">
                  <div className="cred-name-line">
                    <strong>{c.name}</strong>
                    {c.isDefault && <span className="cred-default-tag">默认</span>}
                  </div>
                  <span className="cred-id">AppID {c.appIdMasked}</span>
                </div>
                <div className="cred-actions">
                  {!c.isDefault && <button className="btn btn-sm" onClick={() => setDefault(c.id)}>设为默认</button>}
                  <button className="btn-icon" title="删除凭据" aria-label="删除凭据" onClick={() => remove(c)}>✕</button>
                </div>
              </div>
            ))}
          </div>
          <div className="cred-form">
            <h4>添加凭据</h4>
            <div className="cred-form-grid">
              <input className="modal-input" placeholder="名称（如：XX项目飞书应用）" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="modal-input" placeholder="App ID（cli_ 开头）" value={form.appId}
                onChange={(e) => setForm({ ...form, appId: e.target.value.trim() })} />
              <input className="modal-input" type="password" placeholder="App Secret" value={form.appSecret}
                onChange={(e) => setForm({ ...form, appSecret: e.target.value.trim() })}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
            </div>
            <div className="cred-form-foot">
              <span className="sec-hint">App ID 和 Secret 必填；名称可留空自动命名</span>
              <button className="btn btn-primary" disabled={busy} onClick={add}>＋ 添加凭据</button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
