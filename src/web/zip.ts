/**
 * 最小 ZIP 解包（读 DOCX 用）。
 *
 * 为什么自己写：DOCX 只是「ZIP ＋ word/document.xml」，而仓库现有依赖只有 ajv 与 ws。
 * 为了读一个 XML 引入原生解压依赖不划算（AGENTS：不为形式完整引入生产依赖）。
 * 支持 stored(0) 与 deflate(8) 两种存储方式——DOCX 正文必然是其中之一。
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** 解包全部条目；结构损坏时抛错（调用方转成「解析失败，可退回纯文本」）。 */
export function unzip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到中央目录结尾记录');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) throw new Error(`中央目录第 ${i + 1} 条损坏`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error(`条目 ${name} 的本地头损坏`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`条目 ${name} 使用了不支持的压缩方式 ${method}`);
    entries.push({ name, data });
  }
  return entries;
}

/** 读取单个条目；不存在返回 null。 */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const entry = unzip(buf).find((e) => e.name === name);
  return entry?.data ?? null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? all;
  });
}

/**
 * DOCX → 纯文本。
 *
 * 规则：`w:p` 段落 → 换行，`w:tab` → 制表符，`w:br` → 换行，其余标签剥掉；
 * 表格单元格（`w:tc`）之间加制表符，避免简历表格串成一坨。
 */
export function extractDocxText(buf: Buffer): string {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (xml === null) throw new Error('DOCX 内缺少 word/document.xml');
  let text = xml.toString('utf8');
  text = text.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  text = text.replace(/<w:br\b[^>]*\/?>/g, '\n');
  text = text.replace(/<\/w:tc>/g, '\t');
  text = text.replace(/<\/w:p>/g, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeXmlEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
