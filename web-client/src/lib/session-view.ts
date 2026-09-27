/**
 * 会话页的纯策略层：类型守卫、题量进度、失败动作恢复（P0-1 / P1-2 / P2-3）。
 *
 * 为什么单独一层：这三件事都是「按服务端真实形状和真实状态决定界面行为」的规则，
 * 放在组件里只能靠浏览器手测；放在这里可以在 Node 里逐条回归。
 */
import type { AppErrorBody, MaterialsDraft, PlannedQuestion, SessionState } from '../types.js';

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
  | { type: 'refresh'; reason: 'unknown_state' }
  | { type: 'none'; reason: 'no_context' | 'not_retryable' | 'halted' };

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
      return { type: 'http', name: op.name, ...(op.body === undefined ? {} : { body: op.body }) };
    case 'answer_start':
      return { type: 'start_answer' };
    case 'answer_commit':
      if (observed === null) return { type: 'refresh', reason: 'unknown_state' };
      return isAnswering(observed.state) ? { type: 'resend_commit' } : { type: 'none', reason: 'not_retryable' };
    case 'materials':
      if (observed === null) return { type: 'refresh', reason: 'unknown_state' };
      if (observed.state === 'materials_review') return { type: 'http', name: 'materials', body: op.draft };
      if (observed.state === 'question' && !observed.planReady) return { type: 'http', name: 'materials/retry-plan' };
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
