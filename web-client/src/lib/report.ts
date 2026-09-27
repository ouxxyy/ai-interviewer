/**
 * 报告页的纯计算层：引用定位、代表档位、初答/重答对照。
 *
 * 引用定位**不再自己实现一份**：`start/end` 是服务端 NFC 基准文本的字符偏移，
 * 前端必须用契约模块的 `sliceByLocation()` / `foldText()` 还原与比较，
 * 否则在需要 NFC 归一的文本上会拒绝服务端给出的合法锚点（P1-3）。
 */
import { foldText, sliceByLocation } from '../../../src/contracts/quote-locator.js';
import type { DimensionFeedback, DimensionKey, Feedback, QuoteRef, ReviewBasisDetail, RewriteDelta, Turn } from '../types.js';

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
