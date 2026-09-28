/**
 * 会话页的纯策略层：类型守卫、题量进度、失败动作恢复（P0-1 / P1-2 / P2-3）。
 *
 * 为什么单独一层：这三件事都是「按服务端真实形状和真实状态决定界面行为」的规则，
 * 放在组件里只能靠浏览器手测；放在这里可以在 Node 里逐条回归。
 */
import type { AppErrorBody, Feedback, MaterialsDraft, PlannedQuestion, ReviewBasisDetail, SessionState, Snapshot, WebSettings } from '../types.js';

/**
 * `GET /api/sessions/:sid` 返回的是**历史/详情形状**，没有 `machine` / `currentQuestion` /
 * `pending` / `lastError` / `halted`（见 `src/web/manager.ts` 的 `HistorySessionDetail`）。
 * 只有 `POST /api/sessions` 的 `{snapshot}`、各动作响应与 WS `state` 消息才是完整 `Snapshot`。
 * 运行时守卫用来挡住「把详情当快照」这类错误，而不是靠类型断言。
 */
export function isSnapshot(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const machine = candidate.machine as Record<string, unknown> | undefined;
  return (
    typeof candidate.sid === 'string' &&
    typeof candidate.state === 'string' &&
    machine !== null &&
    typeof machine === 'object' &&
    typeof machine?.questionIndex === 'number' &&
    Array.isArray(candidate.turns) &&
    Array.isArray(candidate.reviewMeta)
  );
}

export interface ObservedSession {
  state: SessionState;
  planReady: boolean;
}

export function observedFromDetail(detail: { state: string; plan: unknown }): ObservedSession {
  return {
    state: detail.state as SessionState,
    planReady: detail.plan !== null && detail.plan !== undefined,
  };
}

/** 服务端还能接受 `answer.commit` 的阶段。 */
export function isAnswering(state: SessionState | undefined): boolean {
  return state === 'answer' || state === 'followup';
}

// ---------- 题量进度（P2-3） ----------

export interface ProgressItem {
  key: string;
  label: string;
  current: boolean;
  done: boolean;
}

/**
 * 进度列表只按真实计划渲染，绝不写死题数。
 * 计划还没到时返回 `null`，由页面显示单独的 loading 占位。
 */
export function questionProgress(plan: { questions: PlannedQuestion[] } | null, questionIndex: number): ProgressItem[] | null {
  if (plan === null || plan.questions.length === 0) return null;
  return plan.questions.map((question, index) => ({
    key: question.id,
    label: `第 ${index + 1} 题`,
    current: index === questionIndex,
    done: index < questionIndex,
  }));
}

// ---------- 过程点评与 Agent 状态 ----------

export interface ReviewedFeedbackView {
  questionId: string;
  questionNumber: number;
  current: boolean;
  feedback: Feedback;
  basis: ReviewBasisDetail;
}

/**
 * 当前题还没有点评时，不把已完成的上一题点评从界面抹掉。
 * 只返回同时具备 Feedback + 评审基准的题，页面后续仍须逐条校验引用再展示。
 */
export function latestReviewedFeedback(snapshot: Snapshot | null): ReviewedFeedbackView | null {
  if (snapshot?.plan === null || snapshot?.plan === undefined) return null;
  const currentId = snapshot.currentQuestion?.id;
  const plannedCurrentIndex = currentId === undefined ? -1 : snapshot.plan.questions.findIndex((question) => question.id === currentId);
  const lastEligibleIndex = plannedCurrentIndex >= 0
    ? plannedCurrentIndex
    : Math.min(snapshot.machine.questionIndex, snapshot.plan.questions.length - 1);
  for (let index = lastEligibleIndex; index >= 0; index -= 1) {
    const question = snapshot.plan.questions[index];
    if (question === undefined) continue;
    const feedback = snapshot.reviews[question.id];
    const basis = snapshot.reviewBasis[question.id];
    if (feedback !== undefined && basis !== undefined) {
      return {
        questionId: question.id,
        questionNumber: index + 1,
        current: question.id === currentId,
        feedback,
        basis,
      };
    }
  }
  return null;
}

export type AgentActivityKind = 'connecting' | 'speaking' | 'listening' | 'reviewing' | 'preparing' | 'ready' | 'paused' | 'offline';
export type AgentAudioStatus = 'connecting' | 'idle' | 'listening' | 'playing' | 'paused' | 'closed' | 'offline';

export interface AgentActivity {
  kind: AgentActivityKind;
  active: boolean;
  title: string;
  detail: string;
}

