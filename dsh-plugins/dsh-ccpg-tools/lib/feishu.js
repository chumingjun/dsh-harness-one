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
}

export function createFeishu() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    console.log('[feishu] 已启用（App ID 已配置）');
    return new FeishuClient({ appId, appSecret });
  }
  console.log('[feishu] 未配置 FEISHU_APP_ID/FEISHU_APP_SECRET，链接解析返回占位内容');
  return null;
}
