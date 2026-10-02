/** 只保存固定字段路径与规则码，不保存回答、模型值、JSON 解析片段或未知属性名。 */
export interface ReviewIssue { path: string; rule: string }
export interface ReviewAttempt {
  attempt: number;
  ok: boolean;
  cause?: string;
  issues?: ReviewIssue[];
}

const FIELDS = new Set('contractVersion questionId reviewBasis turnIds textVersion dimensions relevance specificity contribution resultsReflection structure level quote text start end turnId matchType reason factGaps topImprovement nextFacts reviewVersion'.split(' '));
const RULES = new Set('required type enum additionalProperties minItems minLength minimum pattern anyOf if schema invalid_json quote_not_found turn_mismatch inconsistent_quote'.split(' '));

export function safeReviewIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.slice(0, 24).map(({ path, rule }) => ({
    path: path === '/' ? '/' : path.split('/').map((part, i) => i === 0 ? '' : FIELDS.has(part) || /^\d{1,5}$/.test(part) ? part : '*').join('/'),
    rule: RULES.has(rule) ? rule : 'schema',
  }));
}
