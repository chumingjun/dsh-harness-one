import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../lib/index.js';

function responseCapture() {
  return {
    status: 0,
    chunks: [],
    writableEnded: false,
    writeHead(status) { this.status = status; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
    on() { return this; },
    destroy(error) { if (error) throw error; },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8') || '{}'); },
  };
}

function request(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

const withSession = (url, sessionId) => `${url}${url.includes('?') ? '&' : '?'}sessionId=${sessionId}`;
const databaseFile = (workspace) => join(workspace, '.workflow-one', 'workflow-one.sqlite');
const readStoredRun = (workspace, runId) => {
  if (!existsSync(databaseFile(workspace))) return null;
  const db = new DatabaseSync(databaseFile(workspace), { readOnly: true });
  try {
    const row = db.prepare('SELECT document_json FROM runs WHERE run_id = ?').get(runId);
    return row ? JSON.parse(row.document_json) : null;
  } finally {
    db.close();
  }
};

const dshHome = mkdtempSync(join(tmpdir(), 'wf1-fbhome-'));
const workspacesRoot = mkdtempSync(join(tmpdir(), 'wf1-fbws-'));
const workspace = join(workspacesRoot, 'ws');
mkdirSync(workspace, { recursive: true });
const originalDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;
const packageLegacyDir = join(dshHome, 'package-legacy');
mkdirSync(join(packageLegacyDir, 'state'), { recursive: true });
process.env.WF1_LEGACY_DATA_DIR = packageLegacyDir;
writeFileSync(join(packageLegacyDir, 'state', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));

const disposers = [];
try {
  const routes = [];
  const sessionMap = new Map([['session-1', { header: { cwd: workspace } }]]);
  const ctx = {
    webServer: { register(route) { routes.push(route); } },
    tools: { register() {}, schemas() { return []; } },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessionMap.get(String(id)), flush: async () => {} };
      if (name === 'workspaceRegistry') return { list: () => [{ path: workspace }] };
      return null;
    },
    skills: { async list() { return []; } },
    llm: { listProviders() { return []; }, async listModels() { return []; } },
    agentPresets: { async mount() {} },
    logger: { info() {}, warn() {}, error() {} },
    effect(setup) { const dispose = setup(); if (dispose) disposers.push(dispose); },
  };
  apply(ctx, {});
  const route = (path) => routes.find((entry) => entry.kind === 'exact' && entry.path === path)?.handler;
  const call = async (method, url, body) => {
    const res = responseCapture();
    await route(url.split('?')[0])(request(method, withSession(url, 'session-1'), body), res);
    return { status: res.status, body: res.json() };
  };

  // ---- 准备：先经任一 API 触发 store 初始化，再 seed 一个带产物文件的成功 run ----
  {
    const warm = responseCapture();
    await route('/wf1/api/runs')(request('GET', withSession('/wf1/api/runs', 'session-1')), warm);
    assert.equal(warm.status, 200);
  }
  const inputRun = {
    runId: 'run_fb_src', workflowId: 'wf_fb', status: 'success',
    startedAt: '2026-08-10T00:00:00.000Z', finishedAt: '2026-08-10T00:00:02.000Z',
    triggerInput: '', outputs: { n_input: 'ok' }, structuredOutputs: {},
    nodeStates: { n_input: { status: 'success' } },
    artifactIndex: [{ id: 'art_report', nodeId: 'n_input', name: '巡检报告.md', snapshot: 'run_fb_src/art_report', relativePath: '巡检报告.md', previewable: true, size: 10, mediaType: 'text/markdown' }],
    schemaVersion: 3,
  };
  {
    const db = new DatabaseSync(databaseFile(workspace));
    try {
      db.prepare(`INSERT INTO runs (run_id, workflow_id, status, started_at, finished_at, updated_at, document_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET document_json=excluded.document_json`)
        .run(inputRun.runId, inputRun.workflowId, inputRun.status, inputRun.startedAt, inputRun.finishedAt, new Date().toISOString(), JSON.stringify(inputRun));
    } finally { db.close(); }
  }
  // 产物快照文件（resolveRunArtifact 按 snapshot 路径在 artifacts 目录下找）
  const artifactDir = join(workspace, '.workflow-one', 'runtime');
  mkdirSync(join(artifactDir), { recursive: true });
  {
    const { hashedKey } = await import('../lib/storage-paths.js');
    const runDir = join(artifactDir, hashedKey('wf_fb'), hashedKey('run_fb_src'), 'artifacts', 'run_fb_src');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'art_report'), '# 巡检报告\n正文…');
  }
  const batchRun = {
    runId: 'run_fb_batch', workflowId: 'wf_fb', status: 'success',
    startedAt: '2026-08-11T00:00:00.000Z', finishedAt: '2026-08-11T00:00:02.000Z',
    nodeStates: { n_batch: { status: 'success', artifacts: ['reports/nested.md'] } },
    artifactIndex: [{ id: 'art_nested', nodeId: 'n_batch', name: 'nested.md', relativePath: 'reports/nested.md', snapshot: 'run_fb_batch/art_nested', previewable: true, size: 14, mediaType: 'text/markdown' }],
    schemaVersion: 3,
  };
  {
    const db = new DatabaseSync(databaseFile(workspace));
    try {
      db.prepare(`INSERT INTO runs (run_id, workflow_id, status, started_at, finished_at, updated_at, document_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET document_json=excluded.document_json`)
        .run(batchRun.runId, batchRun.workflowId, batchRun.status, batchRun.startedAt, batchRun.finishedAt, new Date().toISOString(), JSON.stringify(batchRun));
    } finally { db.close(); }
  }
  {
    const { hashedKey } = await import('../lib/storage-paths.js');
    const runDir = join(artifactDir, hashedKey('wf_fb'), hashedKey('run_fb_batch'), 'artifacts', 'run_fb_batch');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'art_nested'), '# 快照正文');
    const workspaceDir = join(workspace, '.workflow-one', 'runtime', hashedKey('wf_fb'), hashedKey('run_fb_batch'), 'nodes', hashedKey('n_batch'), 'workspace', 'reports');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, 'nested.md'), '# 工作区旧正文');
  }

  console.log('feedback api integration tests:');

  // 批量正文优先读 immutable snapshot，并保留嵌套路径与 artifactId 定位
  {
    const res = await call('POST', '/wf1/api/artifacts/content', {
      runId: 'run_fb_batch', items: [{ node: 'n_batch', file: 'reports/nested.md', artifactId: 'art_nested' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.files[`n_batch\u0000reports/nested.md`].content, '# 快照正文');
  }
  // 批量正文区分缺失文件
  {
    const res = await call('POST', '/wf1/api/artifacts/content', {
      runId: 'run_fb_batch', items: [{ node: 'n_batch', file: 'missing.md' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.files[`n_batch\u0000missing.md`].missing, true);
  }

  console.log('feedback api integration tests:');

  // 评论 404：run 不存在
  {
    const res = await call('POST', '/wf1/api/comments/add', { runId: 'run_nope', nodeId: 'n_input', artifactId: 'art_report', body: 'x' });
    assert.equal(res.status, 404);
  }
  // 评论写入 + 列表
  {
    const res = await call('POST', '/wf1/api/comments/add', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: 'art_report', body: '语气太随意' });
    assert.equal(res.status, 200);
    assert.equal(res.body.comment.body, '语气太随意');
    const list = await call('GET', '/wf1/api/comments?runId=run_fb_src');
    assert.equal(list.status, 200);
    assert.equal(list.body.comments.length, 1);
    assert.equal(list.body.revisions.length, 0);
  }
  // 空评论 400
  {
    const res = await call('POST', '/wf1/api/comments/add', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: 'art_report', body: '   ' });
    assert.equal(res.status, 400);
  }
  // revise：产物解析失败 → 404（用不存在的 artifactId）
  {
    const res = await call('POST', '/wf1/api/artifacts/revise', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: '不存在.md' });
    assert.equal(res.status, 404);
  }
  // revise：run 不存在 → 404
  {
    const res = await call('POST', '/wf1/api/artifacts/revise', { runId: 'run_nope', nodeId: 'n_input', artifactId: 'art_report' });
    assert.equal(res.status, 404);
  }
  // revise happy path：起改写 run（agent 在测试 ctx 下必然失败，但 run 要落盘、revises 保留、原稿已复制）
  let revisionRunId;
  {
    const add = await call('POST', '/wf1/api/comments/add', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: 'art_report', body: '改正式些' });
    assert.equal(add.status, 200);
    const res = await call('POST', '/wf1/api/artifacts/revise', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: 'art_report', instruction: '保持结构' });
    assert.equal(res.status, 200);
    revisionRunId = res.body.revisionRunId;
    assert.ok(revisionRunId);
    let stored;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stored = readStoredRun(workspace, revisionRunId);
      if (stored && stored.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(stored, '改写 run 已落盘');
    assert.equal(stored.source, 'revision');
    assert.deepEqual(stored.revises, { runId: 'run_fb_src', nodeId: 'n_input', artifactId: '巡检报告.md' });
    // 原 run 文档不可变红线：源 run 产物与字段未被改写
    const src = readStoredRun(workspace, 'run_fb_src');
    assert.equal(src.artifactIndex.length, 1);
    assert.equal(src.artifactIndex[0].id, 'art_report');
    assert.equal(src.source == null, true);
  }
  // 原稿已复制进改写节点工作区，并使用输入专用文件名，避免被收集为修订产物
  {
    const { hashedKey } = await import('../lib/storage-paths.js');
    const revisionWs = join(workspace, '.workflow-one', 'runtime', hashedKey('wf_fb'), hashedKey(revisionRunId), 'nodes', hashedKey('revision_agent'), 'workspace');
    assert.equal(existsSync(join(revisionWs, '__wf1_original__巡检报告.md')), true, '原稿已复制进改写 agent 工作区');
    assert.equal(existsSync(join(revisionWs, '巡检报告.md')), false, '原稿副本不占用修订输出文件名');
  }
  // revision run 不进 /runs 列表
  {
    const res = await call('GET', '/wf1/api/runs?limit=50');
    assert.equal(res.body.runs.some((r) => r.runId === revisionRunId), false, '改写 run 不作为独立运行条目');
    assert.equal(res.body.runs.some((r) => r.runId === 'run_fb_src'), true);
  }
  // 改写 run 不能再发起改写
  {
    const res = await call('POST', '/wf1/api/artifacts/revise', { runId: revisionRunId, nodeId: 'revision_agent', artifactId: 'art_report' });
    assert.equal(res.status, 400);
  }
  // 手工编辑：非文本产物拒绝（造一个 .png 索引项）
  {
    const db = new DatabaseSync(databaseFile(workspace));
    try {
      const doc = JSON.parse(db.prepare('SELECT document_json FROM runs WHERE run_id = ?').get('run_fb_src').document_json);
      doc.artifactIndex.push({ id: 'art_pic', nodeId: 'n_input', name: '现场照片.png', snapshot: 'run_fb_src/art_pic', relativePath: '现场照片.png', previewable: false, size: 5, mediaType: 'image/png' });
      db.prepare('UPDATE runs SET document_json = ? WHERE run_id = ?').run(JSON.stringify(doc), 'run_fb_src');
    } finally { db.close(); }
    const res = await call('POST', '/wf1/api/artifacts/save', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: 'art_pic', content: 'not text' });
    assert.equal(res.status, 415);
  }
  // 手工编辑 happy path：落 origin=manual 修订进版本链，revision_run_id 为空
  {
    const res = await call('POST', '/wf1/api/artifacts/save', {
      runId: 'run_fb_src', nodeId: 'n_input', artifactId: 'art_report',
      content: '# 巡检报告（手工修订）\n用户直接补充的内容。',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.revisionId > 0);
    const list = await call('GET', '/wf1/api/comments?runId=run_fb_src');
    const manual = list.body.revisions.find((r) => r.revision_run_id == null);
    assert.ok(manual, '手工修订已入版本链');
    assert.equal(manual.summary, '手工编辑');
    assert.equal(manual.content, '# 巡检报告（手工修订）\n用户直接补充的内容。');
    assert.equal(manual.artifact_id, '巡检报告.md');
  }
  // 手工编辑校验：空内容 400 / 产物不存在 404 / run 不存在 404
  {
    assert.equal((await call('POST', '/wf1/api/artifacts/save', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: 'art_report', content: '  ' })).status, 400);
    assert.equal((await call('POST', '/wf1/api/artifacts/save', { runId: 'run_fb_src', nodeId: 'n_input', artifactId: '不存在.md', content: 'x' })).status, 404);
    assert.equal((await call('POST', '/wf1/api/artifacts/save', { runId: 'run_nope', nodeId: 'n_input', artifactId: 'art_report', content: 'x' })).status, 404);
  }
  // 手工修订不改 run 文档（不可变红线）：源 run 快照仍只有原始索引（去掉测试注入的 png 前）
  {
    const src = readStoredRun(workspace, 'run_fb_src');
    assert.equal(src.artifactIndex.some((a) => a.id === 'art_report'), true);
    assert.equal(src.source == null || src.source !== 'revision', true);
  }
  // 删除评论（清空全部两条）
  {
    const list = await call('GET', '/wf1/api/comments?runId=run_fb_src');
    assert.equal(list.body.comments.length, 2);
    for (const comment of list.body.comments) {
      const res = await call('POST', '/wf1/api/comments/delete', { id: comment.id });
      assert.equal(res.status, 200);
    }
    const after = await call('GET', '/wf1/api/comments?runId=run_fb_src');
    assert.equal(after.body.comments.length, 0);
  }

  console.log('\nintegration tests passed');
} catch (error) {
  console.error(`  ✗\n    ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  for (const dispose of disposers) {
    try { dispose(); } catch { /* 清理尽力而为 */ }
  }
  process.env.DSH_HOME = originalDshHome;
  rmSync(workspacesRoot, { recursive: true, force: true });
  rmSync(dshHome, { recursive: true, force: true });
}
