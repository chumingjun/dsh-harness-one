// doc-tail 单测：字节尾部窗口 → 安全 UTF-8 文本的边界行为。
// 背景：scanDocTail 按 2KB 字节窗口截尾部，起点劈开多字节字符时
// toString('utf8') 产出 U+FFFD 乱码（中文文档必踩，issue 反馈「��圾」）。
import assert from 'node:assert/strict';

const { decodeTailWindow } = await import('../lib/doc-tail.js');

let passed = 0;
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
  .catch((error) => { console.error(`  ✗ ${name}\n${error.message}`); process.exitCode = 1; });

const text = (s) => Buffer.from(s, 'utf8');

await test('完整窗口原样解码（trimStart=false）', () => {
  assert.equal(decodeTailWindow(text('你好世界')), '你好世界');
  assert.equal(decodeTailWindow(text('plain ascii')), 'plain ascii');
  assert.equal(decodeTailWindow(text('')), '');
});

await test('起点劈开多字节字符：跳过续字节与其不完整的首字节（trimStart=true）', () => {
  // 「你好」各 3 字节；从第 1 字节起是「你」的后两个续字节 + 完整「好」
  const buf = text('你好').subarray(1);
  assert.equal(decodeTailWindow(buf, { trimStart: true }), '好');
  // 整段只剩「界」的后两个续字节 → 全部丢弃
  const buf2 = text('世界').subarray(4);
  assert.equal(decodeTailWindow(buf2, { trimStart: true }), '');
});

await test('trimStart=false 时起点续字节产出 U+FFFD（调用方没跳边界就维持原生行为）', () => {
  const buf = text('你好').subarray(1);
  assert.ok(decodeTailWindow(buf).includes('\uFFFD'));
});

await test('末尾半个字符（写入中）：截掉不完整序列，正文无损', () => {
  const buf = text('你好世界');
  assert.equal(decodeTailWindow(buf.subarray(0, buf.length - 1)), '你好世');
  assert.equal(decodeTailWindow(buf.subarray(0, buf.length - 2)), '你好世');
  assert.equal(decodeTailWindow(buf.subarray(0, buf.length - 4)), '你好');
  assert.equal(decodeTailWindow(text('你好').subarray(0, 1)), '');
});

await test('ASCII 末尾截断不受影响', () => {
  assert.equal(decodeTailWindow(text('abcde').subarray(0, 3)), 'abc');
});

await test('全窗口都是残字节时返回空串', () => {
  assert.equal(decodeTailWindow(text('你').subarray(1), { trimStart: true }), '');
});

await test('混合中英数字（agent 文稿常态）首尾劈字均无损', () => {
  const s = '1、清扫B1车库地面垃圾；<br/>2、设备充电。2026-08-30 更新';
  const buf = text(s);
  assert.equal(decodeTailWindow(buf, { trimStart: true }), s);
});

await test('混合文本劈字：字节窗口解码结果 = 原文对应字符切片', () => {
  const s = 'A中B文C测试D文本';
  const buf = text(s);
  // 逐字节起点 + 逐字节终点，解码结果必须恰好等于对应字符串切片（无 U+FFFD）
  for (let start = 0; start <= buf.length; start += 1) {
    for (let end = start; end <= buf.length; end += 1) {
      const got = decodeTailWindow(buf.subarray(start, end), { trimStart: true });
      assert.ok(!got.includes('\uFFFD'), `start=${start} end=${end} 产出乱码: ${JSON.stringify(got)}`);
      // 起点：若 start 落在字符中间，字符被整体丢弃；终点：不完整序列被截掉
      let expectStart = start;
      while (expectStart < end && (buf[expectStart] & 0xc0) === 0x80) expectStart += 1;
      if (expectStart < end) {
        const lead = buf[expectStart];
        const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (need > end - expectStart) return; // 整段只有半个字符，期望空
      }
      let expectEnd = end;
      if (expectEnd > expectStart) {
        let back = 1;
        while (expectEnd - back >= expectStart && (buf[expectEnd - back] & 0xc0) === 0x80) back += 1;
        const b = buf[expectEnd - back];
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        if (need > back) expectEnd -= back;
      }
      assert.equal(got, buf.toString('utf8', expectStart, expectEnd), `start=${start} end=${end}`);
    }
  }
});

console.log(`\ndoc-tail: ${passed} passed`);
