/**
 * T1-R 证据落盘。
 *
 * 两条边界：
 * 1. 每个写出的文本都先过 `assertNoSecret()`——凭证不可能因为「忘了检查」而进入证据文件。
 * 2. 大体积音频放 `data/t1r/`（gitignore），入库的只有 1–2 个短片段；验收记录里给出
 *    路径／时长／字节数／sha256，保证复核者能核对「记录描述的那段音频」确实是这段。
 */
import { appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertNoSecret, REPO_ROOT } from './env.js';

export const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence', 't1r');
export const DATA_DIR = path.join(REPO_ROOT, 'data', 't1r');

export interface ArtifactRecord {
  /** 相对仓库根的路径。 */
  path: string;
  kind: 'json' | 'jsonl' | 'wav' | 'pcm' | 'md' | 'txt';
  bytes: number;
  sha256?: string;
  durationSeconds?: number;
  committed: boolean;
  note?: string;
}

export class EvidenceWriter {
  readonly artifacts: ArtifactRecord[] = [];
  readonly notes: Array<{ at: string; key: string; value: unknown }> = [];

  constructor(
    readonly evidenceDir = EVIDENCE_DIR,
    readonly dataDir = DATA_DIR,
  ) {
    mkdirSync(this.evidenceDir, { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });
  }

  /** 写 JSON 到入库的 evidence 目录。 */
  writeJson(relName: string, data: unknown): string {
    const text = JSON.stringify(data, null, 2);
    assertNoSecret(text);
    const full = path.join(this.evidenceDir, relName);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `${text}\n`);
    this.record(full, 'json', text.length, true);
    return full;
  }

  /** 写 JSON 到 gitignore 的 data 目录（大体积／原始响应）。 */
  writeDataJson(relName: string, data: unknown): string {
    const text = JSON.stringify(data, null, 2);
    assertNoSecret(text);
    const full = path.join(this.dataDir, relName);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `${text}\n`);
    this.record(full, 'json', text.length, false);
    return full;
  }

  writeText(relName: string, text: string, committed = true): string {
    assertNoSecret(text);
    const base = committed ? this.evidenceDir : this.dataDir;
    const full = path.join(base, relName);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    this.record(full, 'txt', text.length, committed);
    return full;
  }

  /** 逐行追加 JSONL（事件日志）；每次调用都重新过密钥防线。 */
  appendJsonl(relName: string, rows: unknown[], committed = true): string {
    const text = rows.map((r) => JSON.stringify(r)).join('\n');
    assertNoSecret(text);
    const base = committed ? this.evidenceDir : this.dataDir;
    const full = path.join(base, relName);
    mkdirSync(path.dirname(full), { recursive: true });
    appendFileSync(full, `${text}\n`);
    this.record(full, 'jsonl', text.length + 1, committed);
    return full;
  }

  note(key: string, value: unknown): void {
    this.notes.push({ at: new Date().toISOString(), key, value });
  }

  private record(full: string, kind: ArtifactRecord['kind'], size: number, committed: boolean): void {
    const rel = path.relative(REPO_ROOT, full);
    const existing = this.artifacts.findIndex((a) => a.path === rel);
    const stat = statSync(full);
    const rec: ArtifactRecord = { path: rel, kind, bytes: stat.size, committed };
    void size;
    if (existing >= 0) this.artifacts[existing] = rec;
    else this.artifacts.push(rec);
  }
}

/** 目录清单：用于验收记录里「data/ 下这些原始音频存在」的可核对证据。 */
export function listDir(dir: string): Array<{ name: string; bytes: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => ({ name: n, bytes: statSync(path.join(dir, n)).isDirectory() ? 0 : statSync(path.join(dir, n)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function latencyStats(values: number[]): { n: number; min: number; p50: number; p95: number; max: number; mean: number } {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? Number.NaN,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1] ?? Number.NaN,
    mean: Number((sum / Math.max(1, s.length)).toFixed(1)),
  };
}
