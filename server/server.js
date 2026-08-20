// Express 服务器 v2：静态托管 + 图 CRUD + 运行 API + 附件上传 + 工具清单 + SSE。

import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLLM } from './llm.js';
import { Orchestrator } from './orchestrator.js';
import { createFeishu } from './feishu.js';
import { createToolExecutor, toolDefinitions } from './tools.js';
import { listSkills } from './skills.js';
import { detectDsh } from './agent-runtime.js';
// 凭据存储与 dsh 插件同源（dsh-ccpg-orchestrator/lib/credentials.js，读写同一 data/credentials.json）
import {
  listFeishuCreds, addFeishuCred, removeFeishuCred, setDefaultFeishuCred, hasAnyFeishuCred, getFeishuCredOrEnv,
} from '../dsh-plugins/dsh-ccpg-orchestrator/lib/credentials.js';
// 飞书账号扫码登录归独立插件 dsh-ccpg-larkauth（dsh 官方 Web UI 设置面板），画布/Express 不再提供。

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const GRAPH_FILE = join(ROOT, 'data', 'graph.json');
const ATTACH_DIR = join(ROOT, 'data', 'attachments');
const PORT = process.env.PORT || 4020;

mkdirSync(ATTACH_DIR, { recursive: true });

const llm = createLLM();
const feishu = createFeishu(getFeishuCredOrEnv);
const toolExecutor = createToolExecutor({ feishu });
const orch = new Orchestrator({ llm, toolExecutor, feishu });

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(join(ROOT, 'web', 'dist')));

// ---- 图 CRUD ----

app.get('/api/graph', (_req, res) => {
  if (!existsSync(GRAPH_FILE)) return res.json(defaultGraph());
  try {
    res.json(JSON.parse(readFileSync(GRAPH_FILE, 'utf8')));
  } catch {
    res.json(defaultGraph());
  }
});

app.put('/api/graph', (req, res) => {
  const graph = req.body;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return res.status(400).json({ error: 'graph 需要 { nodes, edges }' });
  }
  writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2));
  res.json({ ok: true });
});

app.post('/api/graph/reset', (_req, res) => {
  writeFileSync(GRAPH_FILE, JSON.stringify(defaultGraph(), null, 2));
  res.json({ ok: true });
});

// ---- 工作流库（与 dsh 插件 /wf1/api/workflows 同语义，双入口一致） ----

const WF_DIR = join(ROOT, 'data', 'workflows');
mkdirSync(WF_DIR, { recursive: true });
const wfFile = (id) => join(WF_DIR, `${String(id).replace(/[/\\]/g, '_')}.json`);
const readWf = (id) => {
  try { return JSON.parse(readFileSync(wfFile(id), 'utf8')); } catch { return null; }
};

app.get('/api/workflows', (_req, res) => {
  const list = readdirSync(WF_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const wf = readWf(f.replace(/\.json$/, ''));
    if (!wf) return null;
    return {
      id: wf.id, name: wf.name, updatedAt: wf.updatedAt,
      nodeCount: wf.graph?.nodes?.length ?? 0,
      agentCount: wf.graph?.nodes?.filter((n) => n.type === 'agent').length ?? 0,
    };
  }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json({ workflows: list });
});

app.post('/api/workflows', (req, res) => {
  const { id, name, graph } = req.body || {};
  if (!name || !graph || !Array.isArray(graph.nodes)) return res.status(400).json({ error: '需要 name 和 graph' });
  const wid = id || `wf_${Date.now().toString(36)}`;
  const prev = readWf(wid);
  const wf = {
    id: wid,
    name: String(name).slice(0, 60) || prev?.name || '未命名工作流',
    updatedAt: new Date().toISOString(),
    graph,
  };
  writeFileSync(wfFile(wid), JSON.stringify(wf, null, 2));
  res.json({ ok: true, id: wf.id, name: wf.name, updatedAt: wf.updatedAt });
});

app.get('/api/workflows/detail', (req, res) => {
  const wf = readWf(req.query.id);
  if (!wf) return res.status(404).json({ error: '工作流不存在' });
  res.json(wf);
});

app.delete('/api/workflows/detail', (req, res) => {
  try { unlinkSync(wfFile(req.query.id)); res.json({ ok: true }); }
  catch { res.status(404).json({ error: '工作流不存在' }); }
});

app.patch('/api/workflows/detail', (req, res) => {
  const wf = readWf(req.query.id);
  if (!wf) return res.status(404).json({ error: '工作流不存在' });
  wf.name = String(req.body?.name || wf.name).slice(0, 60);
  wf.updatedAt = new Date().toISOString();
  writeFileSync(wfFile(wf.id), JSON.stringify(wf, null, 2));
  res.json({ ok: true, id: wf.id, name: wf.name });
});

// ---- 附件 ----

