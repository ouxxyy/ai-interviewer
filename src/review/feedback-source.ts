import type { Feedback } from '../contracts/types.js';

/** 连续片段匹配，不把分散的判断字段拼接成伪来源。 */
export function sharesRun(a: string, b: string, minLen = 4): boolean {
  if (a.length < minLen || b.length < minLen) return false;
  for (let i = 0; i <= a.length - minLen; i++) if (b.includes(a.slice(i, i + minLen))) return true;
  return false;
}

/** 只消费正式判断文本；版本、字段名、ID、原话引用都不是新的练习判断。 */
export function hasFeedbackSource(candidate: string, feedbacks: readonly Feedback[]): boolean {
  return feedbacks.some((feedback) => [
    feedback.topImprovement, ...feedback.factGaps, ...feedback.nextFacts,
    ...Object.values(feedback.dimensions).map((dimension) => dimension.reason),
  ].some((judgment) => sharesRun(candidate, judgment)));
}
