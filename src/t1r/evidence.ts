/**
 * T1-R 证据落盘。
 *
 * 两条边界：
 * 1. 每个写出的文本都先过 `assertNoSecret()`——凭证不可能因为「忘了检查」而进入证据文件。
 * 2. 大体积音频放 `data/t1r/`（gitignore），入库的只有 1–2 个短片段；验收记录里给出
 *    路径／时长／字节数／sha256，保证复核者能核对「记录描述的那段音频」确实是这段。
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoSecret, REPO_ROOT } from './env.js';
import { CONTRACT_VERSION } from '../contracts/version.js';

// 新运行单独落在当前契约目录，不能覆盖历史 0.1/0.2 真实证据。
export const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence', 't1r', `v${CONTRACT_VERSION}`);
export const DATA_DIR = path.join(REPO_ROOT, 'data', 't1r', `v${CONTRACT_VERSION}`);
export const EVIDENCE_T2_DIR = path.join(REPO_ROOT, 'evidence', 't2', `v${CONTRACT_VERSION}`);
export const DATA_T2_DIR = path.join(REPO_ROOT, 'data', 't2', `v${CONTRACT_VERSION}`);

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

  /** 清空一个 JSONL（工具有多次运行时应重置，避免证据文件把两轮结果混在一起）。 */
  truncateJsonl(relName: string, committed = true): void {
    const base = committed ? this.evidenceDir : this.dataDir;
    const full = path.join(base, relName);
    if (existsSync(full)) rmSync(full);
  }

  note(key: string, value: unknown): void {
    this.notes.push({ at: new Date().toISOString(), key, value });
  }

  private record(full: string, kind: ArtifactRecord['kind'], size: number, committed: boolean): void {
    const rel = path.relative(REPO_ROOT, full);
    const existing = this.artifacts.findIndex((a) => a.path === rel);
    const stat = statSync(full);
    // 每条产物都记 sha256（F1-3）：只记路径与字节数时，复核者无法确认文件没被替换过。
    const rec: ArtifactRecord = { path: rel, kind, bytes: stat.size, sha256: fileSha256(full), committed };
    void size;
    if (existing >= 0) this.artifacts[existing] = rec;
    else this.artifacts.push(rec);
  }
}

/** 单文件 sha256（流式读取，避免大文件一次性进内存）。 */
export function fileSha256(full: string): string {
  return createHash('sha256').update(readFileSync(full)).digest('hex');
}

/**
 * 从磁盘重算 manifest 里每条产物的字节数与 sha256（内容一概不动）。
 * 用于「补齐历史产物的摘要」这种纯派生操作——samples/音频本身必须原封不动。
 */
export function refreshManifest(manifestPath: string): { total: number; added: number; changed: number } {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifacts?: ArtifactRecord[] };
  let added = 0;
  let changed = 0;
  for (const a of parsed.artifacts ?? []) {
    const full = path.resolve(REPO_ROOT, a.path);
    if (!existsSync(full)) continue;
    const before = a.sha256;
    a.bytes = statSync(full).size;
    a.sha256 = fileSha256(full);
    if (before === undefined) added++;
    else if (before !== a.sha256) changed++;
  }
  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { total: (parsed.artifacts ?? []).length, added, changed };
}

/**
 * 由目录内容生成 manifest（字节数 + sha256 + 是否入库）。
 * 与 `manifest:refresh` 的区别：这个从**磁盘**重建清单，所以不需要重跑产生证据的模型调用，
 * 任何时候都能重新生成一份可逐条核对的清单。
 */
export function writeManifestFromDir(dir: string, manifestPath: string, excluded: string[] = []): { total: number; bytes: number } {
  const rows: ArtifactRecord[] = [];
  const walk = (cur: string): void => {
    if (!existsSync(cur)) return;
    for (const name of readdirSync(cur).sort()) {
      const full = path.join(cur, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(REPO_ROOT, full);
      if (excluded.includes(rel) || name.startsWith('.')) continue;
      const ext = path.extname(name).slice(1);
      rows.push({
        path: rel,
        kind: (['json', 'jsonl', 'wav', 'pcm', 'md', 'txt'].includes(ext) ? ext : 'txt') as ArtifactRecord['kind'],
        bytes: statSync(full).size,
        sha256: fileSha256(full),
        committed: !rel.startsWith('data/'),
      });
    }
  };
  walk(dir);
  writeFileSync(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), artifacts: rows }, null, 2)}\n`);
  return { total: rows.length, bytes: rows.reduce((a, r) => a + r.bytes, 0) };
}

/**
 * 逐条核对 manifest 与磁盘：把「manifest 已核对」从口头声明变成机器检查。
 * 返回不符项清单——空数组才代表真的对得上。
 */
export function verifyManifest(manifestPath: string): { total: number; mismatches: Array<{ path: string; reason: string }> } {
  const mismatches: Array<{ path: string; reason: string }> = [];
  if (!existsSync(manifestPath)) return { total: 0, mismatches: [{ path: manifestPath, reason: 'manifest 不存在' }] };
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifacts?: ArtifactRecord[] };
  const rows = parsed.artifacts ?? [];
  for (const a of rows) {
    const full = path.resolve(REPO_ROOT, a.path);
    if (!existsSync(full)) {
      mismatches.push({ path: a.path, reason: '磁盘上不存在' });
      continue;
    }
    const bytes = statSync(full).size;
    if (bytes !== a.bytes) mismatches.push({ path: a.path, reason: `字节数记录 ${a.bytes} 实际 ${bytes}` });
    const sha = fileSha256(full);
    if (sha !== a.sha256) mismatches.push({ path: a.path, reason: `sha256 记录 ${String(a.sha256).slice(0, 12)} 实际 ${sha.slice(0, 12)}` });
  }
  return { total: rows.length, mismatches };
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
