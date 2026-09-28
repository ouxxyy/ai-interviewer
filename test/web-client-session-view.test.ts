/**
 * 会话页策略层回归测试（P0-1 / P1-2 / P2-3）。
 *
 * 这三项的共同点：界面行为依赖「服务端返回的是详情还是快照」「服务端现在在哪一阶段」，
 * 而这些判断以前散在组件里、只能靠浏览器手测。现在它们是纯函数，逐条钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HTTP_RECOVERY_TRANSITIONS,
  isSnapshot,
  isAnswering,
  observedFromDetail,
  questionProgress,
  recoveryNotice,
  recoveryStep,
  defaultRetry,
  latestReviewedFeedback,
  agentActivity,
  answerOpportunityKey,
  shouldAutoStartAnswer,
  type FailedOp,
  type ObservedSession,
} from '../web-client/src/lib/session-view.js';
import type { AppErrorBody, Snapshot } from '../web-client/src/types.js';

const snapshot: Snapshot = {
  sid: 's-1',
  state: 'answer',
  status: 'active',
  machine: { state: 'answer', questionIndex: 0, followupCount: 0, rewriteUsed: false, completed: 0 },
  synthetic: false,
  toggles: { saveHistory: true, saveAudio: true },
  materials: null,
  plan: null,
  currentQuestion: { id: 'q1', index: 0, text: '第一题', intent: '看事实' },
  pending: 'answer',
  lastError: null,
  halted: false,
  turns: [],
  reviews: {},
  reviewBasis: {},
  reviewMeta: [],
  rewriteDeltas: {},
  report: null,
  reportSource: null,
};

test('P0-1：详情接口返回的形状不是 Snapshot，必须被运行时守卫挡下', () => {
  // 这就是 manager.detail() 的真实字段集（HistorySessionDetail）。
  const detail = {
    sid: 's-1',
    live: true,
    persisted: false,
    status: 'active',
    state: 'answer',
    synthetic: false,
    createdAt: '',
    updatedAt: '',
    toggles: { saveHistory: false, saveAudio: false },
    materials: null,
    plan: null,
    turns: [],
    reviews: {},
    reviewMeta: [],
    reviewBasis: {},
    rewriteDeltas: {},
    report: null,
    reportSource: null,
    usage: { textCalls: 0, promptTokens: 0, completionTokens: 0, inputAudioBytes: 0, audioBytesIn: 0, audioBytesOut: 0 },
  };
  assert.equal(isSnapshot(detail), false, '详情不是快照：没有 machine，读 machine.questionIndex 会崩');
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(isSnapshot(null), false);
  assert.equal(isSnapshot({ sid: 'x' }), false);
  assert.equal(isSnapshot({ ...snapshot, machine: undefined }), false);
});

test('P0-1：从详情对账只取状态与计划是否就绪', () => {
  assert.deepEqual(observedFromDetail({ state: 'materials_review', plan: null }), { state: 'materials_review', planReady: false });
  assert.deepEqual(observedFromDetail({ state: 'question', plan: { questions: [] } }), { state: 'question', planReady: true });
});

test('P2-3：进度列表只按真实计划渲染，计划未到时返回 null（不写死 3 题）', () => {
  assert.equal(questionProgress(null, 0), null);
  assert.equal(questionProgress({ questions: [] }, 0), null);

  const three = questionProgress({ questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] } as never, 1);
  assert.equal(three!.length, 3);
  assert.deepEqual(three!.map((item) => [item.label, item.done, item.current]), [['第 1 题', true, false], ['第 2 题', false, true], ['第 3 题', false, false]]);

  const five = questionProgress({ questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i + 1}` })) } as never, 0);
  assert.equal(five!.length, 5, '真实 5 题就渲染 5 题');
});

test('P1-2：材料提交失败按对账结果分流到 materials 或 materials/retry-plan', () => {
  const op: FailedOp = { kind: 'materials', draft: { jd: 'jd', experience: 'exp', stage: '社招', targetRole: '' } };
  // 对账前不猜，先取服务端状态。
  assert.deepEqual(recoveryStep(op, null), { type: 'refresh', reason: 'unknown_state' });
  // 服务端还没受理：重发材料。
  assert.deepEqual(recoveryStep(op, { state: 'materials_review', planReady: false }), { type: 'http', name: 'materials', body: op.draft });
  // 服务端已受理但计划没出来（超时/计划失败）：只能重试出题，重发 materials 必然 E_STATE。
  assert.deepEqual(recoveryStep(op, { state: 'question', planReady: false }), { type: 'http', name: 'materials/retry-plan' });
  // 计划已经在了：服务端已经完成，采用权威快照并清掉失败上下文。
  assert.deepEqual(recoveryStep(op, { state: 'answer', planReady: true }), { type: 'adopt_snapshot' });
});

test('P1-2：断线后重发的动作必须由服务端阶段决定，不会发出注定被拒的请求', () => {
  const commit: FailedOp = { kind: 'answer_commit' };
  assert.deepEqual(recoveryStep(commit, { state: 'answer', planReady: true }), { type: 'resend_commit' });
  assert.deepEqual(recoveryStep(commit, { state: 'followup', planReady: true }), { type: 'resend_commit' });
  // 回答已经入库、评审阶段超时：answer.commit 会被状态机拒绝，必须先对账再判定不可重试。
  assert.deepEqual(recoveryStep(commit, { state: 'review', planReady: true }), { type: 'none', reason: 'not_retryable' });
  assert.deepEqual(recoveryStep(commit, null), { type: 'refresh', reason: 'unknown_state' });
  assert.equal(isAnswering('review'), false);
});

test('P1-2：HTTP 恢复明确声明前置态与成功后置态', () => {
  assert.deepEqual(HTTP_RECOVERY_TRANSITIONS['rewrite/start'], {
    before: ['rewrite'],
    succeeded: ['answer'],
  });
  assert.deepEqual(HTTP_RECOVERY_TRANSITIONS.next, {
    before: ['rewrite'],
    succeeded: ['question', 'answer', 'report', 'ended'],
  });
  assert.deepEqual(HTTP_RECOVERY_TRANSITIONS.end, {
    before: ['materials_review', 'question', 'answer', 'followup', 'review', 'rewrite'],
    succeeded: ['report', 'ended'],
  });
});

test('P1-2：请求已生效但响应丢失时采用权威快照，只有仍在前置态才重放', () => {
  const next: FailedOp = { kind: 'http', name: 'next' };
  assert.deepEqual(recoveryStep(next, { state: 'rewrite', planReady: true }), { type: 'http', name: 'next' }, '服务端尚未执行');
  assert.deepEqual(recoveryStep(next, { state: 'answer', planReady: true }), { type: 'adopt_snapshot' }, '服务端已进入下一题');
  assert.deepEqual(recoveryStep(next, { state: 'ended', planReady: true }), { type: 'adopt_snapshot' }, '最后一题已生成报告');

  const rewrite: FailedOp = { kind: 'http', name: 'rewrite/start' };
  assert.deepEqual(recoveryStep(rewrite, { state: 'rewrite', planReady: true }), { type: 'http', name: 'rewrite/start' });
  assert.deepEqual(recoveryStep(rewrite, { state: 'answer', planReady: true }), { type: 'adopt_snapshot' });

  const end: FailedOp = { kind: 'http', name: 'end' };
  assert.deepEqual(recoveryStep(end, { state: 'answer', planReady: true }), { type: 'http', name: 'end' });
  assert.deepEqual(recoveryStep(end, { state: 'report', planReady: true }), { type: 'adopt_snapshot' });
  assert.deepEqual(recoveryStep(end, { state: 'ended', planReady: true }), { type: 'adopt_snapshot' });
});

test('P1-2：额度止损态一律不给重试；未知 HTTP 动作不盲重放', () => {
  const halted: AppErrorBody = { code: 'E_QUOTA', message: '额度不足', halt: true };
  assert.deepEqual(recoveryStep({ kind: 'answer_start' }, { state: 'answer', planReady: true }, halted), { type: 'none', reason: 'halted' });
  assert.deepEqual(recoveryStep({ kind: 'http', name: 'unknown/action' }, { state: 'answer', planReady: true }), { type: 'none', reason: 'not_retryable' });
});

test('P1-2：没有失败上下文时 recoveryStep 不下结论（重连不许冒充重试）', () => {
  assert.deepEqual(recoveryStep(null, { state: 'answer', planReady: true }), { type: 'none', reason: 'no_context' });
  assert.deepEqual(recoveryStep(null, { state: 'review', planReady: true }), { type: 'none', reason: 'no_context' });
  assert.deepEqual(recoveryStep(null, null), { type: 'none', reason: 'no_context' });
});

test('P1-2：只有显式「再试一次」才走 defaultRetry，且服务端必须停在可作答阶段', () => {
  assert.deepEqual(defaultRetry({ state: 'answer', planReady: true }), { type: 'start_answer' });
  assert.deepEqual(defaultRetry({ state: 'followup', planReady: true }), { type: 'start_answer' });
  assert.deepEqual(defaultRetry({ state: 'review', planReady: true }), { type: 'none', reason: 'no_context' });
  assert.deepEqual(defaultRetry(null), { type: 'none', reason: 'no_context' });
});

test('P1-2：不可重试要有明确文案，不能给死路按钮却不说明', () => {
  assert.notEqual(recoveryNotice({ type: 'none', reason: 'not_retryable' }), '');
  assert.notEqual(recoveryNotice({ type: 'none', reason: 'halted' }), '');
  assert.equal(recoveryNotice({ type: 'http', name: 'next' }), '');
});

test('P0-1：live 快照的判据必须是服务端真实字段，而不是类型断言', () => {
  const observed: ObservedSession = observedFromDetail({ state: 'answer', plan: { questions: [] } });
  assert.equal(observed.planReady, true);
  assert.equal(isSnapshot({ ...snapshot, reviewMeta: undefined }), false);
  assert.equal(isSnapshot({ ...snapshot, turns: 'nope' }), false);
});

test('流程反馈：进入下一题后仍展示最近一题已校验的原话与点评', () => {
  const feedback = {
    questionId: 'q2',
    reviewBasis: { turnIds: ['t2'], textVersion: 'raw' as const },
    topImprovement: '先说清你的个人动作',
    nextFacts: ['补充结果'],
    factGaps: [],
    dimensions: {} as never,
    reviewVersion: 'test',
  };
  const basis = { questionId: 'q2', text: '我负责协调两个团队并按时上线。', turnIds: ['t2'], textVersion: 'raw' as const };
  const current = {
    ...snapshot,
    machine: { ...snapshot.machine, questionIndex: 2, completed: 2 },
    currentQuestion: { id: 'q3', index: 2, text: '第三题', intent: '看反思' },
    plan: {
      questions: [
        { id: 'q1', text: '第一题' },
        { id: 'q2', text: '第二题' },
        { id: 'q3', text: '第三题' },
      ],
      askedTopics: [],
    } as never,
    reviews: { q2: feedback },
    reviewBasis: { q2: basis },
  } satisfies Snapshot;

  assert.deepEqual(latestReviewedFeedback(current), {
    questionId: 'q2',
    questionNumber: 2,
    current: false,
    feedback,
    basis,
  });

  const q3Feedback = { ...feedback, questionId: 'q3' };
  const q3Basis = { ...basis, questionId: 'q3', turnIds: ['t3'] };
  const reviewedCurrent = { ...current, reviews: { q2: feedback, q3: q3Feedback }, reviewBasis: { q2: basis, q3: q3Basis } };
  assert.equal(latestReviewedFeedback(reviewedCurrent)?.questionId, 'q3', '当前题一旦评审完成，应立即切到当前题点评');
});

test('Agent 状态：评审等待显示真实阶段、等待秒数与未卡死说明', () => {
  assert.deepEqual(agentActivity({ state: 'review', audioStatus: 'idle', recording: false, busy: true, elapsedSeconds: 12 }), {
    kind: 'reviewing',
    active: true,
    title: '正在核对你的原话',
    detail: '已等待 12 秒；正在生成结构化点评，已提交的回答不会丢失。',
  });
  assert.equal(agentActivity({ state: 'answer', audioStatus: 'listening', recording: true, busy: false, elapsedSeconds: 0 }).title, '小八正在听你的回答');
  assert.equal(agentActivity({ state: 'answer', audioStatus: 'idle', recording: false, busy: false, elapsedSeconds: 0 }).active, false);
  assert.equal(agentActivity({ state: 'answer', audioStatus: 'offline', recording: false, busy: false, elapsedSeconds: 0 }).title, '实时连接已断开');
});

test('连续面试：第一轮必须手动，完成首次授权后才自动开始后续主问题／追问／重答', () => {
  const q1 = { ...snapshot, plan: { questions: [{ id: 'q1' }] } as never } satisfies Snapshot;
  const base = {
    mode: 'continuous' as const,
    state: 'answer' as const,
    audioStatus: 'idle' as const,
    recording: false,
    busy: false,
    paused: false,
    offline: false,
    hasError: false,
    opportunityKey: answerOpportunityKey(q1),
    lastAttemptedKey: null,
  };
  assert.equal(shouldAutoStartAnswer({ ...base, hasStartedOnce: false }), false, '第一题第一次必须由用户点击并触发权限');
  assert.equal(shouldAutoStartAnswer({ ...base, hasStartedOnce: true }), true, '首次开始后，同一场后续机会可自动开麦');

  const followup = {
    ...q1,
    state: 'followup' as const,
    machine: { ...q1.machine, state: 'followup' as const, followupCount: 1 },
    turns: [{ id: 'iq1', questionId: 'q1', speaker: 'interviewer' as const, turnType: 'followup' as const, seq: 2, startedAt: '', endedAt: '', rawTranscript: '你个人做了什么？', revisedText: null, audioFile: null }],
  } satisfies Snapshot;
  assert.notEqual(answerOpportunityKey(followup), answerOpportunityKey(q1), '追问是新的开麦机会');
  assert.equal(shouldAutoStartAnswer({ ...base, state: 'followup', hasStartedOnce: true, opportunityKey: answerOpportunityKey(followup) }), true);

  const rewrite = { ...q1, machine: { ...q1.machine, rewriteUsed: true } } satisfies Snapshot;
  assert.notEqual(answerOpportunityKey(rewrite), answerOpportunityKey(q1), '主动点重答后是新的开麦机会');
});

test('连续面试止损：说话中、播放中、暂停、断线、报错、处理中或同一机会已尝试时绝不自动开麦', () => {
  const base = {
    mode: 'continuous' as const,
    state: 'answer' as const,
    audioStatus: 'idle' as const,
    recording: false,
    busy: false,
    paused: false,
    offline: false,
    hasError: false,
    hasStartedOnce: true,
    opportunityKey: 'q2:question:t2',
    lastAttemptedKey: null,
  };
  assert.equal(shouldAutoStartAnswer({ ...base, mode: 'manual' }), false);
  assert.equal(shouldAutoStartAnswer({ ...base, audioStatus: 'playing' }), false);
  assert.equal(shouldAutoStartAnswer({ ...base, recording: true }), false);
  assert.equal(shouldAutoStartAnswer({ ...base, paused: true }), false);
  assert.equal(shouldAutoStartAnswer({ ...base, offline: true }), false);
  assert.equal(shouldAutoStartAnswer({ ...base, hasError: true }), false);
  assert.equal(shouldAutoStartAnswer({ ...base, busy: true }), false);
  assert.equal(shouldAutoStartAnswer({ ...base, lastAttemptedKey: base.opportunityKey }), false, '同一轮失败后不得循环弹权限或反复热麦');
});