/** 映射真实会话/音频状态；不把计时器伪装成后端百分比进度。 */
export function agentActivity(input: {
  state: SessionState | undefined;
  audioStatus: AgentAudioStatus;
  recording: boolean;
  busy: boolean;
  elapsedSeconds: number;
}): AgentActivity {
  if (input.audioStatus === 'offline' || input.audioStatus === 'closed') {
    return { kind: 'offline', active: false, title: '实时连接已断开', detail: '已完成的回答仍在服务端；重新连接后可继续。' };
  }
  if (input.audioStatus === 'paused') {
    return { kind: 'paused', active: false, title: '已暂停', detail: '暂停期间不会继续上传音频，点“恢复”后再继续说。' };
  }
  if (input.audioStatus === 'connecting' || input.state === undefined) {
    return { kind: 'connecting', active: true, title: '正在连接面试官', detail: `已等待 ${input.elapsedSeconds} 秒；正在读取这场练习的状态。` };
  }
  if (input.audioStatus === 'playing') {
    return { kind: 'speaking', active: true, title: '小八正在说', detail: '可以随时点“打断”，旧回应的待播音频会被清空。' };
  }
  if (input.recording || input.audioStatus === 'listening') {
    return { kind: 'listening', active: true, title: '小八正在听你的回答', detail: '你的语音只会进入回答转写；说完后再进行引用核对。' };
  }
  if (input.state === 'review' || (input.busy && (input.state === 'answer' || input.state === 'followup'))) {
    const detail = input.elapsedSeconds >= 8
      ? `已等待 ${input.elapsedSeconds} 秒；正在生成结构化点评，已提交的回答不会丢失。`
      : `已等待 ${input.elapsedSeconds} 秒；正在校验引用位置并整理五维点评。`;
    return { kind: 'reviewing', active: true, title: '正在核对你的原话', detail };
  }
  if (input.busy) {
    return { kind: 'preparing', active: true, title: '正在进入下一步', detail: `已等待 ${input.elapsedSeconds} 秒；正在同步会话状态。` };
  }
  if (input.state === 'rewrite') {
    return { kind: 'ready', active: false, title: '点评已就绪', detail: '你可以按建议重答一次，或直接进入下一题。' };
  }
  return { kind: 'ready', active: false, title: '轮到你作答', detail: '点击“开始作答”；完成后会立即显示原话引用、点评和建议。' };
}

// ---------- 连续面试自动开麦 ----------

/**
 * 每个可回答节点的稳定键。主问题、每次追问和重答各不相同，用于保证自动开麦至多尝试一次。
 */
export function answerOpportunityKey(snapshot: Snapshot | null): string | null {
  if (snapshot?.currentQuestion === null || snapshot?.currentQuestion === undefined || !isAnswering(snapshot.state)) return null;
  const latestInterviewerTurn = [...snapshot.turns]
    .reverse()
    .find((turn) => turn.questionId === snapshot.currentQuestion?.id && turn.speaker === 'interviewer');
  const phase = snapshot.machine.rewriteUsed
    ? 'rewrite'
    : snapshot.machine.followupCount > 0
      ? `followup-${snapshot.machine.followupCount}`
      : 'question';
  return `${snapshot.currentQuestion.id}:${phase}:${latestInterviewerTurn?.id ?? 'no-interviewer-turn'}`;
}

/**
 * 自动开麦只减少重复点击，不放松安全边界：第一轮需用户手动授权；播放、暂停、断线、
 * 错误、处理中和同一轮已尝试时都不触发。回答结束仍由用户点「说完了」。
 */
export function shouldAutoStartAnswer(input: {
  mode: WebSettings['answerStartMode'];
  state: SessionState | undefined;
  audioStatus: AgentAudioStatus;
  recording: boolean;
  busy: boolean;
  paused: boolean;
  offline: boolean;
  hasError: boolean;
  hasStartedOnce: boolean;
  opportunityKey: string | null;
  lastAttemptedKey: string | null;
}): boolean {
  return (
    input.mode === 'continuous' &&
    input.hasStartedOnce &&
    isAnswering(input.state) &&
    input.audioStatus === 'idle' &&
    !input.recording &&
    !input.busy &&
    !input.paused &&
    !input.offline &&
    !input.hasError &&
    input.opportunityKey !== null &&
    input.opportunityKey !== input.lastAttemptedKey
  );
}

// ---------- 失败动作恢复（P1-2） ----------

export type FailedOp =
  | { kind: 'materials'; draft: MaterialsDraft }
  | { kind: 'answer_start' }
  | { kind: 'answer_commit' }
  | { kind: 'http'; name: string; body?: unknown };

export type RecoveryStep =
  | { type: 'http'; name: string; body?: unknown }
  | { type: 'start_answer' }
  | { type: 'resend_commit' }
  | { type: 'adopt_snapshot' }
  | { type: 'refresh'; reason: 'unknown_state' }
  | { type: 'none'; reason: 'no_context' | 'not_retryable' | 'halted' };

interface HttpRecoveryTransition {
  before: readonly SessionState[];
  succeeded: readonly SessionState[];
}

/**
 * 非幂等 HTTP 动作的恢复边界。
 *
 * `before` 表示服务端仍未执行、可以安全重放；`succeeded` 表示服务端已经推进，必须采用
 * 权威快照而不能再发一次。没有登记的动作一律不猜、不重放。
 */
