import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { apply, Config, inject } from '../lib/index.js';
import * as schemePlugin from '../lib/index.js';
import { createProject, registerMaterial, prepareChapter, submitChapter, createDeliverySnapshot, SchemeStore } from '../lib/core.js';
import { MATERIAL_PARSER_VERSION } from '../lib/materials.js';
const JSZip = createRequire(new URL('../../dsh-ccpg-document-preview/package.json', import.meta.url))('jszip');

const session = (cwd) => ({ connection: {
  admit(req) { return req.headers?.['x-test-unauthenticated'] ? { rejection: 401 } : { peer: { id: 'test-browser' } }; },
  authenticatedUrl(value) { const url = new URL(value); url.searchParams.set('token', 'test-token'); return url.href; },
  authorizeIndex(req, res) {
    assert.ok(req.headers?.host, 'native authentication requires the request authority');
    const url = new URL(req.url, 'http://test.local');
    if (url.searchParams.get('token') === 'test-token') { res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth=test; Path=/' }); res.end(); return false; }
    if (req.headers?.cookie === 'dsh-auth=test') return true;
    res.statusCode = 401; res.end('unauthorized'); return false;
  },
}, get(key) { assert.equal(key, 'sessions'); return { get() { return { header: { cwd } }; } }; } });

test('browser authentication preserves prototype-backed HTTP headers for token exchange and cookie reads', async () => {
  const routes = [];
  apply({ ...session('/tmp'), tools: { register() {}, guard() {} }, webServer: { register(route) { routes.push(route); } } });
  const route = routes.find((route) => route.path === '/ccpg-scheme/results');
  for (const [query, cookie, status] of [['?token=test-token', '', 303], ['', 'dsh-auth=test', 200]]) {
    const req = new IncomingMessage(new Socket());
    req.method = 'GET'; req.url = `/ccpg-scheme/results${query}`;
    req.headers = { host: 'localhost', cookie };
    assert.equal(Object.hasOwn(req, 'headers'), false);
    const res = { statusCode: 0, setHeader() {}, writeHead(value) { this.statusCode = value; }, end() {} };
    try {
      await route.handler(req, res);
      assert.equal(res.statusCode, status);
    } finally { req.destroy(); }
  }
});

test('native submission schema declares the exact attachment and evidence fields', () => {
  const tools = [];
  apply({ ...session('/tmp'), tools: { register(tool) { tools.push(tool); }, guard() {} }, webServer: { register() {} } });
  const submit = tools.find((tool) => tool.name === 'chapter_submit');
  const attachment = submit.parameters.properties.attachments.items;
  assert.equal(attachment.properties.outputId.type, 'string');
  assert.equal(attachment.properties.name.type, 'string');
  assert.equal(attachment.properties.contentPath.type, 'string');
  assert.deepEqual(attachment.required, ['outputId', 'name']);
  assert.equal(submit.parameters.properties.evidence.items.properties.source.type, 'string');
});

test('native ToolRuntime submits a saved chapter and Chinese-named attachment with exact output IDs', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-native-attachment-')); const cwd = join(base, 'project'); const rules = join(base, 'rules');
  await mkdir(cwd); await mkdir(join(rules, 'skills/one'), { recursive: true });
  await writeFile(join(rules, 'skills/one/SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const outputs = [{ id: '4.1', kind: 'body' }, { id: '4.2.1', name: '物业服务项目标准及服务承诺', kind: 'attachment' }];
  await mkdir(join(rules, 'skills/two'), { recursive: true });
  await writeFile(join(rules, 'skills/two/SKILL.md'), 'two'); await writeFile(join(rules, 'skills/two/knowledge.md'), 'Future chapter knowledge.');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'test', version: '1', chapters: [
    { id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs, blockers: [] },
    { id: 'two', title: 'Two', order: 2, skill: 'skills/two/SKILL.md', dependencies: ['one'], inputs: [], outputs: [{ id: '5', kind: 'body' }], blockers: [] },
  ], resources: [{ path: 'skills/two/knowledge.md', sha256: createHash('sha256').update('Future chapter knowledge.').digest('hex') }], dataMappings: {} }));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const ctx = new Context();
  for (const [key, value] of Object.entries({
    systemPrompt: { tools() {}, section() {}, getSectionOrder() { return 0; } },
    sessions: { get() { return { header: { cwd } }; } }, webServer: { register() {} }, approval: {}, commands: { register() {} }, connection: {},
  })) { ctx.provide(key); ctx.set(key, value); }
  const runtime = new ToolRuntime(ctx); const mounted = await ctx.plugin(schemePlugin, {}); t.after(() => mounted.dispose());
  const agent = { ctx, session: { id: 'native-submit', header: { cwd } } };
  let call = 0;
  const invoke = (name, args) => runtime.execute({ name, arguments: { projectId: 'p', ...args }, agent, callId: `submit-${++call}`, signal: new AbortController().signal });
  const prepared = await invoke('chapter_prepare', { chapterId: 'one' });
  assert.equal(prepared.isError, false, JSON.stringify(prepared));
  const ready = JSON.parse(prepared.value);
  assert.deepEqual(ready.outputs, outputs);
  assert.equal(ready.skillName, 'one');
  assert.equal(ready.skillPath, '.dsh/skills/one/SKILL.md');
  assert.equal(ready.skillSource, 'project-dsh');
  await writeFile(join(cwd, ready.draftPath), '# Quality targets\nComplete saved body.');
  const contentPath = 'materials/notes/4.2.1-服务承诺.md'; const content = '# 服务承诺\n\n|条线|承诺|\n|---|---|\n|工程|按有效约定|';
  await writeFile(join(cwd, contentPath), content);
  const invalid = await invoke('chapter_submit', { token: ready.token, bodyPath: ready.draftPath, attachments: [{ id: '4.2.1', name: '服务承诺.md', contentPath }] });
  assert.equal(invalid.isError, true);
  assert.equal(project.reload().chapters.one.status, 'prepared');
  const premature = await invoke('material_parse', { sourcePath: '.dsh/skills/two/knowledge.md' });
  assert.equal(premature.isError, true);
  assert.match(premature.error?.message || JSON.stringify(premature), /finish current chapter/);
  const done = await invoke('chapter_submit', { token: ready.token, bodyPath: ready.draftPath, attachments: [{ outputId: '4.2.1', name: '服务承诺.md', contentPath }] });
  assert.equal(done.isError, false, JSON.stringify(done));
  const artifact = await (await import('../lib/core.js')).readChapterArtifact(project, 'one');
  assert.equal(artifact.body, '# Quality targets\nComplete saved body.');
  assert.deepEqual(artifact.attachments, [{ outputId: '4.2.1', name: '服务承诺.md', content }]);
  assert.equal((await invoke('material_parse', { sourcePath: '.dsh/skills/two/knowledge.md' })).isError, false);
});

