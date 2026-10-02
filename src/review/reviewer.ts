/**
 * 评审流水线（T1-S 用 mock 通道驱动；真实通道属 T1-R，未验证）。
 *
 * 流程：模型原始输出 → JSON 对象检查 → 已知元数据及可定位引用坐标回填 → 完整 Schema 校验 → 逐维引用核验 → 失败重试（带整改反馈）→ 仍失败则降级「暂无法评价」。
 * 红线：引用定位失败不展示该维度等级；绝不猜测填充；降级不伪造成正常反馈。
 */
import { validateContract } from '../contracts/validate.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { CONTRACT_VERSION } from '../contracts/version.js';
import { PROMPT_VERSION } from '../prompts/prompts.js';
import type { Feedback, DimensionKey, TextVersion } from '../contracts/types.js';
import { safeReviewIssues, type ReviewIssue } from './diagnostics.js';

/**
 * 模型通道抽象：attempt 从 1 起；remediation 为上一次失败的整改提示（首次为 null）。
 * 允许返回 Promise（真实 HTTP 通道），同步返回值同样接受（mock 通道）。
 */
export interface ReviewChannel {
  call(attempt: number, remediation: string | null): string | Promise<string>;
}

export interface RunReviewInput {
  channel: ReviewChannel;
  /** D1/D11：评审对象文本（修订版优先，由调用方决定）。 */
  basisText: string;
  turnIds: string[];
  textVersion: TextVersion;
  questionId: string;
  maxRetries?: number;
  /**
   * 观测钩子（不改变流水线行为）：每次尝试的判定结果。
   * T1-R 用它把「第几次失败、为什么失败」写进验收证据，避免只看到最终的 ok/degraded。
   */
  onAttempt?(attempt: number, result: { ok: boolean; cause?: 'json_error' | 'schema_error' | 'quote_not_locatable'; detail?: string; issues?: ReviewIssue[] }): void;
}

export type ReviewOutcome =
  | { kind: 'ok'; feedback: Feedback; attempts: number }
  | { kind: 'degraded'; feedback: Feedback; attempts: number; cause: 'json_error' | 'schema_error' | 'quote_not_locatable'; detail: string };

const DIMS: DimensionKey[] = ['relevance', 'specificity', 'contribution', 'resultsReflection', 'structure'];

