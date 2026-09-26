/**
 * 评审流水线（T1-S 用 mock 通道驱动；真实通道属 T1-R，未验证）。
 *
 * 流程：模型原始输出 → JSON 解析 → Schema 校验 → 逐维引用重定位 → 失败重试（带整改反馈）→ 仍失败则降级「暂无法评价」。
 * 红线：引用定位失败不展示该维度等级；绝不猜测填充；降级不伪造成正常反馈。
 */
import { validateContract } from '../contracts/validate.js';
import { locateQuote } from '../contracts/quote-locator.js';
import type { Feedback, DimensionKey, TextVersion } from '../contracts/types.js';

/** 模型通道抽象：attempt 从 1 起；remediation 为上一次失败的整改提示（首次为 null）。 */
export interface ReviewChannel {
  call(attempt: number, remediation: string | null): string;
}

export interface RunReviewInput {
  channel: ReviewChannel;
  /** D1/D11：评审对象文本（修订版优先，由调用方决定）。 */
  basisText: string;
  turnIds: string[];
  textVersion: TextVersion;
  questionId: string;
  maxRetries?: number;
}

export type ReviewOutcome =
  | { kind: 'ok'; feedback: Feedback; attempts: number }
  | { kind: 'degraded'; feedback: Feedback; attempts: number; cause: 'json_error' | 'schema_error' | 'quote_not_locatable'; detail: string };

const DIMS: DimensionKey[] = ['relevance', 'specificity', 'contribution', 'resultsReflection', 'structure'];

export function runReview(input: RunReviewInput): ReviewOutcome {
  const maxRetries = input.maxRetries ?? 2;
  let lastCause: ReviewOutcome extends { kind: 'degraded' } ? never : 'json_error' | 'schema_error' | 'quote_not_locatable' = 'json_error';
  let lastDetail = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const remediation = attempt === 1 ? null : `上一次输出未通过校验：${lastCause}（${lastDetail}）。请严格按契约重新输出。`;
    const raw = input.channel.call(attempt, remediation);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      lastCause = 'json_error';
      lastDetail = (e as Error).message.slice(0, 120);
      continue;
    }

    const schemaResult = validateContract('feedback', parsed);
    if (!schemaResult.ok) {
      lastCause = 'schema_error';
      lastDetail = schemaResult.errors.join('; ').slice(0, 200);
      continue;
    }

    const fb = parsed as Feedback;
    const quoteErrors: string[] = [];
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
        quoteErrors.push(`${dim}: turnId ${d.quote.turnId} 不在评审对象轮次 ${input.turnIds.join(',')} 中`);
        continue;
      }
      const loc = locateQuote(input.basisText, d.quote.text);
      if (!loc.located) {
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
      continue;
    }

    // 评审基准由应用层权威回填。
    fb.reviewBasis = { turnIds: input.turnIds, textVersion: input.textVersion };
    return { kind: 'ok', feedback: fb, attempts: attempt };
  }

  return { kind: 'degraded', feedback: degradedFeedback(input, lastCause, lastDetail), attempts: maxRetries, cause: lastCause, detail: lastDetail };
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
    contractVersion: '0.1.0',
    questionId: input.questionId,
    reviewBasis: { turnIds: input.turnIds, textVersion: input.textVersion },
    dimensions: dims,
    factGaps: [],
    topImprovement: '暂无法评价：请稍后重新提交评审。',
    nextFacts: ['本次评审未完成，无新增事实要求'],
    reviewVersion: `degraded:${cause}`,
  };
}