test('native results service reads the current workspace without HTTP cookies or session commands', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-native-results-'));
  const cwd = join(base, 'project'); const empty = join(base, 'empty');
  await mkdir(cwd); await mkdir(empty);
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: new URL('../rules/', import.meta.url).pathname });
  const ready = await prepareChapter(project, { chapterId: 'chapter-1' });
  await submitChapter(project, { token: ready.token, body: 'Saved chapter.' });
  await mkdir(join(cwd, '.ccpg-scheme/publications'), { recursive: true });
  await writeFile(join(cwd, '.ccpg-scheme/publications/native-history.ndjson'), [
    { event: 'snapshot', operationId: 'native-history', scope: 'chapter-1', contentDigest: 'saved', chapters: [{ chapterId: 'chapter-1', artifactId: project.state.chapters['chapter-1'].artifactId, revision: 1 }] },
    { event: 'receipt', operationId: 'native-history', step: 'delivery', at: '2026-10-12T00:00:00Z', status: 'published', result: { verified: true, body: { token: 'original', url: 'https://example.feishu.cn/docx/original', content: 'private remote text' }, folder: { token: 'folder', url: 'https://example.feishu.cn/drive/folder/folder' } } },
  ].map(JSON.stringify).join('\n'));
  const ctx = new Context(); const commands = [];
  for (const [key, value] of Object.entries({
    tools: { register() {}, guard() {} }, webServer: { register() {}, registerUpgrade() {} }, approval: {},
    commands: { register(command) { commands.push(command); } }, connection: { rpc: { intercept() {} } },
    sessions: { get(id) { return ['native', 'empty'].includes(id) ? { header: { cwd: id === 'native' ? cwd : empty } } : undefined; } },
    sessionPersistence: { async stat(id) { return id === 'cold' ? { header: { cwd } } : undefined; } },
  })) { ctx.provide(key); ctx.set(key, value); }
  const mounted = await ctx.plugin(schemePlugin, {});
  const service = ctx.get('ccpgSchemeResults');
  assert.equal(typeof service?.read, 'function');
  const sdk = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
  const { remoteMethods } = await import(sdk.resolve('@deepseek-ai/dsh-typert-protocol'));
  assert.equal(remoteMethods(service).some((method) => method.method === 'read'), true);
  const { TypertRegistry } = await import(sdk.resolve('@deepseek-ai/dsh-typert-registry'));
  const { TypertGatewayService } = await import(sdk.resolve('@deepseek-ai/dsh-api-gateway'));
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(TypertGatewayService);
  const native = await ctx.typertGateway.invoke({ namespace: 'ccpgSchemeResults', method: 'read', args: { payload: { sessionId: 'native', action: 'status' } } });
  assert.equal(native.state.projectId, 'p');
  const signal = new AbortController().signal;
  const stateBefore = await readFile(join(cwd, '.ccpg-scheme/state.json'), 'utf8');
  const snapshot = await service.read({ sessionId: 'native', action: 'status' }, signal);
  assert.equal(snapshot.state.projectId, 'p');
  assert.equal(snapshot.publications['chapter-1'].body.url, 'https://example.feishu.cn/docx/original');
  assert(!JSON.stringify(snapshot.publications).includes('private remote text'));
  const cold = await service.read({ sessionId: 'cold', action: 'status' }, signal);
  assert.equal(cold.state.projectId, 'p');
  const artifact = await service.read({ sessionId: 'native', action: 'artifact', projectId: 'p', chapterId: 'chapter-1' }, signal);
  assert.equal(artifact.body, 'Saved chapter.');
  assert.match((await service.read({ sessionId: 'native', action: 'export', projectId: 'p' }, signal)).markdown, /Saved chapter/);
  assert.equal(await readFile(join(cwd, '.ccpg-scheme/state.json'), 'utf8'), stateBefore);
  await assert.rejects(service.read({ sessionId: 'empty', action: 'status' }, signal), /project-required/);
  await assert.rejects(service.read({ sessionId: 'unknown', action: 'status' }, signal), /session cwd/);
  await assert.rejects(service.read({ sessionId: 'native', action: 'status', projectId: 'other' }, signal), /project id/);
  await assert.rejects(service.read({ sessionId: 'native', action: 'confirm', projectId: 'p' }, signal), /read action/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(service.read({ sessionId: 'native', action: 'status' }, cancelled.signal), /cancelled/);
  await mounted.dispose();
});

test('native loader accepts config and a real Cordis mount registers bundled skills', async () => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
  const { isNativeConfigSchema } = await import(sdkRequire.resolve('@deepseek-ai/dsh-app-boot'));
  assert.equal(isNativeConfigSchema(Config), true);
  const { SkillRegistry } = await import(sdkRequire.resolve('@deepseek-ai/dsh-skill'));
  const ctx = new Context();
  const tools = [];
  for (const [key, value] of Object.entries({ tools: { register(tool) { tools.push(tool); }, guard() {} }, webServer: { register() {} }, approval: {}, commands: { register() {} }, connection: {} })) { ctx.provide(key); ctx.set(key, value); }
  const mounted = ctx.plugin(schemePlugin, {});
  await mounted;
  assert.equal(tools.some((tool) => tool.name === 'project_recover'), true);
  await ctx.plugin(SkillRegistry);
  assert.deepEqual((await ctx.skills.list()).filter((skill) => skill.provider === 'ccpg-scheme-defaults').map((skill) => skill.name).sort(), ['ccpg-scheme', 'office-docx', 'office-pptx', 'office-xlsx', 'pdf']);
  const fallback = await ctx.skills.get('office-docx', {});
  assert.match(fallback.resourceBase.path, /vendor\/dsh-skill-office\/assets\/office-docx$/);
  const office = await ctx.plugin(await import(sdkRequire.resolve('@deepseek-ai/dsh-skill-office')), { cli: false });
  const native = await ctx.skills.get('office-docx', {});
  assert.equal(native.provider, 'dsh-office');
  assert.match(native.content, /LibreOffice Kit is disabled in this deployment/);
  assert.doesNotMatch(native.content, /material_visual_read|fresh native.*subagent/);
  await office.dispose();
  await mounted.dispose();
  assert.equal((await ctx.skills.list()).length, 0);
});

test('project chapter skills are discoverable through native dsh-skill-filesystem', async () => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
  const { SkillRegistry } = await import(sdkRequire.resolve('@deepseek-ai/dsh-skill'));
  const filesystem = await import(sdkRequire.resolve('@deepseek-ai/dsh-skill-filesystem'));
  const base = await mkdtemp(join(tmpdir(), 'ccpg-native-skill-'));
  const rules = join(base, 'rules'); const cwd = join(base, 'session'); const homes = join(base, 'homes');
  await mkdir(join(rules, 'skills', 'ccpg-one'), { recursive: true }); await mkdir(cwd); await mkdir(join(homes, 'dsh'), { recursive: true }); await mkdir(join(homes, 'agents'), { recursive: true });
  await writeFile(join(rules, 'skills', 'ccpg-one', 'SKILL.md'), `---\nname: ccpg-one\ndescription: Generate the first chapter with its bundled template.\n---\nRead [the template](assets/template.md).\n`);
  await mkdir(join(rules, 'skills', 'ccpg-one', 'assets'), { recursive: true });
  await writeFile(join(rules, 'skills', 'ccpg-one', 'assets', 'template.md'), 'template');
  await writeFile(join(rules, 'AGENTS.md'), '# Rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'demo', version: '1',
    chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/ccpg-one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }],
    resources: [{ path: 'skills/ccpg-one/assets/template.md', sha256: createHash('sha256').update('template').digest('hex') }],
    dataMappings: {},
  }));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const ctx = new Context();
  for (const [key, value] of Object.entries({ tools: { register() {}, guard() {} }, webServer: { register() {} }, approval: {}, commands: { register() {} }, connection: {} })) { ctx.provide(key); ctx.set(key, value); }
  const mounted = await ctx.plugin(schemePlugin, {});
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(filesystem, { watch: false, dshHome: join(homes, 'dsh'), agentsHome: join(homes, 'agents') });
  const candidates = (await ctx.skills.list({ cwd: project.root })).filter((skill) => skill.provider === 'filesystem');
  const candidate = candidates.find((skill) => skill.name === 'ccpg-one');
  assert.equal(candidate?.source, 'project-dsh');
  assert.match(candidate?.description, /Generate the first chapter/);
  assert.equal(candidate?.invocation?.modelInvocable, true);
  const skill = await ctx.skills.get('ccpg-one', { cwd: project.root });
  assert.match(skill.content, /Read \[the template\]/);
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.equal(skill.resourceBase.path, join(project.root, '.dsh', 'skills', 'ccpg-one'));
  await readFile(join(skill.resourceBase.path, 'assets', 'template.md'), 'utf8');
  await mounted.dispose();
});

test('scheme tool failures append bounded local diagnostics', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-diagnostics-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [], dataMappings: {},
  }));
  await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const tools = [];
  apply({ ...session(cwd), tools: { register(tool) { tools.push(tool); }, guard() {} }, webServer: { register() {} } });
  const status = tools.find((tool) => tool.name === 'project_status');
  await assert.rejects(status.execute({ projectId: 'wrong' }, { sessionId: 's1' }), /project id/i);
  const diagnosticPath = join(cwd, '.ccpg-scheme', 'diagnostics.jsonl');
  const first = JSON.parse((await readFile(diagnosticPath, 'utf8')).trim().split('\n').at(-1));
  assert.equal(first.operation, 'tool:project_status');
  assert.equal(first.projectId, 'wrong');
  assert.equal(first.rulesVersion, '1');
  assert.equal(first.message, '插件操作失败');
  await writeFile(diagnosticPath, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(status.execute({ projectId: 'wrong' }, { sessionId: 's1' }), /project id/i);
  assert.equal((await stat(join(cwd, '.ccpg-scheme', 'diagnostics.jsonl.1'))).size, 1024 * 1024 + 1);
  const current = JSON.parse((await readFile(diagnosticPath, 'utf8')).trim());
  assert.equal(current.operation, 'tool:project_status');
  const prepare = tools.find((tool) => tool.name === 'chapter_prepare');
  const submit = tools.find((tool) => tool.name === 'chapter_submit');
  const prepared = JSON.parse(await prepare.execute({ projectId: 'p', chapterId: 'one' }, { sessionId: 's1' }));
  await assert.rejects(submit.execute({ projectId: 'p', token: { ...prepared.token, attemptId: 'different' }, body: 'body' }, { sessionId: 's1' }), /preparation state changed/i);
  const chapterFailure = JSON.parse((await readFile(diagnosticPath, 'utf8')).trim().split('\n').at(-1));
  assert.equal(chapterFailure.chapterId, 'one');
  assert.equal(chapterFailure.message, '成果或输入版本已变化');
  const healthy = JSON.parse(await status.execute({ projectId: 'p' }, { sessionId: 's1' }));
  assert.equal(healthy.diagnostics.path, '.ccpg-scheme/diagnostics.jsonl');
  assert.equal(healthy.diagnostics.recent.at(-1).operation, 'tool:chapter_submit');
  assert.equal(healthy.diagnostics.recent.at(-1).chapterId, 'one');
});

