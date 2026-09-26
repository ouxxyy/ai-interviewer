/**
 * 预登记的控制实验：`structure` 维度「散文口径 vs 机械口径」配对比较。
 *
 * 判据**从 `preregistration` 的 `criteria.json` 读**，不写死在代码里——先写文件再开跑，
 * 跑完不能改判据。批次、重复数、模型参数同样来自那份文件。
 *
 * 两版提示词的差异**只有 structure 那一条 bullet**（由 `reviewPrompt` 的 `structureHint` 控制，
 * 默认 `prose` 与 T2 定稿逐字相同）；「引用必须连续逐字、禁止省略号拼接」等真实性约束一字未动。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runReview } from '../review/reviewer.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { reviewPrompt, type StructureHintVariant } from '../prompts/prompts.js';
import type { Feedback, DimensionKey } from '../contracts/types.js';
import type { DashscopeTextClient } from '../clients/dashscope.js';
import { REPO_ROOT } from '../t1r/env.js';
import { DashscopeReviewChannel, loadCases, type CallRecord } from '../t1r/chain-a.js';
import { latencyStats, type EvidenceWriter } from '../t1r/evidence.js';

const DIMS: DimensionKey[] = ['relevance', 'specificity', 'contribution', 'resultsReflection', 'structure'];
const EXPERIMENT_DIR = path.join(REPO_ROOT, 'evidence', 't3', 'structure-experiment');

export interface Preregistration {
  preregisteredAt: string;
  batch: { cases: string[]; oralTransform: { baseCase: string; id: string; rule: string; why: string } };
  variants: Record<string, string>;
  repeats: number;
  model: { id: string; enableThinking: boolean; jsonMode: boolean; temperature: number; maxRetries: number };
  criteria: Array<{ id: string; description: string; metric: string; compare: string }>;
  decision: Record<string, string>;
}

export function loadPreregistration(): Preregistration {
  const file = path.join(EXPERIMENT_DIR, 'criteria.json');
  if (!existsSync(file)) throw new Error('找不到预登记判据 criteria.json——先写判据再开跑');
  return JSON.parse(readFileSync(file, 'utf8')) as Preregistration;
}

export interface ExperimentItem {
  id: string;
  sourceCaseId: string;
  answer: string;
  questionText: string;
  /** 就地应用的确定性变换说明（口语化改写）。 */
  transform: string | null;
}

/** 按预登记规则构造批次；`C13-oral` 是确定性变换，可复算。 */
export function buildBatch(prereg: Preregistration): ExperimentItem[] {
  const cases = loadCases();
  const { baseCase, id: oralId, rule } = prereg.batch.oralTransform;
  return prereg.batch.cases.map((id) => {
    if (id === oralId) {
      const c = cases.find((x) => x.id === baseCase);
      if (!c) throw new Error(`找不到口语化变换的基准案例 ${baseCase}`);
      const transformed = c.firstAnswer.replace(/[。？]/g, '，');
      return { id, sourceCaseId: c.id, answer: transformed, questionText: c.questionText, transform: rule };
    }
    const c = cases.find((x) => x.id === id);
    if (!c) throw new Error(`找不到案例 ${id}`);
    return { id, sourceCaseId: c.id, answer: c.firstAnswer, questionText: c.questionText, transform: null };
  });
}

export interface ExperimentRun {
  itemId: string;
  variant: StructureHintVariant;
  repeat: number;
  outcomeKind: 'ok' | 'degraded';
  attempts: number;
  firstAttemptOk: boolean;
  levels: Record<string, string>;
  /** structure 维度是否判「无法判断」（判据 2 的分子）。 */
  structureUndetermined: boolean;
  quotes: Array<{ dim: string; level: string; text: string; located: boolean; start: number | null; end: number | null; matchType: string | null }>;
  quotesTotal: number;
  quotesLocated: number;
  latencyMs: number;
  tokens: number;
  calls: CallRecord[];
}

