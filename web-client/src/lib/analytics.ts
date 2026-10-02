import type { Snapshot } from '../types.js';

export type PracticeEvent = 'practice_requested' | 'practice_started' | 'practice_ended' | 'practice_completed';
type Data = Partial<Record<'schema_version' | 'completed_questions' | 'total_questions', number>>;
type Emit = (name: PracticeEvent, data?: Data) => unknown;
const EVENTS = new Set<PracticeEvent>(['practice_requested', 'practice_started', 'practice_ended', 'practice_completed']);
const PROPS = new Set(['schema_version', 'completed_questions', 'total_questions']);

declare global { interface Window { oubaAnalytics?: { track: Emit } } }

/** 公共统计脚本也会过滤；业务层只接受这四个事件和匿名计数。 */
function cleanData(data?: Data): Data {
  const result: Data = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!PROPS.has(key) || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) continue;
    if (key === 'schema_version' && value !== 1 && value !== 2) continue;
    result[key as keyof Data] = value;
  }
  return result;
}

function safelyEmit(emit: Emit, name: PracticeEvent, data?: Data): void {
  if (!EVENTS.has(name)) return;
  try {
    const pending = emit(name, cleanData(data));
    if (pending && typeof (pending as Promise<unknown>).catch === 'function') void (pending as Promise<unknown>).catch(() => undefined);
  } catch { /* 统计失败不能影响练习。 */ }
}

export const trackEvent: Emit = (name, data) => {
  if (typeof window !== 'undefined' && window.oubaAnalytics !== undefined) safelyEmit(window.oubaAnalytics.track, name, data);
};

function validPlan(next: Snapshot): boolean {
  const questions = next.plan?.questions;
  if (questions === undefined) return false;
  if (questions.length === 4) return questions[0]?.kind === 'introduction' && questions.slice(1).every((question) => question.kind === 'experience');
  return questions.length === 3 && questions.every((question) => question.kind === undefined || question.kind === 'experience');
}

function schemaVersion(next: Snapshot): 1 | 2 {
  return next.plan?.questions.some((question) => question.kind === 'introduction') ||
    next.report?.perQuestion.some((question) => question.kind === 'introduction') ||
    next.report?.totalQuestions === 4 ? 2 : next.plan?.questions.length === 3 || next.report?.totalQuestions === 3 ? 1 : 2;
}

export interface PracticeObserver {
  (next: Snapshot): void;
  requested(sid: string, synthetic?: boolean): void;
}

export function createPracticeObserver(emit: Emit, storage?: Pick<Storage, 'getItem' | 'setItem'>): PracticeObserver {
  const seen = new Set<string>();
  const active = new Set<string>();
  const once = (sid: string, event: PracticeEvent, data: Data) => {
    // 保留生产v1命名空间，避免升级后同一标签页重复计数。
    const key = 'ouba.analytics.v1:' + event + ':' + sid;
    if (seen.has(key)) return;
    try { if (storage?.getItem(key)) { seen.add(key); return; } } catch { /* 内存去重仍生效。 */ }
    seen.add(key);
    try { storage?.setItem(key, '1'); } catch { /* 存储被禁用时继续业务。 */ }
    safelyEmit(emit, event, data);
  };
  const observe = (next: Snapshot) => {
    if (next.synthetic || !next.sid) return;
    if (next.status === 'active' && next.state !== 'report' && next.state !== 'ended') active.add(next.sid);
    const version = schemaVersion(next);
    if ((next.state === 'question' || next.state === 'answer') && next.machine.questionIndex === 0 && validPlan(next)) {
      once(next.sid, 'practice_started', { schema_version: version, total_questions: next.plan!.questions.length });
    }
    if (next.state === 'ended' && next.report && active.has(next.sid)) {
      const { completedQuestions, totalQuestions } = next.report;
      if (!Number.isInteger(completedQuestions) || !Number.isInteger(totalQuestions) || completedQuestions < 0 || totalQuestions < 1 || completedQuestions > totalQuestions) return;
      const data = { schema_version: version, completed_questions: completedQuestions, total_questions: totalQuestions };
      once(next.sid, 'practice_ended', data);
      const expected = version === 2 ? 4 : 3;
      if (next.report.sessionStatus === 'completed' && completedQuestions === expected && totalQuestions === expected &&
        next.report.perQuestion.length === expected && next.report.perQuestion.every((question) => question.status === 'reviewed' && question.feedback !== null)) {
        once(next.sid, 'practice_completed', data);
      }
    }
  };
  return Object.assign(observe, {
    requested: (sid: string, synthetic = false) => {
      if (!sid || synthetic) return;
      once(sid, 'practice_requested', { schema_version: 2 });
    },
  });
}

let storage: Storage | undefined;
try { if (typeof window !== 'undefined') storage = window.sessionStorage; } catch { /* 无存储仍可练习。 */ }
const observer = createPracticeObserver(trackEvent, storage);
export function observePractice(next: Snapshot): void { try { observer(next); } catch { /* 尽力统计。 */ } }
export function requestPractice(sid: string): void { observer.requested(sid); }