test('native host registers tools and status reloads from current session cwd', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-host-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }, { id: 'two', title: 'Two', order: 2, skill: 'skills/two/SKILL.md', dependencies: ['one'], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [], dataMappings: {} }));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  assert.deepEqual(inject, ['tools', 'webServer', 'approval', 'commands', 'connection']);
  const tools = []; const routes = []; const guards = []; const listeners = {};
  apply({ ...session(cwd), tools: { register(tool) { tools.push(tool); }, guard(fn) { guards.push(fn); } }, on(event, fn) { listeners[event] = fn; }, webServer: { register(route) { routes.push(route); } } });
  assert.deepEqual(tools.map((tool) => tool.name), ['ccpg_cli_status', 'ccpg_cli_setup', 'ccpg_project_find', 'ccpg_project_fetch', 'scheme_validation_report', 'scheme_feedback', 'project_create', 'project_status', 'project_recover', 'chapter_prepare', 'chapter_submit', 'chapter_edit', 'material_parse', 'material_complete', 'material_render_pages', 'feishu_collect_materials', 'feishu_read', 'scheme_publish']);
  assert.equal(tools.some((tool) => ['material_visual_batch', 'material_visual_read', 'material_complete_visual'].includes(tool.name)), false);
  assert.equal(typeof guards[0], 'function');
  assert.equal(typeof listeners['session/disposed'], 'function');
  assert.equal(typeof listeners['agent/disposed'], 'function');
  const status = tools.find((tool) => tool.name === 'project_status'); const raw = await status.execute({ projectId: 'p' }, { sessionId: 's1' });
  assert.equal(typeof raw, 'string'); const result = JSON.parse(raw);
  assert.equal(result.state.projectId, 'p'); assert.equal(result.manifest.id, 'demo');
  await assert.rejects(status.execute({ projectId: '../escape' }, { sessionId: 's1' }), /unsafe project id/);
  assert.equal(routes[0].path, '/ccpg-scheme/api'); assert.equal(project.root, cwd);
  const payload = JSON.stringify({ projectId: 'p', sourceDirectory: '../outside' });
  const req = { method: 'POST', url: '/ccpg-scheme/api/index-materials?sessionId=s1', headers: { host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield payload; } };
  const res = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } };
  await routes[0].handler(req, res); assert.equal(res.statusCode, 400); assert.match(res.body.error, /sourceDirectory/);
  const routeDiagnostic = JSON.parse((await readFile(join(cwd, '.ccpg-scheme', 'diagnostics.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.equal(routeDiagnostic.operation, 'http:POST:/ccpg-scheme/api/index-materials');
  assert.equal(routeDiagnostic.projectId, 'p');

  const invoke = async (target, url) => { const response = { statusCode: 0, setHeader() {}, end(value) { this.body = JSON.parse(value); } }; await target.handler({ method: 'GET', url, headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, response); return response; };
  const unbound = await invoke(routes[0], '/ccpg-scheme/api?sessionId=s1');
  assert.equal(unbound.statusCode, 200); assert.equal(unbound.body.state.projectId, 'p');
  const unknownGet = await invoke(routes[0], '/ccpg-scheme/api/unknown?sessionId=s1');
  assert.equal(unknownGet.statusCode, 404);
  const browserUrl = await invoke(routes[0], '/ccpg-scheme/api/browser-url?sessionId=s1&projectId=p');
  assert.equal(new URL(browserUrl.body.url).pathname, '/ccpg-scheme/results');
  assert.equal(new URL(browserUrl.body.url).searchParams.get('token'), 'test-token');
  assert.equal(new URL(browserUrl.body.url).searchParams.get('sessionId'), 's1');
  const resultsRoute = routes.find((route) => route.path === '/ccpg-scheme/results');
  const bundleRoute = routes.find((route) => route.path === '/ccpg-scheme/browser.js');
  assert.ok(resultsRoute); assert.ok(bundleRoute);
  const browserResponse = () => ({ statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); }, end(value) { this.body = value; } });
  const exchange = browserResponse();
  await resultsRoute.handler({ method: 'GET', url: '/ccpg-scheme/results?sessionId=s1&projectId=p&token=test-token', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, exchange);
  assert.equal(exchange.statusCode, 303); assert.equal(exchange.headers.location, '/ccpg-scheme/results?sessionId=s1&projectId=p');
  const page = browserResponse();
  await resultsRoute.handler({ method: 'GET', url: '/ccpg-scheme/results?sessionId=s1&projectId=p', headers: { host: 'localhost', cookie: 'dsh-auth=test' }, socket: { remoteAddress: '127.0.0.1' } }, page);
  assert.equal(page.statusCode, 200); assert.match(page.body, /ccpg-scheme\/browser\.js/); assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  const remote = browserResponse();
  await resultsRoute.handler({ method: 'GET', url: '/ccpg-scheme/results?sessionId=s1', headers: { host: 'localhost', cookie: 'dsh-auth=test' }, socket: { remoteAddress: '10.0.0.2' } }, remote);
  assert.equal(remote.statusCode, 403);
  const bundle = browserResponse();
  await bundleRoute.handler({ method: 'GET', url: '/ccpg-scheme/browser.js', headers: { host: 'localhost', cookie: 'dsh-auth=test' }, socket: { remoteAddress: '127.0.0.1' } }, bundle);
  assert.equal(bundle.statusCode, 200); assert.match(bundle.body, /ccpg-scheme-browser/);
  const deniedPost = browserResponse();
  await resultsRoute.handler({ method: 'POST', url: '/ccpg-scheme/results', headers: { host: 'localhost', cookie: 'dsh-auth=test' }, socket: { remoteAddress: '127.0.0.1' } }, deniedPost);
  assert.equal(deniedPost.statusCode, 405);
  const deniedBrowser = { statusCode: 0, setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await routes[0].handler({ method: 'GET', url: '/ccpg-scheme/api?sessionId=s1', headers: { host: 'localhost', 'x-test-unauthenticated': '1' } }, deniedBrowser);
  assert.equal(deniedBrowser.statusCode, 401);
  const material = await registerMaterial(project, { name: 'brief', text: 'private unrelated material' });
  const publicState = await invoke(routes[0], '/ccpg-scheme/api?sessionId=s1&projectId=p');
  assert.equal(publicState.body.state.materials[material.id].text, undefined);
  assert.equal(publicState.body.projectCwd, project.root);
  const prepared = await prepareChapter(project, { chapterId: 'one' }); await submitChapter(project, { token: prepared.token, body: 'committed body', evidence: [{ source: material.id }] });
  const artifact = await invoke(routes[0], '/ccpg-scheme/api/artifact?sessionId=s1&projectId=p&chapterId=one');
  assert.equal(artifact.statusCode, 200); assert.equal(artifact.body.body, 'committed body'); assert.deepEqual(artifact.body.confirmations, []);
  const bad = await invoke(routes[0], '/ccpg-scheme/api/artifact?sessionId=s1&projectId=p&chapterId=../../state'); assert.equal(bad.statusCode, 400);
  const post = async (path, value) => { const response = { statusCode: 0, setHeader() {}, end(body) { this.body = JSON.parse(body); } }; await routes[0].handler({ method: 'POST', url: `${path}?sessionId=s1`, headers: { host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(value); } }, response); return response; };
  for (const path of ['/ccpg-scheme/api/confirm', '/ccpg-scheme/api/edit', '/ccpg-scheme/api/skip']) {
    const denied = await post(path, { projectId: 'p', chapterId: 'one', revision: project.state.revision, body: 'edit', reason: 'skip' });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.code, 'user-action-required');
  }

  const childTools = []; apply({ ...session(project.root), tools: { register(tool) { childTools.push(tool); } }, webServer: { register() {} } });
  const childStatus = childTools.find((tool) => tool.name === 'project_status');
  assert.equal(JSON.parse(await childStatus.execute({ projectId: 'p' }, { sessionId: 'child' })).state.projectId, 'p');

  const ctx = new Context(); ctx.provide('systemPrompt'); ctx.set('systemPrompt', { tools() {} }); const runtime = new ToolRuntime(ctx);
  apply({ ...session(cwd), tools: runtime, webServer: { register() {} } });
  const invoked = await runtime.execute({ name: 'project_status', arguments: { projectId: 'p' }, agent: { session: { id: 's1' } }, callId: 'status-1', signal: new AbortController().signal });
  assert.equal(invoked.isError, false); assert.equal(typeof invoked.value, 'string'); assert.equal(JSON.parse(invoked.value).state.projectId, 'p');
  assert.equal(typeof Config, 'function');
});

test('native tool runtime accepts reordered JSON tokens but rejects tampering and changed bound materials', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-runtime-token-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  const inputs = [{ id: 'brief', required: true }, { id: 'optional', required: 'unknown' }, { id: 'extra', required: 'unknown' }];
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs, outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [] }));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const first = await registerMaterial(project, { name: 'brief', text: 'original' });
  const second = await registerMaterial(project, { name: 'optional', text: 'optional source' });
  const ctx = new Context(); ctx.provide('systemPrompt'); ctx.set('systemPrompt', { tools() {} }); const runtime = new ToolRuntime(ctx);
  apply({ ...session(cwd), on: ctx.on.bind(ctx), tools: runtime, webServer: { register() {} } });
  let call = 0;
  const invoke = (name, arguments_) => runtime.execute({ name, arguments: { projectId: 'p', ...arguments_ }, agent: { session: { id: 's1' } }, callId: `token-${++call}`, signal: new AbortController().signal });
  const prepare = await invoke('chapter_prepare', { chapterId: 'one', inputBindings: { brief: first.id, optional: second.id }, inputDecisions: { optional: 'required', extra: 'not_required' } });
  assert.equal(prepare.isError, false);
  const token = JSON.parse(prepare.value).token;
  const reordered = Object.fromEntries(Object.entries(token).reverse());
  reordered.bindings = Object.fromEntries(Object.entries(token.bindings).reverse());
  reordered.decisions = Object.fromEntries(Object.entries(token.decisions).reverse());
  const tampered = await invoke('chapter_submit', { token: { ...reordered, bindings: { ...reordered.bindings, brief: second.id } }, body: 'must reject' });
  assert.equal(tampered.isError, true);
  assert.equal(Object.keys(SchemeStore.load(cwd).state.artifacts).length, 0);
  const submitted = await invoke('chapter_submit', { token: reordered, body: 'runtime body', evidence: [{ source: first.id }] });
  assert.equal(submitted.isError, false);
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'submitted');
  const again = await invoke('chapter_prepare', { chapterId: 'one', inputBindings: token.bindings, inputDecisions: token.decisions });
  assert.equal(again.isError, false);
  await writeFile(join(cwd, first.contentPath), 'externally changed source');
  assert.equal((await invoke('chapter_submit', { token: JSON.parse(again.value).token, body: 'must reject changed material' })).isError, true);
  assert.equal(Object.keys(SchemeStore.load(cwd).state.artifacts).length, 1);
});

