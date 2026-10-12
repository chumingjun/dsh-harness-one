// Test-only localhost host: no Desktop profile, runtime, model or cloud calls.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { editorCheckSource } from './ui-editor.test.mjs';
import { documentReview } from '../lib/document-review.js';
import { mapDocumentImages } from '../lib/document-images.js';
import { createCanvas } from '@napi-rs/canvas';
import { createWordDocument } from '../lib/word.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const esbuild = require('esbuild');
execFileSync('sh', ['dsh-plugins/build-scheme.sh'], { cwd: repo, stdio: 'inherit' });
const deps = fileURLToPath(new URL('../../../web/node_modules', import.meta.url));
const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const canvas = createCanvas(640, 360);
const drawing = canvas.getContext('2d');
drawing.fillStyle = '#f4f7fa'; drawing.fillRect(0, 0, 640, 360);
drawing.fillStyle = '#2c7b55'; drawing.fillRect(32, 60, 576, 260);
drawing.fillStyle = '#ffffff'; drawing.fillRect(72, 100, 140, 160); drawing.fillRect(260, 100, 140, 160); drawing.fillRect(450, 100, 120, 160);
drawing.fillStyle = '#16212c'; drawing.font = '24px sans-serif';
drawing.fillText('SITE PLAN — TEST FIXTURE', 32, 35);
for (const [label, x] of [['A', 120], ['B', 305], ['C', 495]]) drawing.fillText(label, x, 185);
const png = canvas.toBuffer('image/png').toString('base64');
const imagePath = 'materials/input/园林平面图.png';
const imageSource = `data:image/png;base64,${png}`;
const rich = `# 质量计划\n\n## 8.1.1 质量目标\n\n| 项目 | 数值 |\n| --- | --- |\n| 人员 | 55.25 |\n\n### 8.1.1.1 服务定位\n\n[证据](https://example.com/source)\n\n![平面图](<${imagePath}>)\n\n## 8.1.2 服务承诺\n\n- 巡检\n\n1. 秩序\n\n- [x] 已核验\n- [ ] 待确认\n\n## 待确认事项\n\n- 核验服务定位的适用范围`;
const chapters = [
  { id: 'one', code: '8.1', order: 1, title: '服务质量与现场成果以及长标题响应式展示', inputs: [{ id: 'brief', name: '项目基础资料', required: true }, { id: 'knowledge', name: '质量管理知识', required: true }], outputs: [{ id: '8.1.1', name: '8.1.1 质量目标', kind: 'body' }, { id: 'table', name: '8.1.1.2 服务承诺表', kind: 'attachment' }, { id: 'binary', name: '8.1.1.3 原始附件', kind: 'attachment' }, { id: 'text', name: '8.1.1.4 文字附件', kind: 'attachment' }], references: [{ title: '质量管理知识', inputIds: ['knowledge'], roles: ['knowledge'], status: 'downloaded', parseStatus: 'needs-vision' }] },
  { id: 'two', code: '8.2', order: 2, title: '复杂 HTML 原文', dependencies: ['one'], outputs: [{ id: 'body', name: '章节正文', kind: 'body', dependencies: ['one'] }], references: [{ title: '章节输出模板', roles: ['output-template'], status: 'downloaded' }] },
];
let revision = 3;
const initialArtifacts = {
  one: { chapterId: 'one', artifactId: 'art-one', revision: 1, body: rich, images: { [imagePath]: imageSource }, evidence: [{ source: '材料 A / 2026-10-10' }], confirmations: [{ id: 'c1', message: '核验人员数值', sectionCode: '8.1.1', sectionLabel: '8.1.1 质量目标', status: 'pending' }], attachments: [{ name: '表格.md', outputId: 'table', content: `|项目|数值|\n|---|---|\n|人数|55.25|\n\n![附件平面图](<${imagePath}>)\n\n## 待确认事项\n\n附件原文必须保留\n` }, { name: '园林图.png', outputId: 'binary', base64: png }, { name: 'text.txt', outputId: 'text', content: '原文\r\n55' }] },
  two: { chapterId: 'two', artifactId: 'art-two', revision: 1, body: '## 8.2.1 复杂表格\n\n<table><tr><td rowspan="2">复杂表格 55</td></tr><tr></tr></table>\n\n![外部图片](https://example.com/no-request.png)\n\n![本地图片](assets/photo.png)', attachments: [], evidence: [], confirmations: [{ id: 'c2', message: '核验第二章复杂表格', sectionCode: '8.2.1', sectionLabel: '8.2.1 复杂表格', status: 'pending' }] },
};
const artifacts = structuredClone(initialArtifacts);
const confirmed = new Set();
const publications = {};
let incomplete = false;
const state = () => ({ manifest: { id: '本地 UI 测试方案', chapters }, publications, projectCwd: '/test-only/in-memory', state: { projectId: 'test-scheme', revision, materials: { m1: { id: 'm1', name: '现场材料', parseStatus: 'complete' } }, chapters: Object.fromEntries(chapters.map(c => [c.id, { status: incomplete && c.id === 'one' ? 'pending' : confirmed.has(c.id) ? 'confirmed' : 'submitted', confirmed: confirmed.has(c.id), pendingConfirmations: !confirmed.has(c.id) && documentReview(artifacts[c.id]).items.some(item => !['confirmed', 'not_required'].includes(item.status)), revision: artifacts[c.id].revision, artifactId: incomplete && c.id === 'one' ? null : artifacts[c.id].artifactId, bindings: c.id === 'one' ? { brief: 'm1' } : {} }])) } });
const entry = `
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
if (new URLSearchParams(location.search).has('narrow')) document.body.classList.add('narrow');
const downloadBlobs = new Map();
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const url = createObjectURL(blob); downloadBlobs.set(url, blob); return url; };
document.addEventListener('click', async event => {
  const link = event.target.closest('a[download]');
  const blob = downloadBlobs.get(link?.href);
  if (!blob) return;
  event.preventDefault();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const files = {};
  if (link.download.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(bytes);
    for (const [path, item] of Object.entries(zip.files)) if (!item.dir) files[path] = /\\.(md|json)$/.test(path) ? await item.async('string') : [...await item.async('uint8array')];
  }
  window.__harness.downloads.push({ name: link.download, bytes: [...bytes], files });
  document.getElementById('download-check-results').textContent = JSON.stringify(window.__harness.downloads);
});
window.__ModuleLoader__ = { load({factory}) {
  const plugin = factory(name => { if(name === 'react') return React; if(name === 'react/jsx-runtime') return jsx; throw new Error('Unexpected host import '+name); });
  const commands = { execute: async (sessionId, input, attachments) => {
    window.__harness.calls.push({ sessionId, input, attachments });
    const result = await fetch('/harness/command', {method:'POST', body:input.slice('/ccpg-scheme '.length)}).then(r=>r.json());
    return result;
  }};
  const connection = { rpc: { async call(channel, endpoint, input) {
    const payload = input.args.payload;
    const path = payload.action === 'status' ? '' : '/' + payload.action;
    const url = new URL('/ccpg-scheme/api' + path, location.origin);
    if (payload.chapterId) url.searchParams.set('chapterId', payload.chapterId);
    return {ok:true, value:await fetch(url).then(r=>r.json())};
  }}};
  plugin.apply({ inject(names, callback) { callback({ effect(fn) { fn(); }, connection, betterSidebar: { registerTab(tab) { window.__harness.tab = tab; createRoot(document.getElementById('root')).render(React.createElement(tab.component, {sessionId:'test-session'})); } }, remote: {commands} }); } });
}};
window.__harness = { calls: [], downloads: [], incoming: () => fetch('/harness/incoming', {method:'POST'}), reset: () => fetch('/harness/reset', {method:'POST'}).then(()=>location.reload()) };
const script = document.createElement('script'); script.src='/client.js'; document.head.append(script);
const control = document.getElementById('simulate-incoming');
control.onclick = () => fetch('/harness/incoming', {method:'POST'}).then(() => window.dispatchEvent(new Event('focus')));
`;
const bundle = async (contents) => (await esbuild.build({ stdin: { contents, resolveDir, loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', nodePaths: [deps], logLevel: 'silent' })).outputFiles[0].text;
const boot = await bundle(entry);
const checks = await bundle(`import { Editor } from '@tiptap/core';\nimport { BODY_EXTENSIONS } from '../src/editor-extensions.mjs';\ntry { ${editorCheckSource.replace(/^import .+;$/gm, '')} } catch (error) { window.__editorTests = { error: String(error), stack: error.stack }; }\ndocument.getElementById('editor-check-results').textContent = JSON.stringify(window.__editorTests);\n`);
const client = readFileSync(new URL('../lib/client.js', import.meta.url));
const browser = readFileSync(new URL('../lib/browser.js', import.meta.url));
const html = '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scheme isolated UI harness</title><style>body{margin:0;font-family:system-ui,sans-serif}#root{min-height:100vh}body.narrow #root{width:380px;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit}*{box-sizing:border-box}</style><div id="root"></div><section aria-label="Test-only controls"><button id="simulate-incoming">模拟后台新成果</button><pre id="editor-check-results"></pre><pre id="download-check-results"></pre></section><script src="/boot.js"></script><script src="/editor-tests.js"></script></html>';
const browserHtml = '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>方案成果</title><style>html,body,#ccpg-scheme-browser{height:100%;margin:0;font-family:system-ui,sans-serif}*{box-sizing:border-box}</style><div id="ccpg-scheme-browser"></div><script src="/browser.js"></script></html>';
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'");
  const json = (value, code = 200) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/harness/command' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (payload.action === 'export') {
      if (payload.revision !== revision) return json({ ok: true, value: { result: { kind: 'error', text: 'revision conflict' } } });
      const result = { directory: '/test-only/in-memory/delivery' };
      if (payload.format === 'docx') {
        try {
          const markdown = chapters.map(c => mapDocumentImages(documentReview(artifacts[c.id]).body, source => decodeURIComponent(source) === imagePath ? '图片/园林图.png' : undefined)).join('\n\n');
          result.base64 = (await createWordDocument({ projectId: 'test-scheme', markdown, assets: [{ path: '图片/园林图.png', mime: 'image/png', base64: png }] })).toString('base64');
          result.wordPath = '/test-only/in-memory/delivery/完整方案.docx';
        } catch (error) { return json({ ok: true, value: { result: { kind: 'error', text: error.message } } }); }
      }
      return json({ ok: true, value: { result: { kind: 'success', text: JSON.stringify({ result }) } } });
    }
    if (payload.action === 'publish') {
      const ready = payload.chapterId
        ? confirmed.has(payload.chapterId) && payload.artifactRevision === artifacts[payload.chapterId]?.revision
        : confirmed.size === chapters.length;
      const result = payload.revision === revision && ready
        ? { kind: 'success', text: JSON.stringify({ result: { ok: true, verified: true, folder: { url: 'https://example.feishu.cn/drive/test-folder' }, body: { url: 'https://example.feishu.cn/docx/test-body' } } }) }
        : { kind: 'error', text: 'incomplete or changed delivery' };
      return json({ ok: true, value: { result } });
    }
    const artifact = artifacts[payload.chapterId];
    if (!artifact || payload.revision !== revision || payload.artifactRevision !== artifact.revision) return json({ ok: true, value: { result: { kind: 'error', text: 'revision conflict' } } });
    if (payload.action === 'edit') {
      if (payload.attachmentOutputId) artifact.attachments.find(item => item.outputId === payload.attachmentOutputId).content = payload.body;
      else {
        const review = documentReview({ body: payload.body, confirmations: [...documentReview(artifact).items, ...(payload.reviewItems || [])] });
        artifact.confirmations = review.items; artifact.body = review.body;
      }
      confirmed.delete(payload.chapterId); artifact.revision++; artifact.artifactId = 'art-' + artifact.chapterId + '-' + artifact.revision; revision++;
    }
    else if (payload.action === 'confirm') { artifact.confirmations.forEach(c => c.status = 'confirmed'); confirmed.add(payload.chapterId); revision++; }
    else return json({ ok: false, error: { message: 'unsupported test command' } });
    return json({ ok: true, value: { result: { kind: 'success', text: JSON.stringify({ revision }) } } });
  }
  if (url.pathname === '/harness/incoming') { artifacts.one.revision++; artifacts.one.artifactId = 'incoming-' + artifacts.one.revision; artifacts.one.body += '\n\n## 8.1.3 后台新版本'; artifacts.one.confirmations.push({ id: 'incoming-' + artifacts.one.revision, message: '核验后台新增事项', sectionCode: '8.1.3', sectionLabel: '8.1.3 后台新版本', status: 'pending' }); confirmed.delete('one'); revision++; return json({ revision }); }
  if (url.pathname === '/harness/reset') {
    Object.assign(artifacts, structuredClone(initialArtifacts)); confirmed.clear(); revision = 3; incomplete = url.searchParams.has('incomplete');
    if (url.searchParams.has('historical')) {
      artifacts.one.confirmations = [];
      artifacts.one.body = '> 本章依据 IN-001 输入材料编制。\n\n' + rich.replace('55.25', '待确认').split('\n\n## 待确认事项')[0];
    }
    for (const key of Object.keys(publications)) delete publications[key];
    if (url.searchParams.has('published')) {
      confirmed.add('one');
      publications.one = { verified: true, layoutVersion: 2, body: { token: 'original', url: 'https://example.feishu.cn/docx/original' }, schemeFolder: { token: 'shared', url: 'https://example.feishu.cn/drive/folder/shared' }, folder: { token: 'chapter', url: 'https://example.feishu.cn/drive/folder/chapter' }, chapters: [{ chapterId: 'one', artifactId: artifacts.one.artifactId, revision: artifacts.one.revision }], history: [
        { at: '2026-10-11T00:00:00Z', body: { url: 'https://example.feishu.cn/docx/original' }, folder: { url: 'https://example.feishu.cn/drive/folder/shared' } },
        { at: '2026-10-12T00:00:00Z', body: { url: 'https://example.feishu.cn/docx/original' }, folder: { url: 'https://example.feishu.cn/drive/folder/shared' } },
      ] };
    }
    return json({ ok: true });
  }
  if (url.pathname === '/ccpg-scheme/api') return json(state());
  if (url.pathname === '/ccpg-scheme/api/artifact') return json(artifacts[url.searchParams.get('chapterId')] || {});
  if (url.pathname === '/ccpg-scheme/api/export') {
    const portable = (text, prefix = '') => mapDocumentImages(text, source => decodeURIComponent(source) === imagePath ? `${prefix}图片/园林图.png` : undefined);
    return json({ revision, complete: confirmed.size === chapters.length, markdown: chapters.map(c => portable(documentReview(artifacts[c.id]).body)).join('\n\n'), assets: [{ path: '图片/园林图.png', mime: 'image/png', base64: png }], incomplete: chapters.filter(c => !confirmed.has(c.id)).map(c => ({code:c.code,title:c.title})), attachments: chapters.flatMap(c => artifacts[c.id].attachments.map(item => ({ ...item, chapterId: c.id, content: item.content == null ? undefined : portable(item.content, '../'), path: `${c.code}/${item.name}` }))) });
  }
  const files = { '/': [html, 'text/html'], '/browser': [browserHtml, 'text/html'], '/boot.js': [boot, 'text/javascript'], '/editor-tests.js': [checks, 'text/javascript'], '/client.js': [client, 'text/javascript'], '/browser.js': [browser, 'text/javascript'] };
  const file = files[url.pathname];
  if (!file) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': file[1] }); response.end(file[0]);
});
server.listen(43991, '127.0.0.1', () => console.log('Test-only UI harness: http://127.0.0.1:43991 (not actual DSH)'));
