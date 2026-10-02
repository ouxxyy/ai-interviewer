import { isDeepStrictEqual } from 'node:util';
import type { Feedback, SessionReport } from '../contracts/types.js';
import { validateContract } from '../contracts/validate.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { PROMPT_VERSION } from '../prompts/prompts.js';
import { RULES_VERSION, DIMENSIONS } from '../rules/rules.js';
import { hasFeedbackSource } from '../review/feedback-source.js';
import { extractJson } from '../t1r/json.js';

export interface PromptQuoteCheck {
  questionId: string;
  dim: string;
  level: string | null;
  located: boolean;
  text: string;
  start: number | null;
  end: number | null;
  matchType: string | null;
  modelStart: number | null;
  modelEnd: number | null;
  modelMetadataValid: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 严格校验内容/身份，仅重定位可在当前回答找到的引用坐标；原始对象保持不变。 */
export function validatePromptFeedback(raw: string, basis: { questionId: string; turnId: string; answerText: string; promptVersion?: string }) {
  const parsed = extractJson(raw);
  const schema = parsed.ok ? validateContract('feedback', parsed.value) : { ok: false, errors: [parsed.error ?? 'JSON 解析失败'] };
  const errors = [...schema.errors];
  const metadataErrors: string[] = [];
  const quoteChecks: PromptQuoteCheck[] = [];
  const source = parsed.ok ? object(parsed.value) : null;
  const dims = object(source?.dimensions);
  // 即使 nextFacts 等内容字段失败，仍保留原始引用诊断，不能把无诊断误报成无错引。
  for (const { key: dim } of DIMENSIONS) {
    const d = object(dims?.[dim]);
    if (!d || d.level === '无法判断') continue;
    const quote = object(d.quote);
    const text = typeof quote?.text === 'string' ? quote.text : '';
    const loc = locateQuote(basis.answerText, text);
    const identityValid = quote?.turnId === basis.turnId && quote?.textVersion === 'raw';
    const modelMetadataValid = loc.located && identityValid && quote?.start === loc.start && quote?.end === loc.end && quote?.matchType === loc.matchType;
    if (!loc.located || !identityValid) errors.push(`${dim}: 引用无法在当前已确认回答/轮次定位`);
    if (loc.located && identityValid && !modelMetadataValid) metadataErrors.push(`${dim}: 模型引用坐标或匹配类型不符`);
    quoteChecks.push({ questionId: basis.questionId, dim, level: typeof d.level === 'string' ? d.level : null, located: loc.located && identityValid, text, start: loc.located ? loc.start : null, end: loc.located ? loc.end : null, matchType: loc.located ? loc.matchType : null, modelStart: typeof quote?.start === 'number' ? quote.start : null, modelEnd: typeof quote?.end === 'number' ? quote.end : null, modelMetadataValid });
  }
  let feedback: Feedback | null = null;
  if (schema.ok && parsed.ok) {
    const original = parsed.value as Feedback;
    if (original.reviewVersion !== (basis.promptVersion ?? PROMPT_VERSION) || original.questionId !== basis.questionId || original.reviewBasis.textVersion !== 'raw' || !isDeepStrictEqual(original.reviewBasis.turnIds, [basis.turnId])) errors.push('反馈版本或评审对象与本题不符');
    if (!errors.length) {
      feedback = structuredClone(original);
      for (const d of Object.values(feedback.dimensions)) {
        if (!d.quote) continue;
        const loc = locateQuote(basis.answerText, d.quote.text);
        if (!loc.located) throw new Error('引用重定位不变量失败');
        d.quote.start = loc.start;
        d.quote.end = loc.end;
        d.quote.matchType = loc.matchType;
      }
    }
  }
  return { feedback, valid: feedback !== null, rawValid: feedback !== null && metadataErrors.length === 0, errors, rawErrors: [...errors, ...metadataErrors], quoteChecks };
}

/** 报告必须原样回填已校验结果；不删除额外字段、不修正模型改写的状态。 */
export function validatePromptReport(raw: string, expected: { perQuestion: SessionReport['perQuestion']; textModel: string }) {
  const parsed = extractJson(raw);
  const schema = parsed.ok ? validateContract('session-report', parsed.value) : { ok: false, errors: [parsed.error ?? 'JSON 解析失败'] };
  const errors = [...schema.errors];
  if (schema.ok && parsed.ok) {
    const report = parsed.value as SessionReport;
    const feedbacks = expected.perQuestion.flatMap((q) => q.feedback ? [q.feedback] : []);
    if (report.completedQuestions !== feedbacks.length || report.sessionStatus !== 'ended_early' || !isDeepStrictEqual(report.perQuestion, expected.perQuestion)) errors.push('报告完成数、结束状态或逐题反馈与本场权威结果不一致');
    if (report.versions.ruleVersion !== RULES_VERSION || report.versions.realtimeModel !== null || report.versions.textModel !== expected.textModel) errors.push('报告模型/规则版本与本次运行不符');
    if (!feedbacks.length ? !isDeepStrictEqual(report.priorityPractice, ['本次未完成任何题目，无有效反馈']) : report.priorityPractice.length > 2 || !report.priorityPractice.every((p) => hasFeedbackSource(p, feedbacks))) errors.push('优先练习点未遵守零完成或反馈来源约束');
  }
  return { valid: schema.ok && errors.length === 0, errors };
}