test('native tool runtime submits saved Markdown without a body argument', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-runtime-draft-')); const rules = join(base, 'rules'); const cwd = join(base, 'project');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [] }));
  await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const ctx = new Context(); ctx.provide('systemPrompt'); ctx.set('systemPrompt', { tools() {} }); const runtime = new ToolRuntime(ctx);
  apply({ ...session(cwd), on: ctx.on.bind(ctx), tools: runtime, webServer: { register() {} } });
  let call = 0;
  const invoke = (name, args, sessionId = 's1') => runtime.execute({ name, arguments: { projectId: 'p', ...args }, agent: { session: { id: sessionId } }, callId: `draft-${++call}`, signal: new AbortController().signal });
  const prepared = await invoke('chapter_prepare', { chapterId: 'one' });
  assert.equal(prepared.isError, false);
  const { token, draftPath } = JSON.parse(prepared.value);
  const body = '# Saved chapter\n\nExact metric: 12.34.\n';
  await writeFile(join(cwd, draftPath), body);
  assert.equal((await invoke('chapter_submit', { token, bodyPath: draftPath }, 'other')).isError, true);
  assert.equal((await invoke('chapter_submit', { token, bodyPath: draftPath, body })).isError, true);
  assert.equal((await invoke('chapter_submit', { token, bodyPath: draftPath })).isError, false);
  const store = SchemeStore.load(cwd); const artifact = store.state.artifacts[store.state.chapters.one.artifactId];
  assert.equal(await readFile(join(cwd, artifact.path, 'body.md'), 'utf8'), body);
  const diagnostics = await readFile(join(cwd, '.ccpg-scheme/diagnostics.jsonl'), 'utf8');
  assert.ok(!diagnostics.includes(body));
});

test('native material tools parse scoped files, register provenance, reuse output, and expose current-user Feishu reads', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-host-material-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await mkdir(join(rules, 'skills', 'two'), { recursive: true });
  await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }, { id: 'two', title: 'Two', order: 2, skill: 'skills/two/SKILL.md', dependencies: ['one'], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [], dataMappings: {} }));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  await mkdir(join(cwd, 'inputs')); await writeFile(join(cwd, 'inputs', 'brief.md'), '# Source\n\nExact text.');
  const calls = []; const tools = []; const routes = []; const listeners = {}; let fetched = 0;
  const larkCli = { async run(args) { calls.push(args); fetched++; return { ok: true, data: { document_id: fetched === 1 ? 'doc-1' : 'd'.repeat(100000), revision_id: 2, content: fetched === 1 ? '# Feishu\n\nSnapshot' : 'Large Feishu snapshot\n'.repeat(10000), locations: Array.from({ length: 4000 }, (_, page) => ({ page })) } }; } };
  const serviceCtx = { ...session(cwd), on(event, fn) { listeners[event] = fn; }, tools: { register(tool) { tools.push(tool); }, guard() {} }, get(key) { return key === 'ccpgLarkUserCli' ? larkCli : session(cwd).get(key); }, webServer: { register(route) { routes.push(route); } } };
  apply(serviceCtx);
  const parse = tools.find((tool) => tool.name === 'material_parse');
  const render = tools.find((tool) => tool.name === 'material_render_pages');
  const read = tools.find((tool) => tool.name === 'feishu_read');
  assert.ok(parse); assert.ok(render); assert.ok(read);
  const output = await parse.execute({ projectId: 'p', sourcePath: 'inputs/brief.md' }, { sessionId: 's1' });
  assert.equal(typeof output, 'string'); const parsed = JSON.parse(output); assert.match(parsed.preview, /Exact text/);
  assert.equal(parsed.markdown, undefined);
  assert.equal(parsed.material.metadata.sourcePath, 'inputs/brief.md'); assert.match(parsed.parse.markdownPath, /^materials\/parsed\//);
  assert.equal((await readFile(join(cwd, parsed.material.contentPath), 'utf8')), '# Source\n\nExact text.');
  const reused = JSON.parse(await parse.execute({ projectId: 'p', sourcePath: 'inputs/brief.md' }, { sessionId: 's1' }));
  assert.equal(reused.parse.reused, true);
  await writeFile(join(cwd, 'inputs', 'large.md'), 'Exact source\n'.repeat(50000));
  const large = JSON.parse(await parse.execute({ projectId: 'p', sourcePath: 'inputs/large.md' }, { sessionId: 's1' }));
  assert.ok(large.preview.length <= 2000);
  assert.ok(JSON.stringify(large).length < 10000);
  assert.equal((await readFile(join(cwd, large.material.contentPath), 'utf8')).length, 650000);
  assert.equal(large.characters, 650000);
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Large" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${Array.from({ length: 4000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')}</sheetData></worksheet>`);
  await writeFile(join(cwd, 'inputs', 'large.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const workbook = JSON.parse(await parse.execute({ projectId: 'p', sourcePath: 'inputs/large.xlsx' }, { sessionId: 's1' }));
  assert.ok(JSON.stringify(workbook).length < 10000);
  assert.equal(workbook.parse.coverageCounts.sourceLocations, 4000);
  assert.equal(SchemeStore.load(cwd).state.materials[workbook.material.id].metadata.coverage.sourceLocations.length, 4000);
  assert.equal(JSON.parse(await readFile(join(cwd, workbook.parse.metadataPath), 'utf8')).coverage.sourceLocations.length, 4000);
  await assert.rejects(render.execute({ projectId: 'p', sourcePath: 'inputs/large.xlsx', pages: Array(33).fill(1) }, { sessionId: 's1' }), /1 to 32/);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  await writeFile(join(cwd, 'inputs', 'render.pdf'), pdf);
  const rendered = JSON.parse(await render.execute({ projectId: 'p', sourcePath: 'inputs/render.pdf', pages: [1] }, { sessionId: 's1' }));
  const renderAgain = JSON.parse(await render.execute({ projectId: 'p', sourcePath: 'inputs/render.pdf', pages: [1] }, { sessionId: 's1' }));
  assert.equal(rendered.reused, false); assert.equal(renderAgain.reused, true);
  assert.deepEqual(rendered.images, renderAgain.images); assert.match(rendered.images[0], /^materials\/parsed\/page-renders\//);
  const response = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await routes[0].handler({ method: 'POST', url: '/ccpg-scheme/api/material-render-pages?sessionId=s1', headers: { host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ projectId: 'p', sourcePath: 'inputs/render.pdf', pages: [1] }); } }, response);
  assert.equal(response.statusCode, 200); assert.equal(response.body.reused, true); assert.deepEqual(response.body.images, rendered.images);
  await routes[0].handler({ method: 'POST', url: '/ccpg-scheme/api/material-parse?sessionId=s1', headers: { host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ projectId: 'p', sourcePath: 'inputs/render.pdf' }); } }, response);
  assert.equal(response.statusCode, 200); assert.equal(response.body.material.parseStatus, 'needs-vision'); assert.deepEqual(response.body.material.metadata.coverage.unreadPages, [1]);
  await mkdir(join(cwd, 'materials', 'parsed'), { recursive: true });
  await writeFile(join(cwd, 'materials', 'parsed', 'pdf-review.md'), '## Page 1\n\nBlank page.');
  const completePdf = tools.find((tool) => tool.name === 'material_complete');
  const completedPdf = JSON.parse(await completePdf.execute({
    projectId: 'p',
    materialId: response.body.material.id,
    sourceSha256: response.body.parse.sha256,
    markdownPath: 'materials/parsed/pdf-review.md',
    review: 'Reviewed the PDF as one document with the native model capabilities.',
    unresolved: []
  }, { sessionId: 's1' }));
  assert.equal(completedPdf.material.parseStatus, 'complete');
  assert.deepEqual(SchemeStore.load(cwd).state.materials[completedPdf.material.id].metadata.coverage.unreadPages ?? [], []);
  assert.equal(tools.some((tool) => ['material_visual_batch', 'material_visual_read', 'material_complete_visual'].includes(tool.name)), false);
  await assert.rejects(parse.execute({ projectId: 'p', sourcePath: '../outside.md' }, { sessionId: 's1' }), /unsafe|source/i);
  await assert.rejects(render.execute({ projectId: 'p', sourcePath: 'inputs/brief.md', pages: [1] }, { sessionId: 's1' }), /PDF/i);
  const readResult = JSON.parse(await read.execute({ projectId: 'p', url: 'https://example.feishu.cn/docx/doc-1' }, { sessionId: 's1' }));
  assert.equal(readResult.content, undefined);
  assert.match(readResult.preview, /Snapshot/);
  assert.equal(readResult.material.metadata.source, 'feishu'); assert.equal(readResult.material.metadata.revisionId, 2); assert.equal(fetched, 1);
  assert.deepEqual(calls[0].slice(-2), ['--as', 'user']);
  assert.equal(SchemeStore.load(cwd).state.materials[readResult.material.id].metadata.snapshotPath.startsWith('materials/fetched/'), true);
  const largeRead = JSON.parse(await read.execute({ projectId: 'p', url: 'https://example.feishu.cn/docx/doc-2' }, { sessionId: 's1' }));
  assert.ok(JSON.stringify(largeRead).length < 10000); assert.ok(largeRead.preview.length <= 2000);
  const fullRead = SchemeStore.load(cwd).state.materials[largeRead.material.id];
  assert.equal(fullRead.metadata.resourceId.length, 100000);
  assert.equal(JSON.parse(await readFile(join(cwd, fullRead.metadata.snapshotPath), 'utf8')).locations.length, 4000);
  assert.equal(tools.find((tool) => tool.name === 'scheme_publish').parameters.confirmed, undefined);
  const isolatedTools = []; apply({ ...session(cwd), tools: { register(tool) { isolatedTools.push(tool); } }, webServer: { register() {} } });
  await assert.rejects(isolatedTools.find((tool) => tool.name === 'feishu_read').execute({ projectId: 'p', url: 'https://example.feishu.cn/docx/doc-1' }, { sessionId: 's2' }), /service unavailable/);
});

