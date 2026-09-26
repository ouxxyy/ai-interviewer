/**
 * 最小 PDF 文本层提取（不引入 PDF 库）。
 *
 * 能力与边界（写进 `docs/web-materials.md`，不含糊）：
 * - 支持：未加密、带文本层的 PDF；`Tj` / `TJ` / `'` / `"` 文本算子；literal `(…)` 与 hex `<…>` 字符串；
 *   `FlateDecode` 流；有 `ToUnicode` CMap 时按 CMap 映射（中文简历常见）。
 * - 不支持：加密 PDF、扫描件（无文本层）、内嵌字体里没有 ToUnicode 且用自定义编码的极端情况。
 *   这些一律**明确失败**并提示改粘贴文本，绝不返回乱码冒充成功（见 materials.ts 的质量判据）。
 */
import { inflateRawSync, inflateSync } from 'node:zlib';

export interface PdfTextResult {
  text: string;
  /** 解出的内容流数量（FlateDecode 成功解压的）。 */
  streams: number;
  /** 含文本算子的流数量。 */
  textStreams: number;
  /** ToUnicode CMap 条目数（0＝没有可用映射）。 */
  cmapEntries: number;
}

interface StreamChunk {
  dict: string;
  data: Buffer;
}

/** 扫描 `stream … endstream`；dict 取关键字前 512 字节（够放 `/Filter /FlateDecode`）。 */
export function collectPdfStreams(buf: Buffer): StreamChunk[] {
  const out: StreamChunk[] = [];
  const hay = buf.toString('latin1');
  let pos = 0;
  for (;;) {
    const idx = hay.indexOf('stream', pos);
    if (idx < 0) break;
    // 排除 `endstream` 里的 `stream`
    if (hay.slice(Math.max(0, idx - 3), idx) === 'end') {
      pos = idx + 6;
      continue;
    }
    let start = idx + 6;
    if (hay[start] === '\r') start++;
    if (hay[start] === '\n') start++;
    const end = hay.indexOf('endstream', start);
    if (end < 0) break;
    let dataEnd = end;
    if (hay[dataEnd - 1] === '\n') dataEnd--;
    if (hay[dataEnd - 1] === '\r') dataEnd--;
    const dict = hay.slice(Math.max(0, idx - 512), idx);
    const raw = buf.subarray(start, dataEnd);
    const chunk = decodeStream(dict, raw);
    if (chunk) out.push({ dict, data: chunk });
    pos = end + 9;
  }
  return out;
}

function decodeStream(dict: string, raw: Buffer): Buffer | null {
  if (!/\/FlateDecode/.test(dict)) return raw;
  try {
    return inflateRawSync(raw);
  } catch {
    try {
      // 少数 PDF 用 zlib 头（带 0x78）而不是裸 deflate
      return inflateSync(raw);
    } catch {
      return null;
    }
  }
}

export type Cmap = Map<string, string>;

/** 解析 ToUnicode CMap（bfchar / bfrange）；键为十六进制码（大写），值为 Unicode 字符串。 */
export function parseToUnicodeCmap(text: string): Cmap {
  const map: Cmap = new Map();
  const hexToStr = (hex: string): string => {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    let s = '';
    for (let i = 0; i + 3 < clean.length + 1; i += 4) {
      const code = Number.parseInt(clean.slice(i, i + 4), 16);
      if (!Number.isNaN(code)) s += String.fromCharCode(code);
    }
    return s;
  };
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(m[1]!.toUpperCase(), hexToStr(m[2]!));
    }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = Number.parseInt(m[1]!, 16);
      const hi = Number.parseInt(m[2]!, 16);
      const dst = Number.parseInt(m[3]!, 16);
      const width = m[1]!.length;
      if (hi - lo > 4096) continue; // 防御：异常 CMap 不展开
      for (let c = lo; c <= hi; c++) {
        map.set(c.toString(16).toUpperCase().padStart(width, '0'), String.fromCharCode(dst + (c - lo)));
      }
    }
  }
  return map;
}

