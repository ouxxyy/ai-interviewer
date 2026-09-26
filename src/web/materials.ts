/**
 * 材料准备（MYW-85「材料准备」）。
 *
 * 做什么：
 * - 粘贴 JD／经历（永远可用，是 PDF／DOCX 提取失败时的退路）；
 * - 文本型 PDF／DOCX 提取 → 可编辑文本 → 用户确认（`CandidateMaterials.confirmed`）；
 * - 提取失败/乱码/扫描件：**给出具体原因与退回建议**，不返回乱码冒充成功；
 * - 「虚构演示」样例：`synthetic=true`，与真实报告隔离（D9）。
 *
 * 上传文件只在 `data/web/tmp/uploads/` 落一份临时文件（供解析与排障），解析结束即删；
 * 会话被删除时也会连带清理该会话的临时文件（见 store.deleteSession）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractDocxText } from './zip.js';
import { extractPdfText } from './pdf-text.js';
import type { WebPaths } from './paths.js';

export type MaterialKind = 'pdf' | 'docx' | 'txt' | 'md' | 'unknown';

export type MaterialParseFailure =
  | 'unsupported_type'
  | 'corrupt_file'
  | 'scanned_pdf'
  | 'empty_text'
  | 'garbled_text'
  | 'too_large';

export type MaterialParseOutcome =
  | { ok: true; kind: MaterialKind; text: string; chars: number; extractor: 'internal' | 'system'; note: string }
  | { ok: false; kind: MaterialKind; reason: MaterialParseFailure; message: string; hint: string };

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export function detectKind(filename: string, contentType?: string): MaterialKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt') return 'txt';
  if (ext === '.md') return 'md';
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('officedocument.wordprocessingml')) return 'docx';
  if (ct.startsWith('text/plain')) return 'txt';
  return 'unknown';
}

/**
 * 文本质量：够不够当材料用（中文／英文／数字都算有效字符）。
 *
 * 只判「提取出来的是不是文字」——长度要求由 /materials 的字段校验单独把关（经历 ≥30 字），
 * 这里门槛低（≥20 有效字符），避免把「内容短」误报成「解析失败」。
 */
export const MIN_VALID_CHARS = 20;
export function textQuality(text: string): { usable: boolean; validChars: number; replacementChars: number; ratio: number } {
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  const validChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]/g) ?? []).length;
  const total = Math.max(text.length, 1);
  return { usable: validChars >= MIN_VALID_CHARS && replacementChars / total < 0.05, validChars, replacementChars, ratio: Number((validChars / total).toFixed(3)) };
}