test('Feishu list tool collects inside the current project without approval and keeps downloads pending until parsed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-host-collection-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [], dataMappings: {} }));
  await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const tools = []; let downloads = 0;
  const cli = { async run(args, options) {
    assert.deepEqual(args.slice(-2), ['--as', 'user']);
    const arg = (flag) => args[args.indexOf(flag) + 1];
    if (args[1] === '+table-get' || args[1] === '+cells-get') {
      await writeFile(join(options.cwd, arg('--output-path')), JSON.stringify(args[1] === '+table-get'
        ? { sheets: [{ name: '材料', range: 'A1:A1' }] }
        : { ranges: [{ actual_range: 'A1:A1', row_indices: [1], col_indices: ['A'], cells: [[{ rich_text: [{ link: 'https://example.feishu.cn/file/brief', text: '项目说明' }] }]] }] }));
      return { ok: true, data: { complete: true } };
    }
    if (args[1] === '+inspect') return { ok: true, data: { type: 'file', token: 'brief', title: '项目说明.md' } };
    assert.equal(args[1], '+download');
    downloads++;
    await writeFile(join(options.cwd, arg('--output')), '# 项目说明\n真实的模拟材料。');
    return { ok: true, data: {} };
  } };
  apply({ ...session(cwd), tools: { register(tool) { tools.push(tool); } }, get(key) { return key === 'ccpgLarkUserCli' ? cli : session(cwd).get(key); }, approval: { request() { throw new Error('read-only collection must not request approval'); } }, webServer: { register() {} } });
  const collect = tools.find((tool) => tool.name === 'feishu_collect_materials');
  const args = { projectId: 'p', url: 'https://example.feishu.cn/sheets/list?sheet=materials' };
  const result = JSON.parse(await collect.execute(args, { sessionId: 's1' }));
  assert.equal(result.complete, true);
  assert.equal(result.downloaded, 1);
  const file = result.files[0];
  assert.equal(file.path, 'materials/input/飞书材料/项目说明.md');
  const pending = SchemeStore.load(cwd).state.materials[file.materialId];
  assert.equal(pending.parseStatus, 'pending');
  assert.equal(pending.contentPath, undefined);
  const parsed = JSON.parse(await tools.find((tool) => tool.name === 'material_parse').execute({ projectId: 'p', sourcePath: file.path }, { sessionId: 's1' }));
  assert.equal(parsed.material.parseStatus, 'complete');
  assert.match(await readFile(join(cwd, parsed.material.contentPath), 'utf8'), /真实的模拟材料/);
  await collect.execute(args, { sessionId: 's1' });
  assert.equal(downloads, 1);
  await assert.rejects(collect.execute({ ...args, projectId: 'other' }, { sessionId: 's1' }), /does not match/);
  const isolated = [];
  apply({ ...session(cwd), tools: { register(tool) { isolated.push(tool); } }, webServer: { register() {} } });
  await assert.rejects(isolated.find((tool) => tool.name === 'feishu_collect_materials').execute(args, { sessionId: 's1' }), /service unavailable/);
});