export async function runReview(input: RunReviewInput): Promise<ReviewOutcome> {
  const maxRetries = input.maxRetries ?? 2;
  let lastCause: ReviewOutcome extends { kind: 'degraded' } ? never : 'json_error' | 'schema_error' | 'quote_not_locatable' = 'json_error';
  let lastDetail = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const remediation = attempt === 1 ? null : buildRemediation(lastCause, lastDetail);
    const raw = await input.channel.call(attempt, remediation);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      lastCause = 'json_error';
      lastDetail = (e as Error).message.slice(0, 120);
      input.onAttempt?.(attempt, { ok: false, cause: lastCause, detail: lastDetail, issues: [{ path: '/', rule: 'invalid_json' }] });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      lastCause = 'schema_error';
      lastDetail = '(root): must be object';
      input.onAttempt?.(attempt, { ok: false, cause: lastCause, detail: lastDetail, issues: [{ path: '/', rule: 'type' }] });
      continue;
    }

    // 应用层权威回填「已知元数据」——这些字段的值由应用决定（用的是哪版契约、哪版提示词、
    // 评审对象是谁），不该因为模型漏写就整份重试、更不该采信模型自报。与 reviewBasis 同一条原则。
    // 只回填元数据，内容字段（dimensions / factGaps / topImprovement / nextFacts）一律不代写。
    const meta = parsed as Partial<Feedback> & Record<string, unknown>;
    meta.contractVersion = CONTRACT_VERSION;
    meta.reviewVersion = PROMPT_VERSION;
    meta.questionId = input.questionId;
    meta.reviewBasis = { turnIds: input.turnIds, textVersion: input.textVersion };

    // 坐标是应用事实。先对可定位原话回填，再执行未放宽的完整 Schema；
    // 不补 quote.text/turnId、等级、理由或建议，也不移除多余内容字段。
    const dimensions = (parsed as Record<string, unknown>).dimensions;
    if (dimensions !== null && typeof dimensions === 'object' && !Array.isArray(dimensions)) {
      for (const key of DIMS) {
        const dimension = (dimensions as Record<string, unknown>)[key];
        if (dimension === null || typeof dimension !== 'object' || Array.isArray(dimension)) continue;
        const quote = (dimension as Record<string, unknown>).quote;
        if (quote === null || typeof quote !== 'object' || Array.isArray(quote)) continue;
        const q = quote as Record<string, unknown>;
        if (typeof q.text !== 'string' || typeof q.turnId !== 'string' || !input.turnIds.includes(q.turnId)) continue;
        const loc = locateQuote(input.basisText, q.text);
        if (!loc.located) continue;
        Object.assign(q, { start: loc.start, end: loc.end, matchType: loc.matchType, textVersion: input.textVersion });
      }
    }

    const schemaResult = validateContract('feedback', parsed);
    if (!schemaResult.ok) {
      lastCause = 'schema_error';
      lastDetail = schemaResult.errors.join('; ').slice(0, 200);
      input.onAttempt?.(attempt, { ok: false, cause: lastCause, detail: lastDetail, issues: safeReviewIssues(schemaResult.issues ?? []) });
      continue;
    }

    const fb = parsed as Feedback;
    const quoteErrors: string[] = [];
    const quoteIssues: ReviewIssue[] = [];
    for (const dim of DIMS) {
      const d = fb.dimensions[dim];
      if (d.level === '无法判断') {
        if (d.quote !== null) quoteErrors.push(`${dim}: 无法判断维度 quote 必须为 null`);
        continue;
      }
      if (!d.quote) {
        quoteErrors.push(`${dim}: 三档维度缺少 quote`);
        continue;
      }
      if (!input.turnIds.includes(d.quote.turnId)) {
        quoteIssues.push({ path: `/dimensions/${dim}/quote/turnId`, rule: 'turn_mismatch' });
        quoteErrors.push(`${dim}: turnId ${d.quote.turnId} 不在评审对象轮次 ${input.turnIds.join(',')} 中`);
        continue;
      }
      const loc = locateQuote(input.basisText, d.quote.text);
      if (!loc.located) {
        quoteIssues.push({ path: `/dimensions/${dim}/quote/text`, rule: 'quote_not_found' });
        quoteErrors.push(`${dim}: 引用无法在评审对象中定位（${loc.reason}）：${d.quote.text.slice(0, 20)}…`);
        continue;
      }
      // 应用层权威重定位：以定位器结果覆盖模型给的区间，杜绝模型自报区间漂移。
      d.quote.start = loc.start;
      d.quote.end = loc.end;
      d.quote.matchType = loc.matchType;
      d.quote.textVersion = input.textVersion;
    }
    if (quoteErrors.length > 0) {
      lastCause = 'quote_not_locatable';
      lastDetail = quoteErrors.join('; ').slice(0, 200);
      input.onAttempt?.(attempt, { ok: false, cause: lastCause, detail: lastDetail, issues: safeReviewIssues(quoteIssues) });
      continue;
    }

    // 评审基准由应用层权威回填。
    fb.reviewBasis = { turnIds: input.turnIds, textVersion: input.textVersion };
    input.onAttempt?.(attempt, { ok: true });
    return { kind: 'ok', feedback: fb, attempts: attempt };
  }

  return { kind: 'degraded', feedback: degradedFeedback(input, lastCause, lastDetail), attempts: maxRetries, cause: lastCause, detail: lastDetail };
}

/** 按失败原因给出针对性整改提示；泛泛的「请重试」会浪费一次调用。 */
export function buildRemediation(cause: string, detail: string): string {
  const tips: Record<string, string> = {
    quote_not_locatable:
      '引用必须是【评审对象】中**连续出现**的一段逐字原话：不得使用省略号、不得拼接不相邻的片段、不得改写字词或标点。请只保留一处最有力的连续片段，其余证据写进 reason。',
    schema_error: '严格按输出结构逐字段填写：不新增字段、不省略必需字段、枚举值只能取给定取值。',
    json_error: '只输出一个 JSON 对象，不要加解释文字、注释或 markdown 代码围栏。',
  };
  const tip = tips[cause] ?? '请严格按契约重新输出。';
  return `上一次输出未通过校验：${cause}（${detail}）。${tip} 请重新输出完整 JSON。`;
}

function degradedFeedback(input: RunReviewInput, cause: string, detail: string): Feedback {
  const dims = {} as Feedback['dimensions'];
  for (const dim of DIMS) {
    dims[dim] = {
      level: '无法判断',
      quote: null,
      reason: `暂无法评价：评审输出未通过${cause === 'quote_not_locatable' ? '引用定位' : '契约'}校验（${cause}），已按规则降级，不展示猜测等级。`,
    };
  }
  return {
    contractVersion: CONTRACT_VERSION,
    questionId: input.questionId,
    reviewBasis: { turnIds: input.turnIds, textVersion: input.textVersion },
    dimensions: dims,
    factGaps: [],
    topImprovement: '暂无法评价：请稍后重新提交评审。',
    nextFacts: ['本次评审未完成，无新增事实要求'],
    reviewVersion: `degraded:${cause}`,
  };
}
