/** 网页出题的传输适配：模型选原文编号，应用回填原文，最终仍走共享契约。 */
import type { CandidateMaterials } from '../contracts/types.js';

export const WEB_PLAN_VERSION = 'web-plan@0.3.3';
export interface PlanSource {
  id: string;
  material: 'jd' | 'experience';
  start: number;
  end: number;
  text: string;
}

/** 保留原始字符与区间；优先在换行/句末分段，不跨材料、不概括、不截掉尾段。 */
export function buildPlanSources(materials: Pick<CandidateMaterials, 'jd' | 'experience'>): PlanSource[] {
  const sources: PlanSource[] = [];
  for (const material of ['jd', 'experience'] as const) {
    const text = materials[material];
    let start = 0;
    let index = 0;
    while (start < text.length) {
      let end = Math.min(start + 240, text.length);
      if (end < text.length) {
        // 不在 UTF-16 代理对中间切开。
        if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
        const window = text.slice(start, end);
        const boundaries = [...window.matchAll(/[\n。！？；]/gu)];
        const last = boundaries.at(-1);
        if (last && last.index! >= 40) end = start + last.index! + 1;
        if (text.length - end < 4) end = text.length;
      }
      const slice = text.slice(start, end);
      if (slice.trim().length > 0) {
        sources.push({ id: `${material}:${++index}`, material, start, end, text: slice });
      }
      start = end;
    }
  }
  return sources;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 不修补模型内容、身份或缺失字段；未知编号和两种来源冲突必须拒绝。 */
export function resolvePlanSources(raw: unknown, sources: readonly PlanSource[]):
  { ok: true; plan: unknown } | { ok: false; errors: string[] } {
  if (!isRecord(raw) || !Array.isArray(raw.questions)) return { ok: true, plan: raw };
  const byId = new Map(sources.map(source => [source.id, source.text]));
  const errors: string[] = [];
  const questions = raw.questions.map((question, i) => {
    if (!isRecord(question) || !Object.hasOwn(question, 'sourceId')) return question;
    const label = `q${i + 1}`;
    const source = typeof question.sourceId === 'string' ? byId.get(question.sourceId) : undefined;
    if (source === undefined) {
      errors.push(`${label}: sourceId 必须选择本次原文目录中存在的一个编号`);
      return question;
    }
    if (Object.hasOwn(question, 'sourceExcerpt')) {
      errors.push(`${label}: sourceId 与 sourceExcerpt 不得同时输出，只选择来源编号`);
      return question;
    }
    const { sourceId: _sourceId, ...rest } = question;
    return { ...rest, sourceExcerpt: source };
  });
  return errors.length ? { ok: false, errors } : { ok: true, plan: { ...raw, questions } };
}