test('Feishu creation needs no second approval and retains snapshot, identity and duplicate protection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-host-publish-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }, { id: 'two', title: 'Two', order: 2, skill: 'skills/two/SKILL.md', dependencies: ['one'], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [], dataMappings: {} }));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const prepared = await prepareChapter(project, { chapterId: 'one' }); await submitChapter(project, { token: prepared.token, body: 'approved body' });
  const args = { projectId: 'p', title: 'Final', targetMode: 'create', parentToken: 'folder-1' };
  let writes = 0;
  let folderCreates = 0;
  let approvals = 0;
  let published = '';
  let uploadedBytes;
  const cloud = new Map();
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
  const { CommandRuntime } = await import(sdkRequire.resolve('@deepseek-ai/dsh-commands'));
  const { ApprovalService } = await import(sdkRequire.resolve('@deepseek-ai/dsh-user-approval'));
  const cli = { async run(argv, options) {
    if (argv[0] === 'drive' && argv[1] === '+create-folder') {
      writes++;
      folderCreates++;
      const name = argv[argv.indexOf('--name') + 1];
      const token = argv.includes('--folder-token') && argv[argv.indexOf('--folder-token') + 1] === 'folder-remote' ? `chapter-${name}` : 'folder-remote';
      cloud.set(token, { token, parent: argv.includes('--folder-token') ? argv[argv.indexOf('--folder-token') + 1] : '', type: 'folder' });
      return { ok: true, data: { token, url: `https://example.feishu.cn/drive/folder/${token}` } };
    }
    if (argv[0] === 'docs' && argv[1] === '+create') {
      writes++;
      const contentRef = argv[argv.indexOf('--content') + 1];
      const content = await readFile(join(options.cwd, contentRef.slice(2)), 'utf8');
      assert.match(content, /approved body/); assert.doesNotMatch(content, /tampered/);
      assert.doesNotMatch(content, /# Appendices/); assert.doesNotMatch(content, /Attachment Manifest/);
      published = content;
      const token = cloud.has('remote-1') ? 'remote-2' : 'remote-1';
      cloud.set(token, { token, content, parent: argv[argv.indexOf('--parent-token') + 1] });
      return { ok: true, data: { document_id: token, url: `https://example.feishu.cn/docx/${token}` } };
    }
    if (argv[0] === 'docs' && argv[1] === '+update') {
      writes++;
      assert.equal(argv[argv.indexOf('--doc') + 1], 'remote-2');
      published = await readFile(join(options.cwd, argv[argv.indexOf('--content') + 1].slice(2)), 'utf8');
      cloud.get('remote-2').content = published;
      return { ok: true, data: { document: { revision_id: 3 }, result: 'success' } };
    }
    if (argv[0] === 'drive' && argv[1] === '+upload') {
      writes++;
      const contentRef = argv[argv.indexOf('--file') + 1];
      assert.match(contentRef, /^\.\/附件\/2 Two\/1-counts\.(csv|xlsx)$/);
      const uploaded = await readFile(join(options.cwd, contentRef.slice(2)));
      assert.deepEqual(uploaded, contentRef.endsWith('.xlsx') ? Buffer.from('binary') : Buffer.from('type,count\nspaces,55'));
      uploadedBytes = uploaded;
      cloud.set('file-1', { token: 'file-1', parent: argv.includes('--file-token') ? cloud.get('file-1').parent : argv[argv.indexOf('--folder-token') + 1] });
      return { ok: true, data: { file_token: 'file-1', url: 'https://example.feishu.cn/file/file-1' } };
    }
    if (argv[0] === 'docs' && argv[1] === '+fetch') {
      const token = argv[argv.indexOf('--doc') + 1];
      return { ok: true, data: { document_id: token, revision_id: 3, content: cloud.get(token).content } };
    }
    if (argv[0] === 'drive' && argv[1] === '+download') {
      const output = argv[argv.indexOf('--output') + 1];
      await writeFile(join(options.cwd, output.slice(2)), uploadedBytes);
      return { ok: true, data: {} };
    }
    if (argv[0] === 'drive' && argv[1] === 'files' && argv[2] === 'list') {
      const parent = JSON.parse(argv[argv.indexOf('--params') + 1]).folder_token;
      return { ok: true, data: { files: [...cloud.values()].filter(item => item.parent === parent), has_more: false } };
    }
    throw new Error(`unexpected CLI call: ${argv.join(' ')}`);
  } };
  const invoke = async (outcome, mutate = false, cancel = false, human = false, revision = SchemeStore.load(cwd).state.revision, scope = {}) => {
    const controller = new AbortController();
    if (cancel && scope.targetMode !== 'update') controller.abort();
    const tools = []; const commands = []; const ctx = { ...session(cwd), commands: { register(command) { commands.push(command); } }, get(key) { return key === 'ccpgLarkUserCli' ? cli : session(cwd).get(key); }, approval: { async request(request) {
      approvals++;
      assert.equal(request.toolName, 'scheme_publish'); assert.match(request.reason, /document remote-[12]/); assert.match(request.reason, /SHA-256 [a-f0-9]{64}/);
      if (typeof mutate === 'function') await mutate();
      else if (mutate) {
        const relativePath = request.reason.match(/(?:Fixed|Delivery) snapshot: ([^;]+)/i)[1]; const snapshotPath = join(cwd, relativePath);
        const targetPath = (await stat(snapshotPath)).isDirectory() ? join(snapshotPath, '完整方案.md') : snapshotPath;
        await chmod(targetPath, 0o600); await writeFile(targetPath, 'tampered');
      }
      if (cancel) controller.abort();
      return outcome;
    } }, tools: { register(tool) { tools.push(tool); }, guard() {} }, webServer: { register() {} } };
    apply(ctx);
    if (human) {
      const commandCtx = new Context();
      ctx.approval = new ApprovalService(commandCtx, { policy: 'ask' });
      const runtime = new CommandRuntime(commandCtx); runtime.register(commands[0]);
      const events = [];
      const agent = { ctx: commandCtx, session: { id: 's1', get seq() { return events.length; }, eventAt(seq) { return events[seq]; }, append(type, data) { events.push({ type, data }); } } };
      const executed = await runtime.execute(agent, `/ccpg-scheme ${JSON.stringify({ ...args, action: 'publish', revision, ...scope })}`, [], controller.signal);
      assert.deepEqual(events.map(event => event.type), ['command/run', 'command/done'], 'native publication has no model turn or approval audit');
      assert.equal(events[0].data.source.kind, 'user');
      return executed.result;
    }
    return tools.find((tool) => tool.name === 'scheme_publish').execute({ ...args, ...(mutate ? { title: 'Tamper test' } : {}), ...scope }, { sessionId: 's1', agent: {}, signal: controller.signal });
  };
  await assert.rejects(invoke('allowed-once'), /incomplete chapters/i);
  assert.equal(approvals, 0); assert.equal(writes, 0);
  const scope = { chapterId: 'one', artifactRevision: 1 };
  const missingRevision = await invoke('allowed-once', false, false, true, undefined, { chapterId: 'one' });
  assert.equal(missingRevision.kind, 'error'); assert.match(missingRevision.text, /artifact revision/i);
  const staleChapter = await invoke('allowed-once', false, false, true, undefined, { ...scope, artifactRevision: 0 });
  assert.equal(staleChapter.kind, 'error'); assert.match(staleChapter.text, /artifact revision/i);
  await assert.rejects(invoke('allowed-once', false, false, false, undefined, { chapterId: 'unknown' }), /unknown chapter/i);
  await assert.rejects(invoke('allowed-once', false, false, false, undefined, { chapterId: 'two' }), /incomplete chapters/i);
  const single = await invoke('allowed-once', false, false, true, undefined, scope);
  assert.equal(single.kind, 'success', single.text);
  assert.equal(JSON.parse(single.text).result.verified, true);
  assert.equal(writes, 3, 'scheme folder, chapter folder and body publish before subsequent chapters are generated');
  assert.doesNotMatch(published, /second body/);
  await invoke('allowed-once', false, false, true, undefined, scope);
  assert.equal(writes, 3, 'same chapter snapshot is reused');
  writes = 0;
  const second = await prepareChapter(project, { chapterId: 'two' });
  await submitChapter(project, { token: second.token, body: 'second body', attachments: [{ outputId: 'table', name: 'counts.csv', content: 'type,count\nspaces,55' }] });
  const priorChapter = await invoke('allowed-once', false, false, true, undefined, scope);
  assert.equal(JSON.parse(priorChapter.text).result.reused, true, 'another chapter completion must not recreate this chapter document');
  assert.equal(writes, 0);
  const { publicationSummary } = await import('../lib/publications.js');
  const restoredLinks = await publicationSummary(cwd);
  assert.equal(restoredLinks.one.body.url, 'https://example.feishu.cn/docx/remote-1');
  assert(!JSON.stringify(restoredLinks).includes('approved body'), 'native results metadata excludes remote body');
  const update = { targetMode: 'update', doc: 'remote-1', revisionId: 3, sha256: 'a'.repeat(64) };
  await assert.rejects(invoke('rejected', false, false, false, undefined, update), /not approved/); assert.equal(writes, 0);
  await assert.rejects(invoke('unavailable', false, false, false, undefined, update), /not approved.*unavailable/); assert.equal(writes, 0);
  await assert.rejects(invoke('allowed-once', false, true, false, undefined, update), /cancelled/); assert.equal(writes, 0);
  await assert.rejects(invoke('allowed-once', false, true), /cancelled/); assert.equal(writes, 0);
  const deliveryBodyPath = (await createDeliverySnapshot(SchemeStore.load(cwd))).artifactPath;
  const originalDeliveryBody = await readFile(deliveryBodyPath);
  await chmod(deliveryBodyPath, 0o600); await writeFile(deliveryBodyPath, 'tampered');
  await assert.rejects(invoke('unavailable'), /snapshot.*changed/); assert.equal(writes, 0);
  await writeFile(deliveryBodyPath, originalDeliveryBody);
  const approvalsBeforeCreate = approvals;
  const result = JSON.parse(await invoke('unavailable'));
  assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(writes, 3);
  assert.equal(folderCreates, 3, 'one scheme root and two reused chapter folders');
  assert.equal(approvals, approvalsBeforeCreate, 'explicit creation does not request a second approval');
  const writesAfterPublish = writes;
  const repeated = JSON.parse(await invoke('allowed-once'));
  assert.equal(repeated.ok, true); assert.equal(repeated.reused, true); assert.equal(writes, writesAfterPublish);
  const createTools = [];
  apply({ ...session(cwd), get(key) { return key === 'ccpgLarkUserCli' ? cli : session(cwd).get(key); }, tools: { register(tool) { createTools.push(tool); }, guard() {} }, webServer: { register() {} } });
  const withoutApproval = JSON.parse(await createTools.find(tool => tool.name === 'scheme_publish').execute(args, { sessionId: 's1' }));
  assert.equal(withoutApproval.verified, true); assert.equal(withoutApproval.reused, true); assert.equal(writes, writesAfterPublish);
  const deniedTools = []; apply({ ...session(cwd), tools: { register(tool) { deniedTools.push(tool); }, guard() {} }, webServer: { register() {} } });
  await assert.rejects(deniedTools.find((tool) => tool.name === 'scheme_publish').execute(args, { sessionId: 's1', agent: {} }), /current-user Feishu CLI service unavailable/);
  await assert.rejects(deniedTools.find((tool) => tool.name === 'scheme_publish').execute({ ...args, ...update }, { sessionId: 's1', agent: {} }), /approval unavailable/);
  const binary = await prepareChapter(project, { chapterId: 'two' });
  await submitChapter(project, { token: binary.token, body: 'second body', attachments: [{ outputId: 'table', name: 'counts.xlsx', base64: Buffer.from('binary').toString('base64') }] });
  const priorApprovals = approvals;
  const binaryResult = JSON.parse(await invoke('allowed-once'));
  assert.equal(binaryResult.ok, true, binaryResult.error);
  assert.equal(approvals, priorApprovals + 1, 'agent-managed update still requires native user approval');
  assert.equal(binaryResult.updated, true, 'local attachment edits update the original delivery');
  const beforeHuman = { writes, approvals };
  const staleHuman = await invoke('allowed-once', false, false, true, 0);
  assert.equal(staleHuman.kind, 'error'); assert.match(staleHuman.text, /revision/i);
  assert.equal(writes, beforeHuman.writes); assert.equal(approvals, beforeHuman.approvals);
  const publishedHuman = await invoke('unavailable', false, false, true);
  assert.equal(publishedHuman.kind, 'success', publishedHuman.text);
  const humanResult = JSON.parse(publishedHuman.text).result;
  assert.equal(humanResult.ok, true); assert.equal(humanResult.verified, true);
  assert.equal(writes, beforeHuman.writes, 'same approved snapshot is reused without duplicate cloud files');
  assert.equal(approvals, beforeHuman.approvals, 'human command does not require an open model turn');
  const humanEdited = await prepareChapter(project, { chapterId: 'two' });
  await submitChapter(project, { token: humanEdited.token, body: 'second body updated', attachments: [{ outputId: 'table', name: 'counts.xlsx', base64: Buffer.from('binary').toString('base64') }] });
  const edited = await invoke('unavailable', false, false, true);
  assert.equal(edited.kind, 'success', edited.text);
  assert.equal(JSON.parse(edited.text).result.updated, true);
  assert.equal(JSON.parse(edited.text).result.body.token, 'remote-2');
  assert.match(published, /second body updated/);
  assert.equal(approvals, beforeHuman.approvals, 'explicit human update authorizes the managed original without an approval model turn');
  assert.equal(folderCreates, 3);
  const beforeChanged = writes;
  await assert.rejects(invoke('allowed-once', async () => {
    const statePath = join(cwd, '.ccpg-scheme/state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.revision++;
    await writeFile(statePath, JSON.stringify(state));
  }, false, false, undefined, update), /revision conflict/i);
  assert.equal(writes, beforeChanged, 'changed project after approval must not write to cloud');
});

test('native host binds attempts to session and recovers on native disposal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-host-session-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(join(rules, 'skills', 'two'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'skills', 'two', 'SKILL.md'), 'two'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }, { id: 'two', title: 'Two', order: 2, skill: 'skills/two/SKILL.md', dependencies: ['one'], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [], dataMappings: {} }));
  await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const tools = []; const listeners = {};
  apply({ ...session(cwd), tools: { register(tool) { tools.push(tool); }, guard() {} }, on(event, fn) { listeners[event] = fn; }, webServer: { register() {} } });
  const prepare = tools.find((tool) => tool.name === 'chapter_prepare');
  const submit = tools.find((tool) => tool.name === 'chapter_submit');
  const prepared = JSON.parse(await prepare.execute({ projectId: 'p', chapterId: 'one' }, { sessionId: 's1' }));
  assert.equal(prepared.token.sessionId, 's1');
  await assert.rejects(submit.execute({ projectId: 'p', token: prepared.token, body: 'wrong session' }, { sessionId: 's2' }), /session mismatch|stale/i);
  const recover = tools.find((tool) => tool.name === 'project_recover');
  assert.ok(recover);
  await recover.execute({ projectId: 'p' }, { sessionId: 's1' });
  await assert.rejects(submit.execute({ projectId: 'p', token: prepared.token, body: 'stale attempt' }, { sessionId: 's1' }), /stale|token/i);
  const next = JSON.parse(await prepare.execute({ projectId: 'p', chapterId: 'one' }, { sessionId: 's1' }));
  assert.notDeepEqual(next.token, prepared.token);
  await tools.find((tool) => tool.name === 'project_status').execute({ projectId: 'p' }, { sessionId: 'visual-child' });
  await listeners['agent/disposed']({ agent: { session: { id: 'visual-child', header: { origin: 'subagent', parentSession: 's1' } } } });
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'prepared', 'disposing a material child must not revoke the parent chapter');
  await listeners['session/disposed']({ id: 's1' });
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'interrupted');
  const nativeCtx = new Context(); nativeCtx.provide('systemPrompt'); nativeCtx.set('systemPrompt', { tools() {} });
  const runtime = new ToolRuntime(nativeCtx);
  const nativeTools = [];
  apply({ ...session(cwd), on: nativeCtx.on.bind(nativeCtx), tools: { register(tool) { nativeTools.push(tool); runtime.register(tool); }, guard(fn) { runtime.guard(fn); } }, webServer: { register() {} } });
  const controller = new AbortController(); const agent = { session: { id: 's1' } };
  const active = await runtime.execute({ name: 'chapter_prepare', arguments: { projectId: 'p', chapterId: 'one' }, agent, callId: 'prepare-cancel', signal: controller.signal });
  assert.equal(active.isError, false);
  const cancelledToken = JSON.parse(active.value).token;
  controller.abort({ kind: 'user' });
  await assert.rejects(nativeTools.find((tool) => tool.name === 'chapter_submit').execute({ projectId: 'p', token: cancelledToken, body: 'late with fresh signal' }, { agent, signal: new AbortController().signal }), /cancel|stale|revoked/i);
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'interrupted');
  const fresh = JSON.parse(await nativeTools.find((tool) => tool.name === 'chapter_prepare').execute({ projectId: 'p', chapterId: 'one' }, { agent, signal: new AbortController().signal }));
  await nativeTools.find((tool) => tool.name === 'chapter_submit').execute({ projectId: 'p', token: fresh.token, body: 'fresh' }, { agent, signal: new AbortController().signal });
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'submitted');
  const secondController = new AbortController();
  const second = JSON.parse(await nativeTools.find((tool) => tool.name === 'chapter_prepare').execute({ projectId: 'p', chapterId: 'two' }, { agent, signal: secondController.signal }));
  await nativeTools.find((tool) => tool.name === 'chapter_submit').execute({ projectId: 'p', token: second.token, body: 'two' }, { agent, signal: secondController.signal });
  const submittedRevision = SchemeStore.load(cwd).state.revision;
  secondController.abort({ kind: 'user' });
  assert.equal(SchemeStore.load(cwd).state.revision, submittedRevision);
  const turnAgent = { session: { id: 's1' } };
  const turnA = new AbortController(); const turnB = new AbortController(); const turnC = new AbortController();
  await listeners['agent/pre-step']({ agent: turnAgent, signal: turnA.signal }, async () => ({ kind: 'enter' }));
  const crossTurn = JSON.parse(await prepare.execute({ projectId: 'p', chapterId: 'one' }, { agent: turnAgent, signal: turnA.signal }));
  const unrelatedTurn = new AbortController();
  await listeners['agent/pre-step']({ agent: { session: { id: 's2' } }, signal: unrelatedTurn.signal }, async () => ({ kind: 'enter' }));
  unrelatedTurn.abort({ kind: 'user' });
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'prepared');
  await listeners['agent/pre-step']({ agent: turnAgent, signal: turnB.signal }, async () => ({ kind: 'enter' }));
  turnA.abort({ kind: 'user' });
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'prepared');
  turnB.abort({ kind: 'user' });
  await listeners['agent/pre-step']({ agent: turnAgent, signal: turnC.signal }, async () => ({ kind: 'enter' }));
  await assert.rejects(submit.execute({ projectId: 'p', token: crossTurn.token, body: 'late after later turn cancellation' }, { agent: turnAgent, signal: turnC.signal }), /cancel|stale|revoked/i);
  assert.equal(SchemeStore.load(cwd).state.chapters.one.status, 'interrupted');
  await recover.execute({ projectId: 'p' }, { agent: turnAgent, signal: turnC.signal });
  const freshAcrossTurns = JSON.parse(await prepare.execute({ projectId: 'p', chapterId: 'one' }, { agent: turnAgent, signal: turnC.signal }));
  const turnD = new AbortController();
  await listeners['agent/pre-step']({ agent: turnAgent, signal: turnD.signal }, async () => ({ kind: 'enter' }));
  await submit.execute({ projectId: 'p', token: freshAcrossTurns.token, body: 'normal next-turn completion' }, { agent: turnAgent, signal: turnD.signal });
  const finalRevision = SchemeStore.load(cwd).state.revision;
  turnD.abort({ kind: 'user' });
  assert.equal(SchemeStore.load(cwd).state.revision, finalRevision);
});

