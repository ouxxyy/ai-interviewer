/**
 * 链 A（文本，T1-R 真实调用）：
 * 同一虚构材料 → 真实 QuestionPlan（3 题，含来源片段与问题意图）→ ≥3 个案例的真实 Feedback JSON。
 *
 * 红线（沿用 T1-S 契约，不放松）：
 * - 评审结果必须过 `feedback` Schema；
 * - 三档维度的引用必须 100% 可在评审对象中定位（定位失败即降级，不展示等级）；
 * - 定位器结果**覆盖**模型自报区间（应用层权威重定位）。
 *
 * 本模块不打印任何凭证；所有落盘走 EvidenceWriter 的密钥防线。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runReview, type ReviewChannel, type ReviewOutcome } from '../review/reviewer.js';
import { validateContract } from '../contracts/validate.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { questionPlanPrompt, reviewPrompt, PROMPT_VERSION } from '../prompts/prompts.js';
import type { DashscopeTextClient } from '../clients/dashscope.js';
import type { CompletionResponse } from '../clients/types.js';
import type { Feedback, QuestionPlan } from '../contracts/types.js';
import { REPO_ROOT } from './env.js';
import { extractJson } from './json.js';
import type { EvidenceWriter } from './evidence.js';

export interface CaseRecord {
  id: string;
  synthetic: boolean;
  stage: string;
  track: string;
  targetRole: string;
  flawType: string;
  materials: { jd: string; experience: string };
  questionText: string;
  firstAnswer: string;
  expectedDims: Record<string, string>;
  expectedGaps: string[];
}

export function loadCases(): CaseRecord[] {
  const file = path.join(REPO_ROOT, 'cases', 'cases.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cases: CaseRecord[] };
  return parsed.cases;
}

export interface CallRecord {
  attempt: number;
  latencyMs: number;
  httpStatus: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  jsonMode: boolean;
  enableThinking: boolean;
  rawChars: number;
  rawPath?: string;
}

/** 真实文本通道：把每次 HTTP 调用的可观测字段留在证据里（不含凭证）。 */
export class DashscopeReviewChannel implements ReviewChannel {
  readonly calls: CallRecord[] = [];
  constructor(
    private readonly client: DashscopeTextClient,
    private readonly basePrompt: string,
    private readonly opts: { jsonMode?: boolean; enableThinking?: boolean; rawSink?: (attempt: number, raw: string) => void } = {},
  ) {}

  async call(attempt: number, remediation: string | null): Promise<string> {
    const prompt = remediation === null ? this.basePrompt : `${this.basePrompt}\n\n【上一次输出未通过校验，请针对以下问题整改后重新输出完整 JSON】\n${remediation}`;
    const res: CompletionResponse = await this.client.complete({
      prompt,
      jsonMode: this.opts.jsonMode ?? true,
      enableThinking: this.opts.enableThinking ?? false,
      temperature: 0.2,
      maxTokens: 2048,
    });
    this.calls.push({
      attempt,
      latencyMs: res.latencyMs ?? 0,
      httpStatus: res.httpStatus ?? 0,
      model: res.model ?? this.client.model,
      promptTokens: res.usage?.promptTokens ?? 0,
      completionTokens: res.usage?.completionTokens ?? 0,
      totalTokens: res.usage?.totalTokens ?? 0,
      jsonMode: this.opts.jsonMode ?? true,
      enableThinking: this.opts.enableThinking ?? false,
      rawChars: res.text.length,
    });
    this.opts.rawSink?.(attempt, res.text);
    return res.text;
  }
}

export interface ChainAResult {
  material: { source: string; jd: string; experience: string; stage: string; targetRole: string };
  plan: QuestionPlan;
  planCall: CallRecord;
  planSchemaOk: boolean;
  /** 计划里每题 sourceExcerpt 是否真的能在材料原文里定位。 */
  planExcerptLocatable: Array<{ questionId: string; excerpt: string; located: boolean; reason?: string }>;
  reviews: Array<{
    caseId: string;
    questionId: string;
    outcomeKind: ReviewOutcome['kind'];
    attempts: number;
    /** 第 1 次尝试是否就通过（含定位）——A4 的「首次命中率」，不含重试掩盖。 */
    firstAttemptOk: boolean;
    /** 每次尝试的判定，失败时带 cause/detail（T1-R 新增观测）。 */
    attemptLog: Array<{ attempt: number; ok: boolean; cause?: string; detail?: string }>;
    schemaOk: boolean;
    reviewVersion: string;
    quotesTotal: number;
    quotesLocated: number;
    quoteFailures: string[];
    calls: CallRecord[];
    levels: Record<string, string>;
    cause?: string;
  }>;
  promptVersion: string;
}

export interface ChainAOptions {
  materialCaseId?: string;
  reviewCaseIds?: string[];
  evidence: EvidenceWriter;
  maxRetries?: number;
  jsonMode?: boolean;
  enableThinking?: boolean;
}

