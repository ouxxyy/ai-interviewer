/**
 * 结构化日志（网页入口）。
 *
 * 红线（MYW-85）：日志禁止记录简历全文、完整转写与音频内容；密钥一律不落日志。
 * 这条不靠「记得住了」——所有字段过 `redact()`：
 * - 命中凭证值或 `sk-*` 模式 → 替换为 `<redacted>`；
 * - 长文本（>120 字）只留长度与前 20 字，避免把 JD／经历／转写整段写进日志；
 * - 二进制（Buffer/ArrayBuffer）只留字节数。
 */
import { assertNoSecret } from '../t1r/env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_TEXT = 120;
const PREVIEW = 20;

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let out = value;
    const key = process.env.DASHSCOPE_API_KEY;
    if (key !== undefined && key.length >= 8) out = out.split(key).join('<redacted>');
    out = out.replace(/sk-[A-Za-z0-9._-]{12,}/g, '<redacted>');
    if (out.length > MAX_TEXT) out = `${out.slice(0, PREVIEW)}…<len=${value.length}>`;
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}B>`;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v);
    return out;
  }
  return String(value);
}

export interface LogRecord {
  at: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export class Logger {
  readonly records: LogRecord[] = [];
  constructor(
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly level: LogLevel = 'info',
  ) {}

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const record: LogRecord = { at: new Date().toISOString(), level, event, ...(redactValue(fields) as Record<string, unknown>) };
    this.records.push(record);
    if (this.records.length > 2000) this.records.shift();
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) >= order.indexOf(this.level)) {
      const line = JSON.stringify(record);
      // 双保险：即便 redact 漏了某个嵌套形状，也不让凭证写出去。
      try {
        assertNoSecret(line);
      } catch {
        this.sink(JSON.stringify({ at: record.at, level, event, note: '日志内容命中凭证防线，已丢弃' }));
        return;
      }
      this.sink(line);
    }
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.log('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.log('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.log('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.log('error', event, fields); }
}