test('document completion keeps source hashes and unresolved gaps without a visual tool chain', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-host-visual-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [{ id: 'brief', required: true }], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [] }], resources: [], dataMappings: {} }));
  await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  await writeFile(join(cwd, 'scan.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=', 'base64'));
  const tools = [];
  apply({ ...session(cwd), tools: { register(tool) { tools.push(tool); }, guard() {} }, webServer: { register() {} } });
  const exec = { sessionId: 's1', signal: new AbortController().signal };
  const parsed = JSON.parse(await tools.find((tool) => tool.name === 'material_parse').execute({ projectId: 'p', sourcePath: 'scan.png' }, exec));
  assert.equal(parsed.material.parseStatus, 'needs-vision');
  const complete = tools.find((tool) => tool.name === 'material_complete'); assert.ok(complete);
  await mkdir(join(cwd, 'materials', 'parsed'), { recursive: true });
  await writeFile(join(cwd, 'materials', 'parsed', 'scan-review.md'), '# Model transcription\nExact visible source');
  const args = { projectId: 'p', materialId: parsed.material.id, sourceSha256: parsed.parse.sha256, markdownPath: 'materials/parsed/scan-review.md', review: 'Native multimodal review.', unresolved: ['number unreadable'] };
  const partial = JSON.parse(await complete.execute(args, exec));
  assert.equal(partial.material.parseStatus, 'needs-review');
  assert.equal(partial.complete, false);
  await writeFile(join(cwd, 'scan.png'), 'changed');
  await assert.rejects(complete.execute(args, exec), /source changed/i);
});

