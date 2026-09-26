/**
 * 材料解析测试（离线）：DOCX（自造 ZIP，走 deflate 分支）、PDF（未压缩文本流 / ToUnicode CMap / 无文本层）、
 * 失败原因与退路、临时文件「落过又删」、虚构演示样例隔离。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { extractDocxText, decodeXmlEntities, unzip } from '../src/web/zip.js';
import { extractPdfText } from '../src/web/pdf-text.js';
import { DEMO_MATERIALS, detectKind, parseMaterialFile, textQuality } from '../src/web/materials.js';
import { REPO_ROOT, webPaths } from '../src/web/paths.js';

// ---------- 测试用最小 ZIP 写入（只为造 DOCX，不进产品代码） ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]!) & 0xff]!;
  return (c ^ -1) >>> 0;
}

function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const compressed = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(xml, 'utf8') },
  ]);
}

/** 未压缩文本流的 PDF；可选 ToUnicode CMap 与内容流。 */
function makePdf(opts: { content?: string; cmap?: string; objects?: number } = {}): Buffer {
  const content = opts.content ?? 'BT /F1 12 Tf 72 720 Td (Senior content operations resume with measurable results) Tj ET';
  const parts: string[] = ['%PDF-1.4\n'];
  parts.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  parts.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  parts.push('3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n');
  parts.push(`4 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  if (opts.cmap !== undefined) {
    parts.push(`5 0 obj << /Length ${opts.cmap.length} >>\nstream\n${opts.cmap}\nendstream\nendobj\n`);
  }
  parts.push('trailer << /Root 1 0 R >>\n%%EOF\n');
  return Buffer.from(parts.join(''), 'latin1');
}

function tmpRoot(label: string): string {
  const dir = path.join(REPO_ROOT, 'data', `web-test-mat-${label}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('DOCX：段落/制表/实体/换行还原成纯文本', () => {
  const docx = makeDocx(['张三　产品运营', '负责征稿活动 &amp; 作者运营', '结果：投稿 143 篇，增长 80%']);
  const text = extractDocxText(docx);
  assert.match(text, /张三/);
  assert.match(text, /征稿活动 & 作者运营/);
  assert.match(text, /143 篇/);
  assert.equal(text.includes('<w:p>'), false);
  assert.equal(decodeXmlEntities('&lt;a&gt;&amp;&#65;'), '<a>&A');
  const entries = unzip(docx).map((e) => e.name);
  assert.deepEqual(entries, ['[Content_Types].xml', 'word/document.xml']);
});

test('PDF：未压缩文本流可提取', () => {
  const pdf = makePdf();
  const r = extractPdfText(pdf);
  assert.equal(r.textStreams, 1);
  assert.match(r.text, /Senior content operations resume/);
});

test('PDF：ToUnicode CMap 十六进制串按 CMap 映射（中文简历常见形态）', () => {
  const cmap = `beginbfchar\n<0001> <4E2D>\n<0002> <6587>\n<0003> <7B80>\n<0004> <5386>\nendbfchar`;
  const content = 'BT /F1 12 Tf 72 720 Td <0001000200030004> Tj ET';
  const r = extractPdfText(makePdf({ content, cmap }));
  assert.equal(r.cmapEntries, 4);
  assert.equal(r.text, '中文简历');
});

test('PDF：没有文本层（扫描件）→ textStreams=0，走明确失败而不是乱码', () => {
  const pdf = makePdf({ content: '0.1 0.1 0.1 rg 100 100 200 200 re f' });
  const r = extractPdfText(pdf);
  assert.equal(r.textStreams, 0);
  assert.equal(r.text, '');
});

test('parseMaterialFile：DOCX 成功路径 + 临时文件确实落过又删掉', () => {
  const root = tmpRoot('docx');
  const paths = webPaths(root);
  const docx = makeDocx(['李四', '负责毕业季征稿活动的整体策划与落地，联系五个院系宣传委员，活动两周收到 143 篇投稿，比上一期增长约 80%']);
  const r = parseMaterialFile({ filename: 'resume.docx', buffer: docx, tmpDir: paths.uploadTmpDir, sessionId: 's-x' });
  assert.equal(r.outcome.ok, true);
  if (r.outcome.ok) {
    assert.equal(r.outcome.kind, 'docx');
    assert.equal(r.outcome.extractor, 'internal');
    assert.match(r.outcome.text, /143 篇/);
  }
  assert.notEqual(r.tmpFile, null);
  assert.equal(r.tmpRemoved, true);
  assert.equal(existsSync(path.join(paths.uploadTmpDir, 's-x-')), false);
  assert.deepEqual(readdirSync(paths.uploadTmpDir), []);
  rmSync(root, { recursive: true, force: true });
});

test('parseMaterialFile：扫描件 PDF → scanned_pdf，并给出「直接粘贴」的退路', () => {
  const r = parseMaterialFile({ filename: 'scan.pdf', buffer: makePdf({ content: 'q 0 0 595 842 re f' }) });
  assert.equal(r.outcome.ok, false);
  if (!r.outcome.ok) {
    assert.equal(r.outcome.reason, 'scanned_pdf');
    assert.match(r.outcome.hint, /粘贴/);
  }
});

test('parseMaterialFile：损坏的 DOCX → corrupt_file，不抛异常', () => {
  const r = parseMaterialFile({ filename: 'broken.docx', buffer: Buffer.from('this is not a zip at all') });
  assert.equal(r.outcome.ok, false);
  if (!r.outcome.ok) assert.equal(r.outcome.reason, 'corrupt_file');
});

test('parseMaterialFile：不支持的扩展名 → unsupported_type', () => {
  const r = parseMaterialFile({ filename: 'resume.pages', buffer: Buffer.from('x') });
  assert.equal(r.outcome.ok, false);
  if (!r.outcome.ok) assert.equal(r.outcome.reason, 'unsupported_type');
  assert.equal(detectKind('a.PDF'), 'pdf');
  assert.equal(detectKind('a.docx'), 'docx');
  assert.equal(detectKind('a.txt'), 'txt');
  assert.equal(detectKind('a.bin', 'application/pdf'), 'pdf');
});

test('parseMaterialFile：超过大小上限 → too_large', () => {
  const r = parseMaterialFile({ filename: 'big.docx', buffer: Buffer.alloc(13 * 1024 * 1024) });
  assert.equal(r.outcome.ok, false);
  if (!r.outcome.ok) assert.equal(r.outcome.reason, 'too_large');
});

test('parseMaterialFile：纯文本直读，内容过少则失败', () => {
  const ok = parseMaterialFile({ filename: 'exp.txt', buffer: Buffer.from('负责社区内容运营，策划毕业季征稿活动，两周收到 143 篇投稿，比上一期增长约 80%。') });
  assert.equal(ok.outcome.ok, true);
  const tooShort = parseMaterialFile({ filename: 'exp.txt', buffer: Buffer.from('你好') });
  assert.equal(tooShort.outcome.ok, false);
  if (!tooShort.outcome.ok) assert.equal(tooShort.outcome.reason, 'empty_text');
});

test('文本质量判据：乱码比例高就不算可用', () => {
  const good = textQuality('负责社区内容运营并策划征稿活动，两周收到 143 篇投稿，比上一期增长约 80%');
  assert.equal(good.usable, true);
  const garbled = textQuality('\uFFFD'.repeat(60));
  assert.equal(garbled.usable, false);
  assert.ok(garbled.ratio < 0.5);
});

test('虚构演示样例：明确标注、内容足够长、可被 /materials 接受', () => {
  assert.equal(DEMO_MATERIALS.label, '虚构演示');
  assert.match(DEMO_MATERIALS.jd, /虚构演示材料/);
  assert.match(DEMO_MATERIALS.experience, /虚构演示材料/);
  assert.ok(DEMO_MATERIALS.jd.trim().length >= 10);
  assert.ok(DEMO_MATERIALS.experience.trim().length >= 30);
  assert.ok(DEMO_MATERIALS.experience.length >= 200, '演示经历应接近 400 字，足以出题');
});