function decodeHexString(hex: string, cmap: Cmap): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length === 0) return '';
  // 有 CMap：优先按 2 字节码查表（CID 字体的常见形态）
  if (cmap.size > 0) {
    let out = '';
    let matched = 0;
    const codes: string[] = [];
    for (let i = 0; i + 3 < clean.length + 1; i += 4) {
      const code = clean.slice(i, i + 4).toUpperCase();
      codes.push(code);
      const mapped = cmap.get(code);
      if (mapped !== undefined) {
        out += mapped;
        matched++;
      } else {
        // 退化为 1 字节码表（部分 CMap 键长 2）
        const one = cmap.get(clean.slice(i, i + 2).toUpperCase());
        out += one ?? '';
      }
    }
    if (matched > 0) return out;
    // 1 字节码表
    let oneByte = '';
    let oneMatched = 0;
    for (let i = 0; i + 1 < clean.length + 1; i += 2) {
      const mapped = cmap.get(clean.slice(i, i + 2).toUpperCase());
      if (mapped !== undefined) {
        oneByte += mapped;
        oneMatched++;
      }
    }
    if (oneMatched > 0) return oneByte;
    void codes;
  }
  // 无 CMap：按 UTF-16BE / latin1 猜测
  let out = '';
  for (let i = 0; i + 1 < clean.length + 1; i += 2) {
    const code = Number.parseInt(clean.slice(i, i + 2), 16);
    out += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : '';
  }
  return out;
}

function decodeLiteralString(src: string, cmap: Cmap): string {
  // 解析 PDF literal string 的转义
  let bytes: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const next = src[++i];
    if (next === undefined) break;
    if (next === 'n') bytes.push(0x0a);
    else if (next === 'r') bytes.push(0x0d);
    else if (next === 't') bytes.push(0x09);
    else if (next === 'b') bytes.push(0x08);
    else if (next === 'f') bytes.push(0x0c);
    else if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && src[i + 1] !== undefined && /[0-7]/.test(src[i + 1]!)) oct += src[++i]!;
      bytes.push(Number.parseInt(oct, 8) & 0xff);
    } else bytes.push(next.charCodeAt(0));
  }
  // 有 1 字节码表时按字节查表（simple font + ToUnicode）
  if (cmap.size > 0) {
    let mapped = '';
    let hit = 0;
    for (const b of bytes) {
      const key = b.toString(16).toUpperCase().padStart(2, '0');
      const v = cmap.get(key);
      if (v !== undefined) {
        mapped += v;
        hit++;
      } else mapped += String.fromCharCode(b);
    }
    if (hit > 0) return mapped;
  }
  return Buffer.from(bytes).toString('latin1');
}

/** 从一个内容流里抽文本。 */
export function extractTextFromContentStream(content: string, cmap: Cmap): string {
  let out = '';
  let i = 0;
  let pendingHex: string | null = null;
  const pushText = (s: string): void => {
    out += s;
  };
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === '(') {
      // literal string
      let depth = 1;
      let j = i + 1;
      let buf = '';
      while (j < content.length && depth > 0) {
        const c = content[j]!;
        if (c === '\\') {
          buf += c + (content[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        buf += c;
        j++;
      }
      pendingHex = null;
      pushText(decodeLiteralString(buf, cmap));
      i = j + 1;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) break;
      pendingHex = content.slice(i + 1, end);
      pushText(decodeHexString(pendingHex, cmap));
      i = end + 1;
      continue;
    }
    if (ch === 'T' && (content[i + 1] === 'd' || content[i + 1] === 'D' || content[i + 1] === '*')) {
      out += '\n';
      i += 2;
      continue;
    }
    if (ch === 'E' && content[i + 1] === 'T') {
      out += '\n';
      i += 2;
      continue;
    }
    // TJ 数组里的数字是字距，不动；其它 token 直接跳过
    if (ch === ']' || ch === '[') {
      i++;
      continue;
    }
    i++;
  }
  return out;
}

export function extractPdfText(buf: Buffer): PdfTextResult {
  const streams = collectPdfStreams(buf);
  const cmap: Cmap = new Map();
  for (const s of streams) {
    const text = s.data.toString('latin1');
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
      for (const [k, v] of parseToUnicodeCmap(text)) cmap.set(k, v);
    }
  }
  let text = '';
  let textStreams = 0;
  for (const s of streams) {
    const content = s.data.toString('latin1');
    if (!content.includes('BT') || !/(Tj|TJ|'|")/.test(content)) continue;
    textStreams++;
    text += `${extractTextFromContentStream(content, cmap)}\n`;
  }
  return {
    text: normalizePdfText(text),
    streams: streams.length,
    textStreams,
    cmapEntries: cmap.size,
  };
}

/** 去掉 PDF 里常见的碎行与多余空白；保留段内单空格。 */
export function normalizePdfText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