test('CCPG reads save a bounded unverified source and never auto-bind or save failed reads', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ccpg-host-acquisition-'));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: new URL('../rules/', import.meta.url).pathname });
  const bin = join(await mkdtemp(join(tmpdir(), 'ccpg-host-bin-')), 'ccpg-cli');
  await writeFile(bin, `#!/bin/sh
case "$*" in
  'project-search +find --q 花园 --topk 2 --as user --format json') printf '%s\\n' '{"data":[{"project_code":"P001","project_name":"花园","access_token":"secret"}]}' ;;
  'datahub +project-list --project-code P001 --dver-type 2 --page 1 --page-size 20 --as user --format json') printf '%s\\n' '{"data":[{"project_code":"P001","project_name":"花园","area":100,"password":"secret"}]}' ;;
  *) printf '%s\\n' 'secret failure' >&2; exit 1 ;;
esac
`);
  await chmod(bin, 0o755);
  const previous = process.env.CCPG_CLI_BIN; process.env.CCPG_CLI_BIN = bin;
  t.after(() => { if (previous === undefined) delete process.env.CCPG_CLI_BIN; else process.env.CCPG_CLI_BIN = previous; });
  const tools = [];
  apply({ ...session(cwd), tools: { register(tool) { tools.push(tool); } }, webServer: { register() {} } });
  const invoke = async (name, args, signal) => JSON.parse(await tools.find((tool) => tool.name === name).execute({ projectId: 'p', ...args }, { sessionId: 's1', signal }));
  const found = await invoke('ccpg_project_find', { query: '花园', topk: 2 });
  assert.deepEqual(found.candidates, [{ code: 'P001', name: '花园' }]);
  assert.equal(found.verified, false);
  const fetched = await invoke('ccpg_project_fetch', { projectCode: 'P001' });
  assert.equal(fetched.material.parseStatus, 'needs-review');
  assert.equal(fetched.material.metadata.verification, 'unverified');
  const snapshot = JSON.parse(await readFile(join(cwd, fetched.material.metadata.snapshotPath), 'utf8'));
  assert.equal(snapshot.data[0].area, 100);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(JSON.stringify(fetched).includes('secret'), false);
  assert.equal(JSON.stringify(project.reload().chapters).includes(fetched.material.id), false);
  const count = Object.keys(project.state.materials).length;
  await assert.rejects(invoke('ccpg_project_fetch', { projectCode: 'bad' }), /cli-failed/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(invoke('ccpg_project_fetch', { projectCode: 'P001' }, cancelled.signal), /cancelled/);
  assert.equal(Object.keys(project.reload().materials).length, count);
});

test('native human command saves and confirms exact revision without granting an Agent confirmation tool', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ccpg-host-command-')); const rules = join(base, 'rules'); const cwd = join(base, 'session');
  await mkdir(join(rules, 'skills', 'one'), { recursive: true }); await mkdir(cwd);
  await writeFile(join(rules, 'skills', 'one', 'SKILL.md'), 'one'); await writeFile(join(rules, 'AGENTS.md'), 'rules');
  await writeFile(join(rules, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1', chapters: [{ id: 'one', title: 'One', order: 1, skill: 'skills/one/SKILL.md', dependencies: [], inputs: [], outputs: [{ id: 'body', name: 'Body', kind: 'body' }], blockers: [], confirmations: [{ id: 'owner', required: true }] }], resources: [], dataMappings: {} }));
  const project = await createProject({ sessionCwd: cwd, projectId: 'p', rulesDir: rules });
  const ready = await prepareChapter(project, { chapterId: 'one' }); await submitChapter(project, { token: ready.token, body: 'original' });
  const commands = []; const tools = [];
  apply({ ...session(cwd), commands: { register(definition) { commands.push(definition); } }, tools: { register(tool) { tools.push(tool); } }, webServer: { register() {} } });
  assert.equal(commands.length, 1); assert.equal(commands[0].name, 'ccpg-scheme'); assert.equal(commands[0].recordInput, false);
  assert.equal(tools.some((tool) => tool.name === 'chapter_confirm' || tool.name === 'chapter_skip'), false);
  const invoke = (payload, signal = new AbortController().signal) => commands[0].handler({ commandId: 'cmd-user-1', agent: { session: { id: 's1' } }, rawInput: JSON.stringify(payload), signal, attachments: [] });
  const saved = await invoke({ action: 'edit', projectId: 'p', chapterId: 'one', revision: project.state.revision, artifactRevision: 1, body: 'human edited' });
  assert.equal(saved.kind, 'success');
  const store = SchemeStore.load(cwd);
  assert.equal((await readFile(join(cwd, store.state.artifacts[store.state.chapters.one.artifactId].path, 'body.md'), 'utf8')), 'human edited');
  assert.equal(store.state.chapters.one.confirmed, false);
  const stale = await invoke({ action: 'confirm', projectId: 'p', chapterId: 'one', revision: project.state.revision, artifactRevision: 1 });
  assert.equal(stale.kind, 'error'); assert.match(stale.text, /revision/i);
  const confirmed = await invoke({ action: 'confirm', projectId: 'p', chapterId: 'one', revision: store.state.revision, artifactRevision: 2 });
  assert.equal(confirmed.kind, 'success'); assert.equal(SchemeStore.load(cwd).state.chapters.one.confirmed, true);
  const staleExport = await invoke({ action: 'export', projectId: 'p', revision: store.state.revision });
  assert.equal(staleExport.kind, 'error'); assert.match(staleExport.text, /revision/i);
  const exported = await invoke({ action: 'export', projectId: 'p', revision: SchemeStore.load(cwd).state.revision });
  assert.equal(exported.kind, 'success');
  const wordRevision = SchemeStore.load(cwd).state.revision;
  const word = await invoke({ action: 'export', projectId: 'p', revision: wordRevision, format: 'docx' });
  assert.equal(word.kind, 'success', word.text);
  const wordResult = JSON.parse(word.text).result;
  assert.ok(wordResult.wordPath.endsWith('.docx'));
  const archive = await JSZip.loadAsync(Buffer.from(wordResult.base64, 'base64'));
  assert.match(await archive.file('word/document.xml').async('string'), /human edited/);
  assert.equal(SchemeStore.load(cwd).state.revision, wordRevision);
  assert.equal((await invoke({ action: 'export', projectId: 'p', format: 'unknown' })).kind, 'error');
  assert.equal((await invoke({ action: 'export', projectId: 'p' })).kind, 'success');
  assert.equal((await invoke({ action: 'publish', projectId: 'p' })).kind, 'error');
  assert.equal((await invoke({ action: 'edit', projectId: '../other', body: 'x' })).kind, 'error');
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await invoke({ action: 'confirm', projectId: 'p' }, aborted.signal)).kind, 'error');
  assert.equal((await invoke({ action: 'edit', projectId: 'p', body: 'x'.repeat(1_000_001) })).kind, 'error');
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'));
  const { CommandRuntime } = await import(sdkRequire.resolve('@deepseek-ai/dsh-commands'));
  const commandCtx = new Context();
  const runtime = new CommandRuntime(commandCtx);
  runtime.register(commands[0]);
  const events = [];
  const agent = { ctx: commandCtx, session: { id: 's1', append(type, data) { events.push({ type, data }); } } };
  const executed = await runtime.execute(agent, `/ccpg-scheme ${JSON.stringify({ action: 'edit', projectId: 'p', chapterId: 'one', revision: SchemeStore.load(cwd).state.revision, artifactRevision: 2, body: 'native command body' })}`, [], new AbortController().signal);
  assert.equal(executed.result.kind, 'success');
  assert.deepEqual(events.map((event) => event.type), ['command/run', 'command/done']);
  assert.equal(events[0].data.source.kind, 'user');
  assert.equal(events[0].data.args, undefined);
});
