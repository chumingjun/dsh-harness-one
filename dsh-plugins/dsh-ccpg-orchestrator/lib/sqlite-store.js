import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { normalizeRunDocument } from './run-results.js';
import { normalizeWorkflowDocument } from './workflow-document.js';

const SCHEMA_VERSION = 3;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    node_count INTEGER NOT NULL,
    agent_count INTEGER NOT NULL,
    document_json TEXT NOT NULL CHECK (json_valid(document_json))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workflows_updated_at ON workflows(updated_at DESC);

  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    workflow_id TEXT,
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    document_json TEXT NOT NULL CHECK (json_valid(document_json))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS runs_workflow_started_at ON runs(workflow_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS artifact_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS artifact_comments_scope ON artifact_comments(run_id, node_id, artifact_id, id);

  CREATE TABLE IF NOT EXISTS artifact_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    revision_run_id TEXT,
    name TEXT,
    summary TEXT,
    file_name TEXT,
    content TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS artifact_revisions_scope ON artifact_revisions(target_run_id, node_id, artifact_id, id);
`;

const jsonFiles = (dir) => {
  try { return readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); }
  catch { return []; }
};

const atomicJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
};

const parseDocument = (row, normalize) => normalize(JSON.parse(row.document_json));

export class WorkflowSqliteStore {
  constructor({ databaseFile, workflowsDir, runsDir, workflowTombstoneDir, migrationErrorFile, logger } = {}) {
    if (!databaseFile) throw new Error('缺少 SQLite 数据库路径');
    mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
    chmodSync(dirname(databaseFile), 0o700);
    this.databaseFile = databaseFile;
    this.logger = logger;
    this.db = new DatabaseSync(databaseFile);
    this.closed = false;
    try {
      chmodSync(databaseFile, 0o600);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA auto_vacuum = INCREMENTAL;');
      this.#configureJournal();
      this.#migrate({ workflowsDir, runsDir, workflowTombstoneDir, migrationErrorFile });
      this.#prepare();
    } catch (error) {
      try { this.db.close(); } catch { /* initialization failed before close */ }
      this.closed = true;
      throw error;
    }
  }

  #configureJournal() {
    try {
      const mode = String(this.db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode || '').toLowerCase();
      if (mode === 'wal') return;
      this.logger?.warn?.(`Workflow One SQLite 未启用 WAL（实际为 ${mode || 'unknown'}），回退 DELETE journal`);
    } catch (error) {
      this.logger?.warn?.(`Workflow One SQLite 启用 WAL 失败，回退 DELETE journal：${error.message}`);
    }
    this.db.exec('PRAGMA journal_mode = DELETE');
  }

  #migrate({ workflowsDir, runsDir, workflowTombstoneDir, migrationErrorFile }) {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (version > SCHEMA_VERSION) throw new Error(`不支持的 Workflow One SQLite schema：${version}`);
    if (version === SCHEMA_VERSION) return;

    // v3：artifact_revisions.revision_run_id 放开 NOT NULL（手工编辑修订无改写 run）。
    // SQLite 不能 ALTER 删列约束——检测到旧约束时重建该表（评论/修订是小表，整搬可忽略）。
    if (version >= 1 && version < 3) {
      const legacyConstraint = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifact_revisions'").get()
        ?.sql?.includes('revision_run_id TEXT NOT NULL');
      if (legacyConstraint) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec(`CREATE TABLE artifact_revisions_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            artifact_id TEXT NOT NULL,
            revision_run_id TEXT,
            name TEXT,
            summary TEXT,
            file_name TEXT,
            content TEXT,
            created_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO artifact_revisions_v3 (id, target_run_id, node_id, artifact_id, revision_run_id, name, summary, file_name, content, created_at)
            SELECT id, target_run_id, node_id, artifact_id, revision_run_id, name, summary, file_name, content, created_at FROM artifact_revisions;
          DROP TABLE artifact_revisions;
          ALTER TABLE artifact_revisions_v3 RENAME TO artifact_revisions;
          CREATE INDEX IF NOT EXISTS artifact_revisions_scope ON artifact_revisions(target_run_id, node_id, artifact_id, id);`);
          this.db.exec('COMMIT');
        } catch (error) {
          try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
          throw error;
        }
      }
    }

    // JSON 目录重导只在 legacy → SQLite（0→N）时做；已有库小版本升级（如 1→2 加表）只执行 DDL，
    // 否则陈旧的迁移源 JSON 会 upsert 覆盖库内更新的数据。
    if (version > 0) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
        throw error;
      }
      return;
    }

    const workflows = [];
    const runs = [];
    const errors = [];
    for (const name of jsonFiles(workflowsDir)) {
      const file = join(workflowsDir, name);
      const id = basename(name, '.json');
      if (workflowTombstoneDir && existsSync(join(workflowTombstoneDir, id))) continue;
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工作流文档必须是对象');
        const updatedAt = raw.updatedAt || statSync(file).mtime.toISOString();
        const document = normalizeWorkflowDocument({ ...raw, id: raw.id || id, name: raw.name || id, updatedAt });
        if (!document.id || !document.name || !document.updatedAt) throw new Error('缺少 id、name 或 updatedAt');
        workflows.push(document);
      } catch (error) {
        errors.push({ kind: 'workflow', file, error: String(error.message || error) });
      }
    }
    for (const name of jsonFiles(runsDir)) {
      const file = join(runsDir, name);
      const runId = basename(name, '.json');
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运行文档必须是对象');
        const document = normalizeRunDocument({ ...raw, runId: raw.runId || runId });
        if (!document.runId || !document.status) throw new Error('缺少 runId 或 status');
        runs.push({ document, updatedAt: statSync(file).mtime.toISOString() });
      } catch (error) {
        errors.push({ kind: 'run', file, error: String(error.message || error) });
      }
    }

    if (migrationErrorFile && errors.length) {
      atomicJson(migrationErrorFile, { version: 1, migratedAt: new Date().toISOString(), errors });
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(SCHEMA);
      const putWorkflow = this.db.prepare(`
        INSERT INTO workflows (id, name, updated_at, node_count, agent_count, document_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, updated_at=excluded.updated_at,
          node_count=excluded.node_count, agent_count=excluded.agent_count,
          document_json=excluded.document_json
      `);
      const putRun = this.db.prepare(`
        INSERT INTO runs (run_id, workflow_id, status, started_at, finished_at, updated_at, document_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          workflow_id=excluded.workflow_id, status=excluded.status,
          started_at=excluded.started_at, finished_at=excluded.finished_at,
          updated_at=excluded.updated_at, document_json=excluded.document_json
      `);
      for (const document of workflows) this.#runWorkflowStatement(putWorkflow, document);
      for (const row of runs) this.#runRunStatement(putRun, row.document, row.updatedAt);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }

    if (migrationErrorFile && !errors.length) {
      try {
        unlinkSync(migrationErrorFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') this.logger?.warn?.(`SQLite 迁移报告清理失败：${error.message}`);
      }
    }
    for (const error of errors) this.logger?.warn?.(`SQLite 跳过损坏的 ${error.kind} JSON：${error.file}（${error.error}）`);
  }

  #prepare() {
    this.statements = {
      getWorkflow: this.db.prepare('SELECT document_json FROM workflows WHERE id = ?'),
      listWorkflows: this.db.prepare('SELECT id, name, updated_at, node_count, agent_count FROM workflows ORDER BY updated_at DESC, id ASC'),
      putWorkflow: this.db.prepare(`
        INSERT INTO workflows (id, name, updated_at, node_count, agent_count, document_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, updated_at=excluded.updated_at,
          node_count=excluded.node_count, agent_count=excluded.agent_count,
          document_json=excluded.document_json
      `),
      deleteWorkflow: this.db.prepare('DELETE FROM workflows WHERE id = ?'),
      getRun: this.db.prepare('SELECT updated_at, document_json FROM runs WHERE run_id = ?'),
      listRuns: this.db.prepare('SELECT document_json FROM runs ORDER BY started_at DESC, run_id DESC LIMIT ?'),
      listRunsForWorkflow: this.db.prepare('SELECT document_json FROM runs WHERE workflow_id = ? ORDER BY started_at DESC, run_id DESC LIMIT ?'),
      putRun: this.db.prepare(`
        INSERT INTO runs (run_id, workflow_id, status, started_at, finished_at, updated_at, document_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          workflow_id=excluded.workflow_id, status=excluded.status,
          started_at=excluded.started_at, finished_at=excluded.finished_at,
          updated_at=excluded.updated_at, document_json=excluded.document_json
      `),
      staleRuns: this.db.prepare('SELECT run_id, workflow_id FROM runs ORDER BY started_at DESC, run_id DESC LIMIT -1 OFFSET ?'),
      deleteRun: this.db.prepare('DELETE FROM runs WHERE run_id = ?'),
      addComment: this.db.prepare('INSERT INTO artifact_comments (run_id, node_id, artifact_id, body, created_at) VALUES (?, ?, ?, ?, ?)'),
      getComment: this.db.prepare('SELECT id, run_id, node_id, artifact_id, body, created_at FROM artifact_comments WHERE id = ?'),
      listComments: this.db.prepare('SELECT id, run_id, node_id, artifact_id, body, created_at FROM artifact_comments WHERE run_id = ? ORDER BY id ASC'),
      deleteComment: this.db.prepare('DELETE FROM artifact_comments WHERE id = ?'),
      deleteCommentsForRun: this.db.prepare('DELETE FROM artifact_comments WHERE run_id = ?'),
      addRevision: this.db.prepare(`INSERT INTO artifact_revisions
        (target_run_id, node_id, artifact_id, revision_run_id, name, summary, file_name, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      listRevisions: this.db.prepare('SELECT * FROM artifact_revisions WHERE target_run_id = ? ORDER BY id ASC'),
      deleteRevisionsForRun: this.db.prepare('DELETE FROM artifact_revisions WHERE target_run_id = ?'),
      revisionRunIds: this.db.prepare('SELECT DISTINCT revision_run_id FROM artifact_revisions'),
    };
  }

  #runWorkflowStatement(statement, value) {
    const document = normalizeWorkflowDocument(value);
    if (!document.id || !document.name || !document.updatedAt) throw new Error('工作流缺少 id、name 或 updatedAt');
    const nodes = Array.isArray(document.graph?.nodes) ? document.graph.nodes : [];
    statement.run(
      document.id,
      document.name,
      document.updatedAt,
      nodes.length,
      nodes.filter((node) => node.type === 'agent').length,
      JSON.stringify(document),
    );
    return document;
  }

  #runRunStatement(statement, value, updatedAt = new Date().toISOString()) {
    const document = normalizeRunDocument(value);
    if (!document.runId || !document.status) throw new Error('运行记录缺少 runId 或 status');
    statement.run(
      document.runId,
      document.workflowId || null,
      document.status,
      document.startedAt,
      document.finishedAt,
      updatedAt,
      JSON.stringify(document),
    );
    return document;
  }

  getWorkflow(id) {
    const row = this.statements.getWorkflow.get(String(id));
    return row ? parseDocument(row, normalizeWorkflowDocument) : null;
  }

  listWorkflows() {
    return this.statements.listWorkflows.all().map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at,
      nodeCount: row.node_count,
      agentCount: row.agent_count,
    }));
  }

  putWorkflow(value) {
    return this.#runWorkflowStatement(this.statements.putWorkflow, value);
  }

  deleteWorkflow(id) {
    return Number(this.statements.deleteWorkflow.run(String(id)).changes) > 0;
  }

  getRun(id) {
    return this.getRunRecord(id)?.document || null;
  }

  getRunRecord(id) {
    const row = this.statements.getRun.get(String(id));
    return row ? { document: parseDocument(row, normalizeRunDocument), updatedAt: row.updated_at } : null;
  }

  listRuns(limit = 50, workflowId) {
    const count = Math.max(0, Math.floor(Number(limit) || 0));
    // workflowId 过滤命中 runs_workflow_started_at 索引；缺省（含 null/草稿）保持全量行为
    const statement = workflowId ? this.statements.listRunsForWorkflow : this.statements.listRuns;
    const rows = workflowId ? statement.all(String(workflowId), count) : statement.all(count);
    return rows.map((row) => parseDocument(row, normalizeRunDocument));
  }

  putRun(value) {
    return this.#runRunStatement(this.statements.putRun, value);
  }

  pruneRuns(keep, { keepRevisionRuns = [] } = {}) {
    const count = Math.max(0, Math.floor(Number(keep) || 0));
    const protectedIds = new Set(keepRevisionRuns.map(String));
    const stale = this.statements.staleRuns.all(count)
      .map((row) => ({ runId: row.run_id, workflowId: row.workflow_id }))
      .filter((row) => !protectedIds.has(row.runId));
    if (!stale.length) return stale;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of stale) {
        this.deleteRunData(row.runId);
        this.statements.deleteRun.run(row.runId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
    try { this.db.exec('PRAGMA incremental_vacuum(1000)'); } catch { /* 回收失败不影响已提交删除 */ }
    return stale;
  }

  // ---- 产物评论与修订（run 文档之外的用户数据；见 issue #97）----

  addArtifactComment({ runId, nodeId, artifactId, body, createdAt }) {
    const created = createdAt || new Date().toISOString();
    const info = this.statements.addComment.run(String(runId), String(nodeId), String(artifactId), String(body ?? ''), created);
    return this.getArtifactComment(Number(info.lastInsertRowid));
  }

  getArtifactComment(id) {
    return this.statements.getComment.get(Number(id)) || null;
  }

  listArtifactComments(runId) {
    return this.statements.listComments.all(String(runId));
  }

  deleteArtifactComment(id) {
    return Number(this.statements.deleteComment.run(Number(id)).changes) > 0;
  }

  addArtifactRevision({ targetRunId, nodeId, artifactId, revisionRunId, name, summary, fileName, content, createdAt }) {
    const created = createdAt || new Date().toISOString();
    const info = this.statements.addRevision.run(
      String(targetRunId), String(nodeId), String(artifactId),
      revisionRunId == null ? null : String(revisionRunId),
      name == null ? null : String(name),
      summary == null ? null : String(summary),
      fileName == null ? null : String(fileName),
      content == null ? null : String(content),
      created,
    );
    return Number(info.lastInsertRowid);
  }

  listArtifactRevisions(targetRunId) {
    return this.statements.listRevisions.all(String(targetRunId));
  }

  revisionRunIds() {
    return this.statements.revisionRunIds.all().map((row) => row.revision_run_id);
  }

  // run 记录删除时级联清理其评论与修订；修订正文所引用的改写 run 由调用方按 revisionRunIds 决策
  deleteRunData(runId) {
    this.statements.deleteCommentsForRun.run(String(runId));
    this.statements.deleteRevisionsForRun.run(String(runId));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* DELETE journal 或已关闭 */ }
    this.db.close();
  }
}
