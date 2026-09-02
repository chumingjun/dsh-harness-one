// 文稿墙流卡 docTail 的纯逻辑层（零依赖，可 node 直测）：
// 字节尾部窗口 → 安全 UTF-8 文本。窗口起点按字节截断，落在多字节字符中间时
// toString('utf8') 会产出 U+FFFD 乱码（中文文档必踩），先跳过起点处不完整的
// 字符序列再解码；文件正在写入时窗口末尾也可能停在半个字符上，一并丢掉。
// 两处各最多丢 3 字节（UTF-8 最长 4 字节），正文无损。
export function decodeTailWindow(buf, { trimStart = false } = {}) {
  let begin = 0;
  if (trimStart) {
    while (begin < buf.length && (buf[begin] & 0xc0) === 0x80) begin += 1;
    const lead = begin < buf.length ? buf[begin] : 0;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > 1 && need > buf.length - begin) begin += 1;
  }
  let end = buf.length;
  for (let back = 1; back <= 4 && end - back >= begin; back += 1) {
    const b = buf[end - back];
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (need > back) end -= back;
    break;
  }
  return begin >= end ? '' : buf.toString('utf8', begin, end);
}
