import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const word = async (delivery) => {
  const module = await import('../lib/word.js');
  return module.createWordDocument(delivery);
};

test('Word preserves Chinese headings, tables, lists, inline formatting and original image position', async () => {
  const delivery = {
    projectId: 'demo',
    markdown: '# 项目质量方案\n\n## 4.1 质量目标\n\n前文 **加粗** *强调* `编号` [公司](https://example.com)\n\n![平面图](<图片/one/平面图.png>)\n\n后文\n\n|指标|目标|\n|---|---|\n|满意度|95%|\n\n- 检查\n- 复核\n\n3. 开始\n4. 完成\n',
    assets: [{ path: '图片/one/平面图.png', base64: png.toString('base64'), mime: 'image/png' }],
    attachments: [{ name: '附件说明.md', content: '只在附件中出现' }],
  };
  const bytes = await word(delivery);
  assert.deepEqual(await word(delivery), bytes);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /项目质量方案/);
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /w:tbl/);
  assert.match(xml, /满意度/);
  assert.match(xml, /95%/);
  assert.match(xml, /w:b/);
  assert.match(xml, /w:i/);
  assert.match(xml, /w:hyperlink/);
  assert.equal((xml.match(/<w:numPr>/g) || []).length, 4);
  assert.ok(xml.indexOf('前文') < xml.indexOf('<w:drawing>'));
  assert.ok(xml.indexOf('<w:drawing>') < xml.indexOf('后文'));
  assert.match(xml, /descr="平面图"/);
  assert.doesNotMatch(xml, /只在附件中出现/);
  const images = Object.values(zip.files).filter((file) => !file.dir && file.name.startsWith('word/media/'));
  assert.equal(images.length, 1);
  assert.deepEqual(await images[0].async('nodebuffer'), png);
  assert.match(await zip.file('word/numbering.xml').async('string'), /w:start w:val="3"/);
});

test('identical delivery produces byte-identical Word exports', async () => {
  const delivery = { projectId: 'demo', markdown: '# 方案\n\n正文\n', assets: [] };
  assert.deepEqual(await word(delivery), await word(delivery));
});

test('Word rejects missing or remote images rather than dropping them', async () => {
  for (const source of ['图片/missing.png', 'https://example.com/image.png']) {
    await assert.rejects(word({ markdown: `![图片](${source})`, assets: [] }), /image.*unavailable|local.*image/i);
  }
});

test('Word rejects unsupported HTML rather than silently changing its structure', async () => {
  await assert.rejects(word({ markdown: '<table><tr><td>合并表格</td></tr></table>', assets: [] }), /HTML.*unsupported/i);
});
