/**
 * 标定轮次的入库与合并（R3）。
 *
 * 起因：T2 收尾时第 2 轮是**覆盖式重跑**，第 1 轮的原始记录只剩在 git 里——
 * 而 `docs/t2-acceptance.md` §7 那张「声明 → 机器检查」表里却写着「两轮原始记录都在 runs.jsonl」，
 * 既是假的、又和括号里那句自相矛盾。修法不是改措辞，是把第 1 轮**搬进工作树**，
 * 并让「当前文件是哪一轮」由字段说话，而不是靠 git 推断。
 *
 * 规则：
 * - 每轮一个目录 `calibration/round-<n>/`（runs.jsonl ＋ summary.json）。
 * - `calibration/runs.jsonl` 是所有轮的合并视图，每行带 `round` 字段。
 * - 第 1 轮从 git 提交 `f983989^` 原样取回，只补 `round` 字段；取回后逐行与 git 版本比对
 *   （去掉 `round` 必须完全相等），比对失败就拒绝写入。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_T2_DIR } from '../t1r/evidence.js';
import { REPO_ROOT } from '../t1r/env.js';

export interface RoundRow {
  round: number;
  [key: string]: unknown;
}

const CAL_DIR = path.join(EVIDENCE_T2_DIR, 'calibration');
const RUNS = path.join(CAL_DIR, 'runs.jsonl');

function readJsonl(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function writeJsonl(file: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** 从 git 取回第 1 轮（只补 round 字段，取回后逐行比对）。 */
function importRound1FromGit(rev = 'f983989^'): { runs: number; summaryBytes: number; verified: boolean } {
  const dir = path.join(CAL_DIR, 'round-1');
  const rawRuns = execFileSync('git', ['show', `${rev}:evidence/t2/calibration/runs.jsonl`], { cwd: REPO_ROOT, encoding: 'utf8' });
  const original = rawRuns
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const tagged = original.map((r) => ({ round: 1, ...r }));
  mkdirSync(dir, { recursive: true });
  writeJsonl(path.join(dir, 'runs.jsonl'), tagged);

  const rawSummary = execFileSync('git', ['show', `${rev}:evidence/t2/calibration/summary.json`], { cwd: REPO_ROOT, encoding: 'utf8' });
  writeFileSync(path.join(dir, 'summary.json'), rawSummary);

  // 自检：去掉 round 之后必须与 git 版本逐行完全相等（证明只补了字段，没改数据）。
  const back = readJsonl(path.join(dir, 'runs.jsonl')).map((row) => {
    const rest = { ...row };
    delete rest.round;
    return rest;
  });
  const verified = JSON.stringify(back) === JSON.stringify(original);
  if (!verified) throw new Error(`round-1 取回后与 ${rev} 不一致，拒绝写入`);
  return { runs: tagged.length, summaryBytes: Buffer.byteLength(rawSummary), verified };
}

/** 把当前 runs.jsonl（= 最后一次覆盖式重跑，即第 2 轮）归档成 round-2/。 */
function archiveCurrentAsRound2(): { runs: number } {
  const dir = path.join(CAL_DIR, 'round-2');
  const rows = readJsonl(RUNS);
  if (rows.some((r) => r.round !== undefined)) return { runs: 0 }; // 已经归档过
  writeJsonl(path.join(dir, 'runs.jsonl'), rows.map((r) => ({ round: 2, ...r })));
  const summary = path.join(CAL_DIR, 'summary.json');
  if (existsSync(summary)) writeFileSync(path.join(dir, 'summary.json'), readFileSync(summary));
  return { runs: rows.length };
}

export interface RoundsResult {
  imported?: ReturnType<typeof importRound1FromGit>;
  archived?: ReturnType<typeof archiveCurrentAsRound2>;
  rounds: number[];
  rowsPerRound: Record<string, number>;
  totalRows: number;
  expectedRows: number;
}

/** 归档 + 合并 + 断言（条数必须 = 18 × 轮数）。 */
export function buildCalibrationRounds(): RoundsResult {
  const imported = existsSync(path.join(CAL_DIR, 'round-1', 'runs.jsonl')) ? undefined : importRound1FromGit();
  const archived = existsSync(path.join(CAL_DIR, 'round-2', 'runs.jsonl')) ? undefined : archiveCurrentAsRound2();

  const dirs = [1, 2].filter((n) => existsSync(path.join(CAL_DIR, `round-${n}`, 'runs.jsonl')));
  const rows: RoundRow[] = [];
  const rowsPerRound: Record<string, number> = {};
  for (const n of dirs) {
    const part = readJsonl(path.join(CAL_DIR, `round-${n}`, 'runs.jsonl')) as RoundRow[];
    rowsPerRound[`round-${n}`] = part.length;
    for (const r of part) {
      if (r.round !== n) throw new Error(`round-${n}/runs.jsonl 里有行的 round 不是 ${n}`);
      rows.push(r);
    }
  }
  writeJsonl(RUNS, rows);

  const expectedRows = 18 * dirs.length;
  if (rows.length !== expectedRows) throw new Error(`合并后 ${rows.length} 行，期望 18 × ${dirs.length} = ${expectedRows} 行`);
  return { ...(imported === undefined ? {} : { imported }), ...(archived === undefined ? {} : { archived }), rounds: dirs, rowsPerRound, totalRows: rows.length, expectedRows };
}