app.post('/api/attachments', (req, res) => {
  const { filename, contentBase64 } = req.body || {};
  if (!filename || !contentBase64) return res.status(400).json({ error: '需要 filename 和 contentBase64' });
  const safe = filename.replace(/[/\\]/g, '_');
  const buf = Buffer.from(contentBase64, 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: '附件超过 5MB' });
  writeFileSync(join(ATTACH_DIR, safe), buf);
  res.json({ ok: true, filename: safe, size: buf.length });
});

app.get('/api/attachments', (_req, res) => {
  try {
    const files = readdirSync(ATTACH_DIR).map((filename) => {
      const st = statSync(join(ATTACH_DIR, filename));
      return { filename, size: st.size, uploadedAt: st.mtime.toISOString() };
    });
    res.json({ attachments: files });
  } catch {
    res.json({ attachments: [] });
  }
});

// ---- 工具 ----

app.get('/api/tools', (_req, res) => {
  res.json({
    tools: toolDefinitions(['*']).map((d) => ({ name: d.name, description: d.description })),
    feishuEnabled: hasAnyFeishuCred() || Boolean(feishu?.enabled),
  });
});

// ---- 飞书凭据管理（与 dsh 插件 /wf1/api/feishu-credentials 同语义，共享存储） ----

app.get('/api/feishu-credentials', (_req, res) => {
  res.json({
    credentials: listFeishuCreds(),
    envFallback: Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET),
  });
});

app.post('/api/feishu-credentials', (req, res) => {
  try {
    const added = addFeishuCred(req.body || {});
    res.json({ ok: true, credential: added });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.patch('/api/feishu-credentials', (req, res) => {
  if (req.body?.action !== 'setDefault') {
    return res.status(400).json({ error: 'PATCH 仅支持 action=setDefault' });
  }
  res.json({ ok: setDefaultFeishuCred(req.body.id) });
});

app.delete('/api/feishu-credentials', (req, res) => {
  res.json({ ok: removeFeishuCred(String(req.query.id || '')) });
});

// ---- 技能 ----

app.get('/api/skills', (_req, res) => {
  res.json({ skills: listSkills() });
});

// ---- 运行时状态（dsh 底座可用性探测） ----

app.get('/api/runtime-config', (_req, res) => {
  res.json({ runtime: detectDsh() });
});

// ---- LLM 配置（节点级模型/渠道选择数据源） ----

app.get('/api/llm-config', (_req, res) => {
  res.json(llm.describe ? llm.describe() : { defaultMode: llm.name });
});

// ---- 运行 ----

app.post('/api/run', async (req, res) => {
  const graph = req.body?.graph;
  const triggerInput = req.body?.triggerInput || '';
  if (!graph || !Array.isArray(graph.nodes)) {
    return res.status(400).json({ error: '缺少 graph' });
  }
  const runP = orch.run(graph, { triggerInput });
  runP.catch(() => {});
  res.json({ started: true, mode: llm.name });
  void runP;
});

app.get('/api/runs', (_req, res) => {
  res.json({ runs: orch.history.slice(0, 20), mode: llm.name });
});

// ---- SSE ----

const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(frame);
}

for (const ev of ['run-start', 'node-status', 'run-end', 'run-error']) {
  orch.on(ev, (payload) => broadcast(ev, payload));
}

app.listen(PORT, () => {
  console.log(`MVP canvas server: http://127.0.0.1:${PORT}`);
});

function defaultGraph() {
  // 并行分支示例：报修单输入 → (工单整理 | 快速分派) → 工单输出
  return {
    nodes: [
      {
        id: 'n_input',
        type: 'input',
        position: { x: 60, y: 220 },
        data: {
          label: '报修单输入',
          text: '3栋2单元501室 张先生 13800001111：厨房水槽下水缓慢已有三天，偶尔返味，希望尽快上门查看。',
          attachments: [],
        },
      },
      {
        id: 'n_agent1',
        type: 'agent',
        position: { x: 380, y: 100 },
        data: {
          label: '工单整理',
          prompt: '你是物业客服助手。把上游的报修信息整理为规范工单：提取报修人、联系方式、位置、故障描述、紧急程度（低/中/高）。用简洁的文本输出。',
          tools: [],
        },
      },
      {
        id: 'n_agent2',
        type: 'agent',
        position: { x: 380, y: 360 },
        data: {
          label: '分派建议',
          prompt: '你是物业维修调度助手。根据上游报修信息判断应派单的维修工种（水电/管道/土建等）、建议上门时间段和需要携带的工具材料。简要输出。',
          tools: [],
        },
      },
      {
        id: 'n_output',
        type: 'output',
        position: { x: 720, y: 230 },
        data: { label: '工单输出' },
      },
    ],
    edges: [
      { id: 'e1', source: 'n_input', target: 'n_agent1' },
      { id: 'e2', source: 'n_input', target: 'n_agent2' },
      { id: 'e3', source: 'n_agent1', target: 'n_output' },
      { id: 'e4', source: 'n_agent2', target: 'n_output' },
    ],
  };
}
