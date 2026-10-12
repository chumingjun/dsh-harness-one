import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentBytes, attachmentText, safeDownloadName, safeImageSource, needsMarkdownFallback } from '../src/content.mjs';

test('attachment downloads preserve exact UTF-8 and binary bytes', () => {
  assert.equal(new TextDecoder().decode(attachmentBytes({ content: '原文\r\n55' })), '原文\r\n55');
  assert.deepEqual([...attachmentBytes({ base64: 'AP9V' })], [0, 255, 85]);
  assert.throws(() => attachmentBytes({ base64: 'not base64!' }), /base64/);
  assert.throws(() => attachmentBytes({ path: 'file:///secret' }), /content/);
  assert.equal(attachmentText({ name: 'note.md', base64: 'NTUNCg==' }), '55\r\n');
  assert.equal(attachmentText({ name: 'binary.bin', base64: 'AP9V' }), null);
  assert.equal(attachmentText({ name: 'bad.txt', base64: '/w==' }), null);
});

test('download names cannot become paths and images never request external URLs', () => {
  assert.equal(safeDownloadName('../../a\\b.md'), 'a_b.md');
  assert.equal(safeDownloadName('..'), 'attachment');
  assert.equal(safeImageSource('https://tracking.example/x.png'), '');
  assert.equal(safeImageSource('file:///secret.png'), '');
  assert.equal(safeImageSource('data:image/svg+xml;base64,PHN2Zz4='), '');
  assert.equal(safeImageSource('data:image/png;base64,AP9V'), 'data:image/png;base64,AP9V');
  assert.equal(safeImageSource('data:image/png;base64,%%%'), '');
});

test('HTML stays in explicit Markdown fallback, ordinary Markdown can be rich edited', () => {
  assert.equal(needsMarkdownFallback('<table><tr><td rowspan="2">55</td></tr></table>'), true);
  assert.equal(needsMarkdownFallback('# title\n[link](https://example.com)\n|a|b|\n|-|-|\n|1|2|'), false);
  assert.equal(needsMarkdownFallback('![local](assets/photo.png)'), true);
  assert.equal(needsMarkdownFallback('![remote](https://tracking.example/photo.png)'), true);
  assert.equal(needsMarkdownFallback('![reference][photo]\n\n[photo]: file:///secret.png'), true);
  assert.equal(needsMarkdownFallback('![data](data:image/png;base64,AP9V)'), false);
});

export const editorCheckSource = `
import { Editor } from '@tiptap/core';
import { BODY_EXTENSIONS } from '../src/editor-extensions.mjs';
const body = '# Round trip\\n\\n| Name | Value |\\n| --- | --- |\\n| Exact | 55.25 |\\n\\n[Evidence](https://example.com/source)\\n\\n![Plan](https://example.com/no-request.png)\\n\\n- bullet\\n\\n1. ordered\\n\\n- [x] completed\\n- [ ] pending';
const element = document.createElement('div');
document.body.append(element);
const editor = new Editor({ element, extensions: BODY_EXTENSIONS, content: body });
editor.commands.insertContent('Changed ');
const saved = editor.storage.markdown.getMarkdown();
const second = new Editor({ extensions: BODY_EXTENSIONS, content: saved });
const checks = ['55.25', 'https://example.com/source', 'https://example.com/no-request.png', '- [x] completed', '- [ ] pending', 'bullet', 'ordered'];
const structures = ['bulletList', 'orderedList', 'taskList'].map(type => ({ type, count: second.getJSON().content.filter(n => n.type === type).length }));
editor.storage.schemePlaceholderHighlight.reviewItems = [{ sectionCode: '8.1.1' }];
editor.commands.setContent('## 8.1.1 核验位置\\n\\n待确认 [待补充人数] {{项目名称}}\\n\\n\`TODO\`', false);
const reviewHeading = element.querySelector('h2.scheme-review-heading')?.textContent === '8.1.1 核验位置';
const placeholderSource = editor.storage.markdown.getMarkdown();
const highlighted = [...element.querySelectorAll('.scheme-placeholder-highlight')].map(node => node.textContent);
const displayOnly = !editor.storage.markdown.getMarkdown().includes('<mark');
const localElement = document.createElement('div');
document.body.append(localElement);
const localSource = 'materials/input/园林图.png';
const localData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const localEditor = new Editor({ element: localElement, extensions: BODY_EXTENSIONS.map(extension => extension.name === 'image' ? extension.configure({ images: { [localSource]: localData } }) : extension), content: 'Before\\n\\n![园林图](<' + localSource + '>)\\n\\nAfter' });
localEditor.commands.insertContent('Updated ');
const localSaved = localEditor.storage.markdown.getMarkdown();
const decodedLocal = decodeURIComponent(localSaved);
const localPreserved = decodedLocal.includes(localSource) && !localSaved.includes('data:') && localElement.querySelector('img')?.src === localData && decodedLocal.indexOf('Before') < decodedLocal.indexOf(localSource) && decodedLocal.indexOf(localSource) < decodedLocal.indexOf('After');
editor.commands.setContent('已确认', false);
window.__editorTests = { saved, checks: [...checks.map(value => ({ value, ok: second.storage.markdown.getMarkdown().includes(value) })), ...structures.map(({ type, count }) => ({ value: type, ok: count === 1 })), { value: 'editor placeholder highlights', ok: JSON.stringify(highlighted) === JSON.stringify(['待确认', '[待补充人数]', '{{项目名称}}']) }, { value: 'editor review heading', ok: reviewHeading }, { value: 'display only', ok: displayOnly && placeholderSource.includes('待补充人数') }, { value: 'resolved highlight removed', ok: element.querySelectorAll('.scheme-placeholder-highlight,.scheme-review-heading').length === 0 }], structures, tables: second.getJSON().content.filter(n => n.type === 'table').length, images: second.getJSON().content.filter(n => n.type === 'image').length, externalImages: element.querySelectorAll('img[src^="https:"]').length };
editor.destroy(); second.destroy(); element.remove();
window.__editorTests.localImage = { markdown: localSaved, displayed: localElement.querySelector('img')?.getAttribute('src') || null };
window.__editorTests.checks.push({ value: 'snapshot image display and portable source round trip', ok: localPreserved });
localEditor.destroy(); localElement.remove();
`;