export interface VariantMetrics {
  variant: StructureHintVariant;
  runs: number;
  /** 判据 1：三档维度引用里 locateQuote 定位成功的比例。 */
  quoteLocateRate: number;
  quotesTotal: number;
  quotesLocated: number;
  /** 判据 2：structure 判「无法判断」的比例。 */
  structureUndeterminedRate: number;
  structureUndetermined: number;
  /** 辅助指标（不参与判定）。 */
  firstAttemptRate: number;
  degraded: number;
  structureQuoteLocateRate: number;
  latencyMs: ReturnType<typeof latencyStats>;
  tokens: number;
}

export interface ExperimentResult {
  preregisteredAt: string;
  ranAt: string;
  model: string;
  batch: Array<{ id: string; sourceCaseId: string; transform: string | null; answerChars: number }>;
  repeats: number;
  totalCalls: number;
  metrics: Record<string, VariantMetrics>;
  verdict: {
    passed: boolean;
    /** 逐条判据的判定结果，由 criteria.json 驱动。 */
    checks: Array<{ id: string; description: string; metric: string; compare: string; prose: number; mechanical: number; satisfied: boolean }>;
    conclusion: string;
  };
}

function metricsFor(variant: StructureHintVariant, runs: ExperimentRun[]): VariantMetrics {
  const quotesTotal = runs.reduce((a, r) => a + r.quotesTotal, 0);
  const quotesLocated = runs.reduce((a, r) => a + r.quotesLocated, 0);
  const structureQuotes = runs.flatMap((r) => r.quotes.filter((q) => q.dim === 'structure'));
  const structureLocated = structureQuotes.filter((q) => q.located).length;
  const undetermined = runs.filter((r) => r.structureUndetermined).length;
  return {
    variant,
    runs: runs.length,
    quoteLocateRate: Number((quotesLocated / Math.max(1, quotesTotal)).toFixed(4)),
    quotesTotal,
    quotesLocated,
    structureUndeterminedRate: Number((undetermined / Math.max(1, runs.length)).toFixed(4)),
    structureUndetermined: undetermined,
    firstAttemptRate: Number((runs.filter((r) => r.firstAttemptOk).length / Math.max(1, runs.length)).toFixed(4)),
    degraded: runs.filter((r) => r.outcomeKind === 'degraded').length,
    structureQuoteLocateRate: Number((structureLocated / Math.max(1, structureQuotes.length)).toFixed(4)),
    latencyMs: latencyStats(runs.map((r) => r.latencyMs)),
    tokens: runs.reduce((a, r) => a + r.tokens, 0),
  };
}

/** 按 criteria.json 的 metric + compare 判定；不认识就抛错，绝不默认通过。 */
function evaluate(criteria: Preregistration['criteria'], metrics: Record<string, VariantMetrics>): ExperimentResult['verdict'] {
  const prose = metrics.prose!;
  const mechanical = metrics.mechanical!;
  const checks = criteria.map((c) => {
    const pick = (m: VariantMetrics): number => {
      if (c.metric === 'quoteLocateRate') return m.quoteLocateRate;
      if (c.metric === 'structureUndeterminedRate') return m.structureUndeterminedRate;
      throw new Error(`预登记判据里的 metric 无法识别：${c.metric}`);
    };
    const p = pick(prose);
    const m = pick(mechanical);
    const satisfied = c.compare.includes('mechanical >= prose') ? m >= p : c.compare.includes('mechanical <= prose') ? m <= p : (() => {
      throw new Error(`预登记判据里的 compare 无法识别：${c.compare}`);
    })();
    return { id: c.id, description: c.description, metric: c.metric, compare: c.compare, prose: p, mechanical: m, satisfied };
  });
  const passed = checks.every((c) => c.satisfied);
  return {
    passed,
    checks,
    conclusion: passed
      ? '两条判据都满足：实验通过。可建议升 rules@0.2.1；但本轮不升版，由 lead 决定。'
      : '至少一条判据不满足：实验不通过。机械口径维持「入口级操作提示」地位，不动 rules。',
  };
}

