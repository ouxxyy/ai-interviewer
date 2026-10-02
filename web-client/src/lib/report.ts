/**
 * 报告页的纯计算层：引用定位、代表档位、初答/重答对照。
 *
 * 引用定位**不再自己实现一份**：`start/end` 是服务端 NFC 基准文本的字符偏移，
 * 前端必须用契约模块的 `sliceByLocation()` / `foldText()` 还原与比较，
 * 否则在需要 NFC 归一的文本上会拒绝服务端给出的合法锚点（P1-3）。
 */
import { foldText, sliceByLocation } from '../../../src/contracts/quote-locator.js';
import type { DimensionFeedback, DimensionKey, Feedback, QuoteRef, ReviewBasisDetail, RewriteDelta, Turn, IntroductionStatus, SessionListItem, SessionReport, SessionDetail, PlannedQuestion } from '../types.js';

export { foldText };

/** 按契约坐标系重建引用区间文本，并复核它确实等于（或折叠后等于）引用文本。 */
export function verifiedQuote(basis: ReviewBasisDetail | undefined, quote: QuoteRef | null): QuoteRef | null {
  if (basis === undefined || quote === null) return null;
  if (!Number.isInteger(quote.start) || !Number.isInteger(quote.end) || quote.start < 0 || quote.end <= quote.start) return null;
  const slice = sliceByLocation(basis.text, quote.start, quote.end);
  if (slice === '') return null;
  if (quote.matchType === 'normalized') return foldText(slice) === foldText(quote.text) ? quote : null;
  return slice === quote.text ? quote : null;
}

const levelRank = { '证据不足': 0, '部分清楚': 1, '充分清楚': 2, '无法判断': 3 } as const;

export function representativeDimension(feedbacks: Feedback[], key: DimensionKey): DimensionFeedback {
  const values = feedbacks.map((feedback) => feedback.dimensions[key]).filter((value): value is DimensionFeedback => value !== undefined);
  if (values.length === 0) return { level: '无法判断', quote: null, reason: '本场没有足够原话' };
  const assessable = values.filter((value) => value.level !== '无法判断');
  if (assessable.length === 0) return values[0]!;
  return [...assessable].sort((a, b) => levelRank[a.level] - levelRank[b.level])[0]!;
}

export function questionAnswer(turns: Turn[], questionId: string, type: 'initial' | 'rewrite'): string {
  const allowed = type === 'rewrite' ? ['rewrite'] : ['answer', 'followup'];
  return turns
    .filter((turn) => turn.questionId === questionId && turn.speaker === 'user' && allowed.includes(turn.turnType))
    .map((turn) => turn.revisedText ?? turn.rawTranscript)
    .join('\n');
}

export function highlightAdded(text: string, delta: RewriteDelta | undefined): Array<{ text: string; marked: boolean }> {
  const additions = (delta?.added ?? []).filter((part) => part.length >= 2 && text.includes(part)).sort((a, b) => b.length - a.length);
  if (additions.length === 0) return [{ text, marked: false }];
  const first = additions[0]!;
  const index = text.indexOf(first);
  return [
    ...(index > 0 ? [{ text: text.slice(0, index), marked: false }] : []),
    { text: first, marked: true },
    ...(index + first.length < text.length ? [{ text: text.slice(index + first.length), marked: false }] : []),
  ];
}


/** 缺失题型仅用于兼容历史三题记录，不从正文猜测。 */
export function questionLabel(questions: Array<{ id?: string; questionId?: string; kind?: PlannedQuestion['kind'] }>, id: string): string {
  const index = questions.findIndex((question) => (question.id ?? question.questionId) === id);
  if (index < 0) return '题目';
  if (questions[index]?.kind === 'introduction') return '自我介绍';
  if (!questions.some((question) => question.kind === 'introduction')) return `第 ${index + 1} 题`;
  const number = questions.slice(0, index + 1).filter((question) => question.kind !== 'introduction').length;
  return `经历题 ${number}`;
}

export function introductionStatusLabel(status: IntroductionStatus): string {
  return { reviewed: '已完成', skipped: '已跳过', not_reached: '未练到', not_included: '未包含介绍' }[status];
}

export function reportProgress(report: SessionReport) {
  const introduction = report.perQuestion.find((question) => question.kind === 'introduction');
  const introductionStatus: IntroductionStatus = introduction?.status ?? 'not_included';
  const experience = report.perQuestion.filter((question) => question.kind !== 'introduction');
  return {
    introductionStatus,
    introductionLabel: introductionStatusLabel(introductionStatus),
    completedExperienceQuestions: experience.filter((question) => question.status === 'reviewed').length,
    totalExperienceQuestions: experience.length,
  };
}

export function historyProgress(item: SessionListItem) {
  return {
    introductionLabel: introductionStatusLabel(item.introductionStatus ?? 'not_included'),
    completedExperienceQuestions: item.completedExperienceQuestions ?? item.completedQuestions,
    totalExperienceQuestions: item.totalExperienceQuestions,
  };
}

export function experienceFeedbacks(report: SessionReport | null | undefined): Feedback[] {
  return report?.perQuestion.filter((question) => question.kind !== 'introduction' && question.status === 'reviewed')
    .map((question) => question.feedback).filter((feedback): feedback is Feedback => feedback !== null) ?? [];
}

export function rewriteComparisons(detail: SessionDetail) {
  const questions = detail.report?.perQuestion ?? detail.plan?.questions.map((question) => ({ questionId: question.id, kind: question.kind })) ?? [];
  return questions.flatMap((question) => {
    const rewrite = questionAnswer(detail.turns, question.questionId, 'rewrite');
    if (rewrite === '') return [];
    return [{
      questionId: question.questionId,
      label: questionLabel(questions, question.questionId),
      initial: questionAnswer(detail.turns, question.questionId, 'initial'),
      rewrite,
      delta: detail.rewriteDeltas[question.questionId],
    }];
  });
}
