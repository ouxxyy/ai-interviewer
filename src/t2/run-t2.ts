/**
 * T2 标定与代表案例复测（真实模型，带对照）。
 *
 * 两件事：
 * 1. **对照标定**：同一批案例、同一批参数，跑三个提示词版本——`t1s`（T1-S 原版）、
 *    `t1r`（T1-R 版）、`t2`（T2 标定版）。没有对照就没有归因，所以三组数字都报。
 *    前两个版本的源码逐字取自 git（`src/t1r/calibration/prompts-*.ts`），运行前用
 *    `git hash-object` 核对与本仓库对应 revision 的 blob 完全一致，否则直接失败——
 *    「对照」必须是真对照。
 * 2. **代表案例重复评审 3 次**：两类代表岗位（产品／运营、研发／数据）× 应届／社招，
 *    检查档位是否跨两档、是否与人工预期一致、引用是否 100% 可定位。
 *
 * 案例选择规则（确定性，不按结果挑）：按 `cases.json` 顺序**每 4 个取 1，起始下标 0**。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runReview } from '../review/reviewer.js';
import { validateContractAuto } from '../contracts/validate.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { reviewPrompt, PROMPT_VERSION } from '../prompts/prompts.js';
import { reviewPrompt as reviewPromptT1r, PROMPT_VERSION as PROMPT_VERSION_T1R } from '../t1r/calibration/prompts-t1r.js';
import { reviewPrompt as reviewPromptT1s, PROMPT_VERSION as PROMPT_VERSION_T1S } from '../t1r/calibration/prompts-t1s.js';
import type { DashscopeTextClient } from '../clients/dashscope.js';
import type { Feedback, DimensionKey } from '../contracts/types.js';
import { REPO_ROOT } from '../t1r/env.js';
import { DashscopeReviewChannel, loadCases, type CaseRecord, type CallRecord } from '../t1r/chain-a.js';
import { latencyStats, type EvidenceWriter } from '../t1r/evidence.js';

const DIMS: DimensionKey[] = ['relevance', 'specificity', 'contribution', 'resultsReflection', 'structure'];
const ORDINAL: Record<string, number> = { 证据不足: 1, 部分清楚: 2, 充分清楚: 3 };

export type PromptVariant = 't1s' | 't1r' | 't2';

interface VariantSpec {
  id: PromptVariant;
  promptVersion: string;
  build: typeof reviewPrompt;
  /** 对照基线必须能追溯到 git revision；t2 是现行版，无冻结来源。 */
  frozenFrom?: { revision: string; file: string };
}

export const VARIANTS: Record<PromptVariant, VariantSpec> = {
  t1s: {
    id: 't1s',
    promptVersion: PROMPT_VERSION_T1S,
    build: reviewPromptT1s,
    frozenFrom: { revision: '71d1cc8', file: 'src/t1r/calibration/prompts-t1s.ts' },
  },
  t1r: {
    id: 't1r',
    promptVersion: PROMPT_VERSION_T1R,
    build: reviewPromptT1r,
    frozenFrom: { revision: '4079d2b', file: 'src/t1r/calibration/prompts-t1r.ts' },
  },
  t2: { id: 't2', promptVersion: PROMPT_VERSION, build: reviewPrompt },
};

