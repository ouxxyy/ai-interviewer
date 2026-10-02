import type { Snapshot } from '../types.js';
type Data = Record<string, string | number>;
type Emit = (name: string, data?: Data) => void;
declare global { interface Window { oubaAnalytics?: { track: Emit } } }
export const trackEvent: Emit = (name, data) => {
  try { if (typeof window !== 'undefined') window.oubaAnalytics?.track(name, data); } catch { /* analytics never blocks practice */ }
};
export function createPracticeObserver(emit: Emit, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const seen = new Set<string>();
  const active = new Set<string>();
  const once = (sid: string, event: string, data?: Data) => {
    const key = 'ouba.analytics.v1:' + event + ':' + sid;
    if (seen.has(key)) return;
    try { if (storage?.getItem(key)) { seen.add(key); return; } } catch {}
    seen.add(key);
    try { storage?.setItem(key, '1'); } catch {}
    try { emit(event, data); } catch {}
  };
  return (next: Snapshot) => {
    if (next.synthetic || !next.sid) return;
    if (next.state !== 'ended') active.add(next.sid);
    if (next.state === 'question' && next.machine.questionIndex === 0 && next.plan && next.plan.questions.length > 0) {
      once(next.sid, 'practice_started', { total_questions: next.plan.questions.length });
    }
    if (next.state === 'ended' && next.report && active.has(next.sid)) {
      const data = { completed_questions: next.report.completedQuestions, total_questions: next.report.totalQuestions };
      once(next.sid, 'practice_ended', data);
      if (next.report.sessionStatus === 'completed' && data.total_questions > 0 && data.completed_questions >= data.total_questions) once(next.sid, 'practice_completed', data);
    }
  };
}
let storage: Storage | undefined;
try { if (typeof window !== 'undefined') storage = window.sessionStorage; } catch {}
const observer = createPracticeObserver(trackEvent, storage);
export function observePractice(next: Snapshot) { try { observer(next); } catch {} }