/** 系统级兜底（macOS 自带 textutil / poppler 的 pdftotext）；不存在就返回 null，绝不联网。 */
function systemExtract(kind: MaterialKind, file: string): string | null {
  try {
    if (kind === 'docx' && process.platform === 'darwin' && existsSync('/usr/bin/textutil')) {
      return execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    }
    if (kind === 'pdf') {
      const which = execFileSync('/usr/bin/which', ['pdftotext'], { encoding: 'utf8' }).trim();
      if (which !== '') return execFileSync(which, ['-layout', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    }
  } catch {
    return null;
  }
  return null;
}

export interface ParseInput {
  filename: string;
  buffer: Buffer;
  contentType?: string;
  /** 解析时临时文件落地的目录（默认不落盘）。 */
  tmpDir?: string;
  /** 关联的会话 id，写进临时文件名，便于删除会话时连带清理。 */
  sessionId?: string;
}

export interface ParseResult {
  outcome: MaterialParseOutcome;
  /** 临时文件绝对路径（已删除时仍返回路径，便于审计「确实落过又删了」）。 */
  tmpFile: string | null;
  tmpRemoved: boolean;
}

/**
 * 解析上传材料。任何失败都返回结构化原因，不抛异常——调用方据此把用户引回粘贴。
 */
export function parseMaterialFile(input: ParseInput): ParseResult {
  const kind = detectKind(input.filename, input.contentType);
  let tmpFile: string | null = null;
  let tmpRemoved = false;
  /** 所有返回路径都走这里：先删临时文件，再返回结果（tmpRemoved 必须是真实的删除结果）。 */
  const finish = (outcome: MaterialParseOutcome): ParseResult => {
    if (tmpFile !== null) {
      rmSync(tmpFile, { force: true });
      tmpRemoved = true;
    }
    return { outcome, tmpFile, tmpRemoved };
  };
  {
    if (input.buffer.length > MAX_UPLOAD_BYTES) {
      return finish({ ok: false, kind, reason: 'too_large', message: `文件 ${input.buffer.length} 字节，超过上限 ${MAX_UPLOAD_BYTES} 字节`, hint: '请只上传简历文本部分，或直接粘贴经历文本' });
    }
    if (input.tmpDir) {
      mkdirSync(input.tmpDir, { recursive: true });
      const safe = path.basename(input.filename).replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
      tmpFile = path.join(input.tmpDir, `${input.sessionId ?? 'anon'}-${Date.now()}-${safe}`);
      writeFileSync(tmpFile, input.buffer);
    }

    if (kind === 'unknown') {
      return finish({
        ok: false,
        kind,
        reason: 'unsupported_type',
        message: `不支持的文件类型：${input.filename}`,
        hint: '首版支持文本型 PDF、DOCX 与纯文本；其它格式请把内容粘贴进来',
      });
    }
    if (kind === 'txt' || kind === 'md') {
      const text = input.buffer.toString('utf8');
      const quality = textQuality(text);
      if (!quality.usable) {
        return finish({ ok: false, kind, reason: 'empty_text', message: `文本可用字符只有 ${quality.validChars} 个`, hint: '文件内容过少或为空，请直接粘贴经历文本' });
      }
      return finish({ ok: true, kind, text: text.trim(), chars: text.trim().length, extractor: 'internal', note: '纯文本直读' });
    }

    let internalText = '';
    let internalError: string | null = null;
    try {
      if (kind === 'docx') internalText = extractDocxText(input.buffer);
      else {
        const pdf = extractPdfText(input.buffer);
        internalText = pdf.text;
        if (pdf.textStreams === 0) internalError = '未找到文本层（很可能是扫描件）';
      }
    } catch (e) {
      internalError = (e as Error).message;
    }

    const internalQuality = textQuality(internalText);
    if (internalQuality.usable) {
      return finish({ ok: true, kind, text: internalText, chars: internalText.length, extractor: 'internal', note: `仓库内置解析器（有效字符 ${internalQuality.validChars}）` });
    }

    // 内置解析器拿不到像样文本时，试本机系统工具；再不行就明确失败。
    let systemText: string | null = null;
    if (tmpFile) {
      systemText = systemExtract(kind, tmpFile);
    }
    if (systemText !== null && textQuality(systemText).usable) {
      return finish({ ok: true, kind, text: systemText.trim(), chars: systemText.trim().length, extractor: 'system', note: `内置解析器不足（有效字符 ${internalQuality.validChars}），改用本机系统工具` });
    }

    const reason: MaterialParseFailure =
      internalText.trim().length === 0 && internalError !== null && !internalError.includes('文本层')
        ? 'corrupt_file'
        : internalError !== null && internalError.includes('文本层')
          ? 'scanned_pdf'
          : internalText.trim().length === 0
            ? 'empty_text'
            : 'garbled_text';
    const messages: Record<MaterialParseFailure, { message: string; hint: string }> = {
      scanned_pdf: { message: '这个 PDF 没有文本层（扫描件或图片版）', hint: '请把简历里的文字直接粘贴到文本框，或改用 DOCX／纯文本' },
      garbled_text: { message: `提取到的文字不可用（有效字符 ${internalQuality.validChars}${internalError ? `；${internalError}` : ''}）`, hint: '可能是字体编码特殊或文件损坏；请直接粘贴经历文本' },
      empty_text: { message: '这个文件里没有可提取的文字', hint: '请直接粘贴经历文本' },
      corrupt_file: { message: `文件解析失败${internalError ? `：${internalError}` : ''}`, hint: '确认文件没有加密或损坏；也可以直接粘贴经历文本' },
      unsupported_type: { message: '不支持的文件类型', hint: '请粘贴文本' },
      too_large: { message: '文件超过大小上限', hint: '请粘贴文本' },
    };
    return finish({ ok: false, kind, reason, ...messages[reason] });
  }
}

/** 虚构演示样例（D9）：入口与报告页持续标记「虚构演示」，不进真实报告统计。 */
export const DEMO_MATERIALS = {
  label: '虚构演示',
  stage: '社招' as const,
  targetRole: '内容运营（虚构岗位）',
  jd: `【以下为虚构演示材料，不是真实岗位】
岗位：内容运营（增长方向）
职责：负责社区内容选题与作者运营；策划并落地征稿类活动，对投稿量与互动率负责；
与产品、设计协作完成活动页与规则设计；沉淀可复用的活动 SOP。
要求：2 年以上内容运营经验；能独立完成活动策划与数据复盘；有跨团队协作经验。`,
  experience: `【以下为虚构演示材料，不是真实经历】
我在某社区做过一年半内容运营，主要负责征稿活动。去年毕业季我策划了「毕业故事」征稿：
先用问卷收集了 200 份同学偏好，把主题定成毕业故事；联系 5 个院系宣传委员帮忙扩散，
自己写了两篇范文做冷启动。活动两周收到 143 篇投稿，比上一期增长约 80%。
复盘时发现投稿集中在 3 个院系，其他院系参与度低，原因是宣传委员只在群里发了一次通知，
没有二次触达。后来我把「二次触达」写进了活动 SOP。`,
  note: '演示材料用于让用户在没有材料时也能看到完整流程；演示会话在统计里单独计数，不进入真实报告。',
} as const;

export function writeUploadTmp(paths: WebPaths, sessionId: string, filename: string, buffer: Buffer): string {
  mkdirSync(paths.uploadTmpDir, { recursive: true });
  const safe = path.basename(filename).replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
  const file = path.join(paths.uploadTmpDir, `${sessionId}-${Date.now()}-${safe}`);
  writeFileSync(file, buffer);
  return file;
}