export async function runStructureExperiment(client: DashscopeTextClient, evidence: EvidenceWriter): Promise<ExperimentResult> {
  const prereg = loadPreregistration();
  const batch = buildBatch(prereg);
  const variants: StructureHintVariant[] = ['prose', 'mechanical'];
  evidence.truncateJsonl('structure-experiment/runs.jsonl');
  const runs: ExperimentRun[] = [];

  for (const variant of variants) {
    for (const item of batch) {
      for (let repeat = 1; repeat <= prereg.repeats; repeat++) {
        const prompt = reviewPrompt({
          questionText: item.questionText,
          answerText: item.answer,
          turnIds: ['t1'],
          textVersion: 'raw',
          isRewrite: false,
          structureHint: variant,
        });
        const channel = new DashscopeReviewChannel(client, prompt, {
          jsonMode: prereg.model.jsonMode,
          enableThinking: prereg.model.enableThinking,
          rawSink: (attempt, raw) => evidence.writeText(`structure-experiment/raw/${variant}-${item.id}-r${repeat}.attempt${attempt}.txt`, raw, false),
        });
        const startedAt = Date.now();
        const outcome = await runReview({
          channel,
          basisText: item.answer,
          turnIds: ['t1'],
          textVersion: 'raw',
          questionId: 'q1',
          maxRetries: prereg.model.maxRetries,
        });
        const latencyMs = Date.now() - startedAt;
        const fb = outcome.feedback as Feedback;
        const quotes: ExperimentRun['quotes'] = [];
        for (const dim of DIMS) {
          const d = fb.dimensions[dim];
          if (d.level === '无法判断') continue;
          if (!d.quote) continue;
          // 独立复核：判据一律用 locateQuote，不采信模型自报区间。
          const loc = locateQuote(item.answer, d.quote.text);
          quotes.push({
            dim,
            level: d.level,
            text: d.quote.text,
            located: loc.located === true,
            start: loc.located === true ? loc.start : null,
            end: loc.located === true ? loc.end : null,
            matchType: loc.located === true ? loc.matchType : null,
          });
        }
        const run: ExperimentRun = {
          itemId: item.id,
          variant,
          repeat,
          outcomeKind: outcome.kind,
          attempts: outcome.attempts,
          firstAttemptOk: outcome.attempts === 1 && outcome.kind === 'ok',
          levels: Object.fromEntries(DIMS.map((d) => [d, fb.dimensions[d].level])),
          structureUndetermined: fb.dimensions.structure.level === '无法判断',
          quotes,
          quotesTotal: quotes.length,
          quotesLocated: quotes.filter((q) => q.located).length,
          latencyMs,
          tokens: channel.calls.reduce((a, c) => a + c.totalTokens, 0),
          calls: channel.calls,
        };
        runs.push(run);
        evidence.appendJsonl('structure-experiment/runs.jsonl', [run]);
        evidence.writeJson(`structure-experiment/feedback/${variant}-${item.id}-r${repeat}.json`, {
          itemId: item.id,
          sourceCaseId: item.sourceCaseId,
          transform: item.transform,
          variant,
          repeat,
          answerBasis: item.answer,
          modelLevels: run.levels,
          quotes,
          feedback: outcome.feedback,
          expectedDims: null,
        });
      }
    }
  }

  const metrics = {
    prose: metricsFor('prose', runs.filter((r) => r.variant === 'prose')),
    mechanical: metricsFor('mechanical', runs.filter((r) => r.variant === 'mechanical')),
  };
  return {
    preregisteredAt: prereg.preregisteredAt,
    ranAt: new Date().toISOString(),
    model: prereg.model.id,
    batch: batch.map((b) => ({ id: b.id, sourceCaseId: b.sourceCaseId, transform: b.transform, answerChars: b.answer.length })),
    repeats: prereg.repeats,
    totalCalls: runs.reduce((a, r) => a + r.calls.length, 0),
    metrics,
    verdict: evaluate(prereg.criteria, metrics),
  };
}

export function writeExperimentProtocolNote(): string {
  return path.join(EXPERIMENT_DIR, 'preregistration.md');
}

void writeFileSync;
