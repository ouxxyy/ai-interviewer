import type { Feedback, TextVersion, Turn } from '../contracts/types.js';

export type ReportSource = 'model_priority_practice' | 'derived_from_validated_feedback' | 'fixed_zero_completion';

export interface ReviewMeta {
  questionId: string;
  kind: 'ok' | 'degraded';
  attempts: number;
  cause?: string;
  quotesTotal: number;
  quotesLocated: number;
  firstAttemptOk: boolean;
}

export interface ReviewBasisDetail {
  questionId: string;
  text: string;
  turnIds: string[];
  textVersion: TextVersion;
}

/**
 * 用已经通过契约校验的 Feedback.reviewBasis 重建评审文本。
 * turnIds 的顺序是偏移量的权威顺序；任何轮次缺失时宁可不返回该题，也不返回错误偏移。
 */
export function buildReviewBasis(
  turns: Turn[],
  reviews: Record<string, Feedback>,
): Record<string, ReviewBasisDetail> {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const out: Record<string, ReviewBasisDetail> = {};
  for (const [questionId, feedback] of Object.entries(reviews)) {
    const turnIds = [...feedback.reviewBasis.turnIds];
    const selected = turnIds.map((turnId) => byId.get(turnId));
    if (selected.some((turn) => turn === undefined)) continue;
    if (selected.some((turn) => turn!.speaker !== 'user' || turn!.questionId !== questionId)) continue;
    out[questionId] = {
      questionId,
      text: selected.map((turn) => turn!.revisedText ?? turn!.rawTranscript).join('\n'),
      turnIds,
      textVersion: feedback.reviewBasis.textVersion,
    };
  }
  return out;
}