export async function runChainA(client: DashscopeTextClient, opts: ChainAOptions): Promise<ChainAResult> {
  const cases = loadCases();
  const materialCase = cases.find((c) => c.id === (opts.materialCaseId ?? 'C01'));
  if (!materialCase) throw new Error(`找不到材料案例 ${opts.materialCaseId ?? 'C01'}`);
  const reviewCases = (opts.reviewCaseIds ?? ['C01', 'C02', 'C03', 'C15', 'C19'])
    .map((id) => cases.find((c) => c.id === id))
    .filter((c): c is CaseRecord => c !== undefined);

  const material = {
    source: `cases/cases.json#${materialCase.id}（合成材料，synthetic=true）`,
    jd: materialCase.materials.jd,
    experience: materialCase.materials.experience,
    stage: materialCase.stage,
    targetRole: materialCase.targetRole,
  };

  // ---- 1. 真实 QuestionPlan ----
  const planPrompt = questionPlanPrompt(material);
  opts.evidence.writeText('prompts/question-plan.prompt.txt', planPrompt, false);
  const planChannel = new DashscopeReviewChannel(client, planPrompt, {
    jsonMode: opts.jsonMode,
    enableThinking: opts.enableThinking,
    rawSink: (attempt, raw) => opts.evidence.writeText(`raw/question-plan.attempt${attempt}.txt`, raw, false),
  });
  const planRaw = await planChannel.call(1, null);
  const planParsed = extractJson(planRaw);
  if (!planParsed.ok) throw new Error(`QuestionPlan 输出无法解析为 JSON：${planParsed.error}`);
  const planCheck = validateContract('question-plan', planParsed.value);
  if (!planCheck.ok) throw new Error(`QuestionPlan 未通过 Schema：${planCheck.errors.join('; ')}`);
  const plan = planParsed.value as QuestionPlan;
  opts.evidence.writeJson('chain-a/question-plan.json', plan);

  const planExcerptLocatable = plan.questions.map((q) => {
    const loc = locateQuote(`${material.jd}\n${material.experience}`, q.sourceExcerpt);
    return { questionId: q.id, excerpt: q.sourceExcerpt, located: loc.located, ...(loc.located ? {} : { reason: loc.reason }) };
  });

  // ---- 2. 真实 Feedback（≥3 个案例）----
  const reviews: ChainAResult['reviews'] = [];
  for (const c of reviewCases) {
    const questionId = 'q1';
    const turnIds = ['t1'];
    const prompt = reviewPrompt({
      questionText: c.questionText,
      answerText: c.firstAnswer,
      turnIds,
      textVersion: 'raw',
      isRewrite: false,
    });
    opts.evidence.writeText(`prompts/review-${c.id}.prompt.txt`, prompt, false);
    const channel = new DashscopeReviewChannel(client, prompt, {
      jsonMode: opts.jsonMode,
      enableThinking: opts.enableThinking,
      rawSink: (attempt, raw) => opts.evidence.writeText(`raw/review-${c.id}.attempt${attempt}.txt`, raw, false),
    });
    const attemptLog: Array<{ attempt: number; ok: boolean; cause?: string; detail?: string }> = [];
    const outcome = await runReview({
      channel, basisText: c.firstAnswer, turnIds, textVersion: 'raw', questionId, maxRetries: opts.maxRetries ?? 2,
      onAttempt: (attempt, r) => attemptLog.push({ attempt, ok: r.ok, ...(r.cause === undefined ? {} : { cause: r.cause }), ...(r.detail === undefined ? {} : { detail: r.detail }) }),
    });

    // 独立复核：不看流水线结论，自己再走一遍「过 Schema + 逐维定位」。
    const schemaOk = validateContract('feedback', outcome.feedback).ok;
    const quoteFailures: string[] = [];
    let quotesTotal = 0;
    let quotesLocated = 0;
    const fb = outcome.feedback as Feedback;
    for (const [dim, d] of Object.entries(fb.dimensions)) {
      if (d.level === '无法判断') {
        if (d.quote !== null) quoteFailures.push(`${dim}: 无法判断但带了引用`);
        continue;
      }
      if (!d.quote) {
        quoteFailures.push(`${dim}: 三档缺少引用`);
        continue;
      }
      quotesTotal++;
      const loc = locateQuote(c.firstAnswer, d.quote.text);
      if (!loc.located) {
        quoteFailures.push(`${dim}: ${loc.reason}`);
        continue;
      }
      // 应用层权威区间必须与独立复算一致
      if (loc.start !== d.quote.start || loc.end !== d.quote.end) {
        quoteFailures.push(`${dim}: 区间与独立复算不一致（流水线 ${d.quote.start}-${d.quote.end}，复算 ${loc.start}-${loc.end}）`);
        continue;
      }
      if (!Number.isInteger(d.quote.end)) {
        quoteFailures.push(`${dim}: end 非整数`);
        continue;
      }
      quotesLocated++;
    }

    const levels = Object.fromEntries(Object.entries(fb.dimensions).map(([k, v]) => [k, v.level]));
    reviews.push({
      caseId: c.id,
      questionId,
      outcomeKind: outcome.kind,
      attempts: outcome.attempts,
      firstAttemptOk: attemptLog[0]?.ok === true,
      attemptLog,
      schemaOk,
      reviewVersion: fb.reviewVersion,
      quotesTotal,
      quotesLocated,
      quoteFailures,
      calls: channel.calls,
      levels,
      ...(outcome.kind === 'degraded' ? { cause: outcome.cause } : {}),
    });

    opts.evidence.writeJson(`chain-a/feedback-${c.id}.json`, {
      caseId: c.id,
      synthetic: c.synthetic,
      sourceQuestion: c.questionText,
      flawType: c.flawType,
      expectedDims: c.expectedDims,
      expectedGaps: c.expectedGaps,
      outcomeKind: outcome.kind,
      attempts: outcome.attempts,
      firstAttemptOk: attemptLog[0]?.ok === true,
      attemptLog,
      schemaOk,
      quotesTotal,
      quotesLocated,
      quoteFailures,
      calls: channel.calls,
      feedback: outcome.feedback,
    });
  }

  return {
    material,
    plan,
    planCall: planChannel.calls[0]!,
    planSchemaOk: planCheck.ok,
    planExcerptLocatable,
    reviews,
    promptVersion: PROMPT_VERSION,
  };
}
