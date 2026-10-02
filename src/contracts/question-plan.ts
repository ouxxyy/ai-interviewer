/** 三入口共享的计划边界；素材引用不能跨 JD 和经历拼接。 */
import type { CandidateMaterials, QuestionPlan } from './types.js';
import { validateContract, type ValidationResult } from './validate.js';
import { foldText, locateQuote } from './quote-locator.js';

export function validateQuestionPlan(
  plan: unknown,
  materials: Pick<CandidateMaterials, 'jd' | 'experience'>,
): ValidationResult {
  const check = validateContract('question-plan', plan);
  if (!check.ok) return check;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const q of (plan as QuestionPlan).questions) {
    const normalized = foldText(q.text)
      // 仅去明确的行首编号；保留「3个院系」「3.14」「3:00」等业务数字。
      .replace(/^(?:(?:第[一二三四五六七八九十0-9]+[题项]|q[0-9]+)[：:、.。-]*|[（(][一二三四五六七八九十0-9]+[）)][：:、.。-]*|[0-9]+(?:\.[0-9]+)*[.、:](?![0-9])|[①-⑳][：:、.。-]*|[一二三四五六七八九十]+、)/u, '')
      .replace(/[\p{P}\p{S}]/gu, '');
    if (seen.has(normalized)) errors.push(`${q.id}: 问题重复，不能只改空白、大小写或标点`);
    seen.add(normalized);
    if (!locateQuote(materials.jd, q.sourceExcerpt).located && !locateQuote(materials.experience, q.sourceExcerpt).located) {
      errors.push(`${q.id}: sourceExcerpt 必须能在 JD 或经历单个原文中连续定位`);
    }
  }
  return { ok: errors.length === 0, errors };
}
