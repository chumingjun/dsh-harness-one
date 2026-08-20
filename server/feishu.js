// 飞书文档解析：链接识别 + 开放平台 API 封装（docx → markdown 近似文本）。
// 无凭据时返回结构化占位说明，保证 mock 模式闭环可用。

const LINK_PATTERNS = [
  // https://xxx.feishu.cn/docx/<token> 或 /wiki/<token>（wiki 需换取真实 token）
  { re: /https?:\/\/[a-zA-Z0-9.-]+\.feishu\.cn\/(?:docx|wiki)\/([A-Za-z0-9]+)/g, type: 'doc' },
  { re: /https?:\/\/[a-zA-Z0-9.-]+\.feishu\.cn\/sheets\/([A-Za-z0-9]+)/g, type: 'sheet' },
  { re: /https?:\/\/[a-zA-Z0-9.-]+\.feishu\.cn\/base\/([A-Za-z0-9]+)/g, type: 'base' },
];

export function extractFeishuLinks(text) {
  const links = [];
  for (const { re, type } of LINK_PATTERNS) {
    let m;
    while ((m = re.exec(text || '')) !== null) {
      if (!links.some((l) => l.token === m[1])) links.push({ type, token: m[1], url: m[0] });
    }
  }
  return links;
}

export class FeishuClient {
  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = 'https://open.feishu.cn/open-apis';
    this._token = null;
    this._tokenExp = 0;
  }

  get enabled() { return Boolean(this.appId && this.appSecret); }

  async tenantAccessToken() {
    if (this._token && Date.now() < this._tokenExp - 60_000) return this._token;
    const res = await fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`飞书鉴权失败: ${data.code} ${data.msg}`);
    this._token = data.tenant_access_token;
    this._tokenExp = Date.now() + (data.expire ?? 7200) * 1000;
    return this._token;
  }

  async api(path, opts = {}) {
    const token = await this.tenantAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (data.code !== 0) throw new Error(`飞书 API ${path} 失败: ${data.code} ${data.msg}`);
    return data.data ?? data;
  }

  // wiki 链接换取真实文档 token
  async resolveToken(type, token) {
    if (type !== 'wiki') return { objType: 'docx', token };
    const node = await this.api(`/wiki/v2/spaces/get_node?token=${token}`);
    return { objType: node.node.obj_type === 'doc' ? 'docx' : node.node.obj_type, token: node.node.obj_token };
  }

  // docx 原始文档信息（拿 title）
  async docTitle(token) {
    const info = await this.api(`/docx/v1/documents/${token}`);
    return info.document?.title || '(未命名文档)';
  }

  // docx 全量 blocks → 纯文本（block 模型繁琐，MVP 取常用文本块）
  async docToMarkdown(token) {
    const title = await this.docTitle(token);
    const raw = await this.api(`/docx/v1/documents/${token}/raw_content`);
    const body = raw.content || '(空文档)';
    return `# ${title}\n\n${body}`;
  }

  // 云空间新建 docx（与插件 feishu.js 同语义：返回 url）
  async createDoc(title) {
    const created = await this.api('/docx/v1/documents', {
      method: 'POST',
      body: JSON.stringify({ title: String(title || '未命名文档').slice(0, 100) }),
    });
    if (!created?.document?.document_id) throw new Error('创建文档失败: ' + JSON.stringify(created).slice(0, 200));
    const docId = created.document.document_id;
    await this.api(`/drive/v1/permissions/${docId}/public`, {
      method: 'PATCH',
      body: JSON.stringify({ external_access: true, security_entity: 'anyone_can_view', comment_entity: 'anyone_can_view', share_entity: 'anyone', link_share_entity: 'anyone_readable', invite_external: false }),
    }).catch(() => {});
    return { url: `https://feishu.cn/docx/${docId}`, documentId: docId };
  }

  // 按行拆 block 分批追加（与插件 feishu.js 同语义：50 段/批）
  async appendDoc(token, text) {
    const lines = String(text || '').split('\n').filter((l) => l.trim() !== '');
    const toBlock = (l) => ({ block_type: 2, text: { elements: [{ text_run: { content: l } }], style: {} } });
    const BATCH = 50;
    let paras = 0;
    for (let i = 0; i < lines.length; i += BATCH) {
      const chunk = lines.slice(i, i + BATCH).map(toBlock);
      const res = await this.api(`/docx/v1/documents/${token}/blocks/${token}/children`, {
        method: 'POST',
        body: JSON.stringify({ children: chunk, index: -1 }),
      });
      if (res?.code && res.code !== 0) throw new Error(`飞书写入失败 code=${res.code}: ${res.msg || ''}`);
      paras += chunk.length;
    }
    return paras;
  }
}

// resolveDyanmic：可选的凭据解析函数（()=>({appId,appSecret})|null），每次 API 调用时现取——
// 画布 ⚙ 弹窗增删凭据即时生效，无需重启。未提供时保持原静态行为。
export function createFeishu(resolveCred) {
  if (typeof resolveCred === 'function') {
    let current = null;
    let client = null;
    const getClient = () => {
      const cred = resolveCred();
      const same = current && cred && current.appId === cred.appId && current.appSecret === cred.appSecret;
      if (!same) {
        current = cred;
        client = cred?.appId && cred?.appSecret ? new FeishuClient({ appId: cred.appId, appSecret: cred.appSecret }) : null;
        console.log(client ? `[feishu] 已启用（凭据来源：${cred.source || 'canvas'}）` : '[feishu] 无可用凭据，链接解析返回占位内容');
      }
      return client;
    };
    return {
      get enabled() { return Boolean(getClient()); },
      api(path, init) { const c = getClient(); if (!c) return null; return c.api(path, init); },
      resolveToken(type, token) { const c = getClient(); if (!c) return null; return c.resolveToken(type, token); },
      docToMarkdown(token) { const c = getClient(); if (!c) return null; return c.docToMarkdown(token); },
      docTitle(token) { const c = getClient(); if (!c) return null; return c.docTitle(token); },
      createDoc(title) { const c = getClient(); if (!c) throw new Error('飞书未配置'); return c.createDoc(title); },
      appendDoc(token, text) { const c = getClient(); if (!c) throw new Error('飞书未配置'); return c.appendDoc(token, text); },
    };
  }
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    console.log('[feishu] 已启用（App ID 已配置）');
    return new FeishuClient({ appId, appSecret });
  }
  console.log('[feishu] 未配置 FEISHU_APP_ID/FEISHU_APP_SECRET，链接解析返回占位内容');
  return null;
}