/** 核对冻结基线确实是那个 revision 的逐字副本（对照实验的前提）。 */
export function verifyFrozenBaseline(variant: PromptVariant): { ok: boolean; detail: string } {
  const spec = VARIANTS[variant];
  if (!spec.frozenFrom) return { ok: true, detail: `${variant} 为现行版，无冻结来源` };
  const { revision, file } = spec.frozenFrom;
  try {
    const local = execFileSync('git', ['hash-object', file], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const remote = execFileSync('git', ['rev-parse', `${revision}:src/prompts/prompts.ts`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return local === remote
      ? { ok: true, detail: `${file} blob ${local.slice(0, 12)} == ${revision}:src/prompts/prompts.ts` }
      : { ok: false, detail: `${file} blob ${local} ≠ ${revision} 的 ${remote}` };
  } catch (e) {
    return { ok: false, detail: `无法核对冻结基线（${(e as Error).message.slice(0, 120)}）` };
  }
}

export interface CaseRunRecord {
  variant: PromptVariant;
  promptVersion: string;
  caseId: string;
  flawType: string;
  outcomeKind: 'ok' | 'degraded';
  attempts: number;
  firstAttemptOk: boolean;
  attemptLog: Array<{ attempt: number; ok: boolean; cause?: string; detail?: string }>;
  schemaOk: boolean;
  contractVersionSeen: string;
  quotesTotal: number;
  quotesLocated: number;
  quoteFailures: string[];
  levels: Record<string, string>;
  calls: CallRecord[];
  latencyMs: number;
}

export interface VariantSummary {
  variant: PromptVariant;
  promptVersion: string;
  runs: number;
  ok: number;
  degraded: number;
  firstAttemptOk: number;
  firstAttemptRate: number;
  quotesLocated: number;
  quotesTotal: number;
  quoteLocateRate: number;
  retryCauses: Record<string, number>;
  latencyMs: ReturnType<typeof latencyStats>;
  totalTokens: number;
  structureDegraded: number;
}

/** 独立复核一遍引用（不看流水线结论）：三档维度的 quote 必须能在回答原文里定位。 */
function independentQuoteCheck(answer: string, fb: Feedback): { total: number; located: number; failures: string[] } {
  const failures: string[] = [];
  let total = 0;
  let located = 0;
  for (const [dim, d] of Object.entries(fb.dimensions)) {
    if (d.level === '无法判断') {
      if (d.quote !== null) failures.push(`${dim}: 无法判断但带了引用`);
      continue;
    }
    if (!d.quote) {
      failures.push(`${dim}: 三档缺少引用`);
      continue;
    }
    total++;
    const loc = locateQuote(answer, d.quote.text);
    if (!loc.located) {
      failures.push(`${dim}: ${loc.reason}`);
      continue;
    }
    if (loc.start !== d.quote.start || loc.end !== d.quote.end) {
      failures.push(`${dim}: 区间与独立复算不一致`);
      continue;
    }
    located++;
  }
  return { total, located, failures };
}

async function runOne(
  client: DashscopeTextClient,
  variant: PromptVariant,
  c: CaseRecord,
  evidence: EvidenceWriter,
  opts: { tag?: string } = {},
): Promise<CaseRunRecord> {
  const spec = VARIANTS[variant];
  const prompt = spec.build({ questionText: c.questionText, answerText: c.firstAnswer, turnIds: ['t1'], textVersion: 'raw', isRewrite: false });
  const channel = new DashscopeReviewChannel(client, prompt, {
    jsonMode: true,
    enableThinking: false,
    rawSink: (attempt, raw) => evidence.writeText(`raw/${opts.tag ?? variant}-${c.id}.attempt${attempt}.txt`, raw, false),
  });
  const attemptLog: Array<{ attempt: number; ok: boolean; cause?: string; detail?: string }> = [];
  const startedAt = Date.now();
  const outcome = await runReview({
    channel,
    basisText: c.firstAnswer,
    turnIds: ['t1'],
    textVersion: 'raw',
    questionId: 'q1',
    maxRetries: 2,
    onAttempt: (attempt, r) =>
      attemptLog.push({ attempt, ok: r.ok, ...(r.cause === undefined ? {} : { cause: r.cause }), ...(r.detail === undefined ? {} : { detail: r.detail }) }),
  });
  const latencyMs = Date.now() - startedAt;
  const fb = outcome.feedback as Feedback;
  const schema = validateContractAuto('feedback', fb);
  const qc = independentQuoteCheck(c.firstAnswer, fb);
  const levels = Object.fromEntries(DIMS.map((d) => [d, fb.dimensions[d].level]));

  return {
    variant,
    promptVersion: spec.promptVersion,
    caseId: c.id,
    flawType: c.flawType,
    outcomeKind: outcome.kind,
    attempts: outcome.attempts,
    firstAttemptOk: attemptLog[0]?.ok === true,
    attemptLog,
    schemaOk: schema.ok,
    contractVersionSeen: String((fb as unknown as { contractVersion?: string }).contractVersion ?? ''),
    quotesTotal: qc.total,
    quotesLocated: qc.located,
    quoteFailures: qc.failures,
    levels,
    calls: channel.calls,
    latencyMs,
  };
}

/** 确定性抽样：每 4 个取 1，起始下标 0（不按结果挑案例）。 */
export function calibrationBatch(all: CaseRecord[], stride = 4): CaseRecord[] {
  const out: CaseRecord[] = [];
  for (let i = 0; i < all.length; i += stride) out.push(all[i]!);
  return out;
}

function summarize(variant: PromptVariant, runs: CaseRunRecord[]): VariantSummary {
  const retryCauses: Record<string, number> = {};
  for (const r of runs) {
    for (const a of r.attemptLog) if (!a.ok && a.cause) retryCauses[a.cause] = (retryCauses[a.cause] ?? 0) + 1;
  }
  const quotesTotal = runs.reduce((a, r) => a + r.quotesTotal, 0);
  const quotesLocated = runs.reduce((a, r) => a + r.quotesLocated, 0);
  const ok = runs.filter((r) => r.outcomeKind === 'ok').length;
  const firstAttemptOk = runs.filter((r) => r.firstAttemptOk).length;
  return {
    variant,
    promptVersion: VARIANTS[variant].promptVersion,
    runs: runs.length,
    ok,
    degraded: runs.length - ok,
    firstAttemptOk,
    firstAttemptRate: Number((firstAttemptOk / Math.max(1, runs.length)).toFixed(3)),
    quotesLocated,
    quotesTotal,
    quoteLocateRate: Number((quotesLocated / Math.max(1, quotesTotal)).toFixed(3)),
    retryCauses,
    latencyMs: latencyStats(runs.map((r) => r.latencyMs)),
    totalTokens: runs.reduce((a, r) => a + r.calls.reduce((b, c) => b + c.totalTokens, 0), 0),
    structureDegraded: runs.filter((r) => r.quoteFailures.some((f) => f.startsWith('structure'))).length,
  };
}

export interface CalibrationResult {
  batch: Array<{ id: string; stage: string; track: string; flawType: string }>;
  selectionRule: string;
  baselineProvenance: Array<{ variant: PromptVariant; ok: boolean; detail: string }>;
  summaries: Record<PromptVariant, VariantSummary>;
  runs: CaseRunRecord[];
}

export async function runCalibration(client: DashscopeTextClient, evidence: EvidenceWriter, opts: { stride?: number } = {}): Promise<CalibrationResult> {
  const all = loadCases();
  const batch = calibrationBatch(all, opts.stride ?? 4);
  const provenance = (['t1s', 't1r', 't2'] as PromptVariant[]).map((v) => ({ variant: v, ...verifyFrozenBaseline(v) }));
  const bad = provenance.filter((p) => !p.ok);
  if (bad.length > 0) throw new Error(`对照基线校验失败，拒绝标定：${bad.map((b) => b.detail).join('; ')}`);

  evidence.truncateJsonl('calibration/runs.jsonl');
  const runs: CaseRunRecord[] = [];
  for (const variant of ['t1s', 't1r', 't2'] as PromptVariant[]) {
    for (const c of batch) {
      const rec = await runOne(client, variant, c, evidence, { tag: `cal-${variant}` });
      runs.push(rec);
      evidence.appendJsonl('calibration/runs.jsonl', [rec]);
    }
  }
  const summaries = {
    t1s: summarize('t1s', runs.filter((r) => r.variant === 't1s')),
    t1r: summarize('t1r', runs.filter((r) => r.variant === 't1r')),
    t2: summarize('t2', runs.filter((r) => r.variant === 't2')),
  };
  return {
    batch: batch.map((c) => ({ id: c.id, stage: c.stage, track: c.track, flawType: c.flawType })),
    selectionRule: `cases.json 顺序每 ${opts.stride ?? 4} 个取 1、起始下标 0（确定性抽样，不按结果挑案例）`,
    baselineProvenance: provenance,
    summaries,
    runs,
  };
}

// ---------------- 代表案例重复评审 ----------------

export interface RepresentativeCaseResult {
  caseId: string;
  stage: string;
  track: string;
  flawType: string;
  expectedDims: Record<string, string>;
  runs: Array<{
    run: number;
    outcomeKind: 'ok' | 'degraded';
    attempts: number;
    levels: Record<string, string>;
    quotesTotal: number;
    quotesLocated: number;
    quoteFailures: string[];
    latencyMs: number;
    tokens: number;
  }>;
  perDimension: Record<string, { levels: string[]; spread: number; hasUndetermined: boolean; matchesExpected: boolean | null; withinOneBand: boolean }>;
  levelSpreadOk: boolean;
  matchesExpected: boolean;
  quotesAllLocated: boolean;
}

export interface RepresentativeResult {
  repeats: number;
  cases: RepresentativeCaseResult[];
  verdict: { totalCases: number; levelSpreadOk: number; matchesExpected: number; quotesAllLocated: number };
}

const REPRESENTATIVE_IDS = ['C01', 'C07', 'C13', 'C19'];

export async function runRepresentative(
  client: DashscopeTextClient,
  evidence: EvidenceWriter,
  opts: { repeats?: number; caseIds?: string[] } = {},
): Promise<RepresentativeResult> {
  const repeats = opts.repeats ?? 3;
  const all = loadCases();
  const wanted = opts.caseIds ?? REPRESENTATIVE_IDS;
  const cases = wanted.map((id) => all.find((c) => c.id === id)).filter((c): c is CaseRecord => c !== undefined);
  evidence.truncateJsonl('representative/runs.jsonl');
  const out: RepresentativeCaseResult[] = [];

  for (const c of cases) {
    const runs: RepresentativeCaseResult['runs'] = [];
    for (let i = 1; i <= repeats; i++) {
      const rec = await runOne(client, 't2', c, evidence, { tag: `rep-${c.id}-r${i}` });
      runs.push({
        run: i,
        outcomeKind: rec.outcomeKind,
        attempts: rec.attempts,
        levels: rec.levels,
        quotesTotal: rec.quotesTotal,
        quotesLocated: rec.quotesLocated,
        quoteFailures: rec.quoteFailures,
        latencyMs: rec.latencyMs,
        tokens: rec.calls.reduce((a, x) => a + x.totalTokens, 0),
      });
      evidence.appendJsonl('representative/runs.jsonl', [{ caseId: c.id, ...runs[runs.length - 1]! }]);
    }

    const perDimension: RepresentativeCaseResult['perDimension'] = {};
    for (const d of DIMS) {
      const levels = runs.map((r) => r.levels[d] ?? '');
      const ordinals = levels.map((l) => ORDINAL[l]).filter((n): n is number => n !== undefined);
      const spread = ordinals.length === 0 ? 0 : Math.max(...ordinals) - Math.min(...ordinals);
      const expected = c.expectedDims[d];
      perDimension[d] = {
        levels,
        spread,
        hasUndetermined: levels.includes('无法判断'),
        matchesExpected: expected === undefined ? null : levels.length > 0 && levels.every((l) => l === expected),
        withinOneBand: spread <= 1 && !(levels.includes('无法判断') && ordinals.length > 0),
      };
    }
    const levelSpreadOk = DIMS.every((d) => perDimension[d]!.withinOneBand);
    const matchesExpected = DIMS.every((d) => perDimension[d]!.matchesExpected !== false);
    const quotesAllLocated = runs.every((r) => r.quoteFailures.length === 0 && r.quotesLocated === r.quotesTotal);
    out.push({
      caseId: c.id,
      stage: c.stage,
      track: c.track,
      flawType: c.flawType,
      expectedDims: c.expectedDims,
      runs,
      perDimension,
      levelSpreadOk,
      matchesExpected,
      quotesAllLocated,
    });
  }

  return {
    repeats,
    cases: out,
    verdict: {
      totalCases: out.length,
      levelSpreadOk: out.filter((c) => c.levelSpreadOk).length,
      matchesExpected: out.filter((c) => c.matchesExpected).length,
      quotesAllLocated: out.filter((c) => c.quotesAllLocated).length,
    },
  };
}

void path;