export const HTTP_RECOVERY_TRANSITIONS: Readonly<Record<string, HttpRecoveryTransition>> = {
  materials: { before: ['materials_review'], succeeded: ['question', 'answer'] },
  'materials/retry-plan': { before: ['question'], succeeded: ['question', 'answer'] },
  review: { before: ['answer', 'followup'], succeeded: ['review', 'rewrite'] },
  'rewrite/start': { before: ['rewrite'], succeeded: ['answer'] },
  next: { before: ['rewrite'], succeeded: ['question', 'answer', 'report', 'ended'] },
  end: {
    before: ['materials_review', 'question', 'answer', 'followup', 'review', 'rewrite'],
    succeeded: ['report', 'ended'],
  },
  report: { before: ['report'], succeeded: ['ended'] },
};

function recoverHttp(op: Extract<FailedOp, { kind: 'http' }>, observed: ObservedSession | null): RecoveryStep {
  if (observed === null) return { type: 'refresh', reason: 'unknown_state' };
  const transition = HTTP_RECOVERY_TRANSITIONS[op.name];
  if (transition === undefined) return { type: 'none', reason: 'not_retryable' };

  // retry-plan 在生成计划期间仍是 question；planReady 才能区分「尚未执行」与「已经生效」。
  if (op.name === 'materials/retry-plan') {
    if (observed.state === 'question' && !observed.planReady) {
      return { type: 'http', name: op.name, ...(op.body === undefined ? {} : { body: op.body }) };
    }
    if (observed.planReady && transition.succeeded.includes(observed.state)) return { type: 'adopt_snapshot' };
    return { type: 'none', reason: 'not_retryable' };
  }

  if (transition.succeeded.includes(observed.state)) return { type: 'adopt_snapshot' };
  if (transition.before.includes(observed.state)) {
    return { type: 'http', name: op.name, ...(op.body === undefined ? {} : { body: op.body }) };
  }
  return { type: 'none', reason: 'not_retryable' };
}

/**
 * 把「哪一步失败了」+「服务端现在在哪一阶段」映射成一个**不会被状态机拒绝**的恢复动作。
 *
 * - 材料提交失败后服务端已经受理（state 已推进）时，不能重发 `materials`，要按对账结果
 *   改走 `materials/retry-plan`。
 * - 对账信息缺失时先 `refresh`，不猜。
 * - 已经无法安全重试的（例如回答已入库、评审阶段超时）明确返回 `none`，
 *   而不是发一个注定 E_STATE 的请求。
 * - **没有失败上下文时一律 `no_context`**：重连本身不是「重试上一次操作」，
 *   不能借重连去自动开麦（默认重试语义见 `defaultRetry`，只由用户显式点「再试一次」触发）。
 */
export function recoveryStep(op: FailedOp | null, observed: ObservedSession | null, error?: AppErrorBody | null): RecoveryStep {
  if (error?.halt === true || error?.code === 'E_QUOTA') return { type: 'none', reason: 'halted' };
  if (op === null) return { type: 'none', reason: 'no_context' };
  switch (op.kind) {
    case 'http':
      return recoverHttp(op, observed);
    case 'answer_start':
      return { type: 'start_answer' };
    case 'answer_commit':
      if (observed === null) return { type: 'refresh', reason: 'unknown_state' };
      return isAnswering(observed.state) ? { type: 'resend_commit' } : { type: 'none', reason: 'not_retryable' };
    case 'materials':
      if (observed === null) return { type: 'refresh', reason: 'unknown_state' };
      if (observed.state === 'materials_review') return { type: 'http', name: 'materials', body: op.draft };
      if (observed.state === 'question' && !observed.planReady) return { type: 'http', name: 'materials/retry-plan' };
      if (observed.planReady && (observed.state === 'question' || observed.state === 'answer')) return { type: 'adopt_snapshot' };
      return { type: 'none', reason: 'not_retryable' };
  }
}

/**
 * 没有失败上下文时，「再试一次」的兜底语义：只有服务端确实停在可作答阶段才重新开始作答；
 * 否则什么也不发，并如实说明没有可重试的操作。
 */
export function defaultRetry(observed: ObservedSession | null): RecoveryStep {
  return observed !== null && isAnswering(observed.state) ? { type: 'start_answer' } : { type: 'none', reason: 'no_context' };
}

/** 无法自动恢复时给用户看的说明（不假装「已修复」）。 */
export function recoveryNotice(step: RecoveryStep): string {
  if (step.type !== 'none') return '';
  if (step.reason === 'halted') return '本场已按止损停止，不再自动重试。';
  if (step.reason === 'not_retryable') return '这一步已经由服务端记录，不能重复提交。你可以「重听本题」，或结束本场查看已完成的题目。';
  if (step.reason === 'no_context') return '暂时没有可重试的操作。如果连接已恢复，直接按界面上的按钮继续即可。';
  return '服务端状态还没对上，请稍后再试。';
}
