/**
 * 应用层状态机（MYW-84 §4；PM D2/D5/D6）。
 *
 * 状态：materials_review → question → answer → followup? → review → rewrite? → next_question | report
 * 流程控制权在应用层：实时模型不决定何时点评或下一题。
 *
 * 硬约束：
 * - 每题追问 0–2 次（followupCount ≤ 2）
 * - 每题重答 ≤1 次；重答轮 0 追问（D5）
 * - 共 3 道主问题；第 3 题点评后只能进报告
 * - 任意非终态可提前结束 → report（D6：零完成也生成报告）
 */

export type SessionState =
  | 'materials_review'
  | 'question'
  | 'answer'
  | 'followup'
  | 'review'
  | 'rewrite'
  | 'report'
  | 'ended';

export type SessionEvent =
  // 正常流
  | 'MATERIALS_CONFIRMED'
  | 'QUESTION_SENT'
  | 'ANSWER_START'
  | 'ANSWER_DONE'
  | 'FOLLOWUP_NEEDED'
  | 'FOLLOWUP_DONE'
  | 'NO_FOLLOWUP'
  | 'REVIEW_DONE'
  | 'REWRITE_START'
  | 'REWRITE_DONE'
  | 'SKIP_REWRITE'
  | 'NEXT_QUESTION'
  | 'REPORT_GENERATED'
  | 'END_SESSION'
  // 异常与恢复
  | 'TEXT_REVISED'
  | 'REVISE_AFTER_REVIEW'
  | 'ERROR_DISCONNECT'
  | 'ERROR_TIMEOUT'
  | 'ERROR_EMPTY_TRANSCRIPT'
  | 'ERROR_MIC_DENIED'
  | 'ERROR_PARSE_FAILURE';

export interface MachineAction {
  type: string;
  detail?: string;
  [extra: string]: unknown;
}

export interface MachineOutput {
  accepted: boolean;
  state: SessionState;
  actions: MachineAction[];
  error?: string;
}

export interface MachineSnapshot {
  state: SessionState;
  questionIndex: number; // 0-based，当前第几题
  followupCount: number; // 当前题已追问次数
  rewriteUsed: boolean; // 当前题是否已重答
  completed: number; // 已完成（点评）题数
}

const MAX_QUESTIONS = 3;
const MAX_FOLLOWUPS = 2;

export class SessionMachine {
  private state: SessionState = 'materials_review';
  private questionIndex = 0;
  private followupCount = 0;
  private rewriteUsed = false;
  private completed = 0;

  snapshot(): MachineSnapshot {
    return { state: this.state, questionIndex: this.questionIndex, followupCount: this.followupCount, rewriteUsed: this.rewriteUsed, completed: this.completed };
  }

  /** 非法转移统一拒绝并返回原因，不抛异常，便于测试与日志。 */
  fire(event: SessionEvent): MachineOutput {
    const reject = (why: string): MachineOutput => ({ accepted: false, state: this.state, actions: [], error: why });
    const accept = (next: SessionState, ...actions: MachineAction[]): MachineOutput => {
      this.state = next;
      return { accepted: true, state: this.state, actions };
    };

    switch (event) {
      case 'MATERIALS_CONFIRMED':
        if (this.state !== 'materials_review') return reject(`状态 ${this.state} 不允许确认材料`);
        return accept('question', { type: 'generate_question_plan' }, { type: 'send_question', questionIndex: 0 });

      case 'QUESTION_SENT':
        if (this.state !== 'question') return reject(`状态 ${this.state} 不存在待发送问题`);
        return accept('answer', { type: 'open_mic_and_listen' });

      case 'ANSWER_START':
        if (this.state !== 'answer') return reject(`状态 ${this.state} 不允许开始回答`);
        return accept('answer', { type: 'record_turn_start' });

      case 'ANSWER_DONE':
        if (this.state !== 'answer' && this.state !== 'followup') return reject(`状态 ${this.state} 没有进行中的回答`);
        return accept('review', { type: 'freeze_answer_text' }, { type: 'run_review' });

      case 'FOLLOWUP_NEEDED':
        if (this.state !== 'answer') return reject(`状态 ${this.state} 不存在可追问的回答`);
        if (this.rewriteUsed) return reject('重答轮不允许追问（D5）');
        if (this.followupCount >= MAX_FOLLOWUPS) return reject(`每题追问上限 ${MAX_FOLLOWUPS} 次已用尽`);
        this.followupCount += 1;
        return accept('followup', { type: 'send_followup', index: this.followupCount });

      case 'FOLLOWUP_DONE':
        if (this.state !== 'followup') return reject(`状态 ${this.state} 没有进行中的追问`);
        return accept('answer', { type: 'continue_listening' });

      case 'NO_FOLLOWUP':
        if (this.state !== 'answer') return reject(`状态 ${this.state} 不适用追问判定`);
        return accept('answer', { type: 'await_manual_or_auto_done' });

      case 'REVIEW_DONE':
        if (this.state !== 'review') return reject(`状态 ${this.state} 没有待完成点评`);
        return accept('rewrite', { type: 'show_feedback_and_offer_rewrite' });

      case 'REWRITE_START':
        if (this.state !== 'rewrite') return reject(`状态 ${this.state} 不允许发起重答`);
        if (this.rewriteUsed) return reject('每题最多重答一次');
        this.rewriteUsed = true;
        return accept('answer', { type: 'open_mic_for_rewrite', note: '重答轮不追问' });

      case 'REWRITE_DONE':
        if (this.state !== 'answer' && this.state !== 'followup') return reject(`状态 ${this.state} 没有进行中的重答`);
        if (!this.rewriteUsed) return reject('当前不是重答轮');
        return accept('review', { type: 'run_comparison_review' });

      case 'SKIP_REWRITE':
        if (this.state !== 'rewrite') return reject(`状态 ${this.state} 不在重答选择点`);
        return this.afterReview();

      case 'NEXT_QUESTION':
        if (this.state !== 'rewrite') return reject(`状态 ${this.state} 不在选择下一题的节点`);
        return this.afterReview();

      case 'REPORT_GENERATED':
        if (this.state !== 'report') return reject(`状态 ${this.state} 不在报告生成点`);
        return accept('ended', { type: 'archive_session' });

      case 'END_SESSION':
        if (this.state === 'ended' || this.state === 'report') return reject('会话已结束');
        return accept('report', { type: 'generate_report', completed: this.completed, early: true });

      case 'TEXT_REVISED':
        if (this.state !== 'answer') return reject(`状态 ${this.state} 不在可修订的提交前阶段`);
        return accept('answer', { type: 'keep_revision_apart_from_raw' });

      case 'REVISE_AFTER_REVIEW':
        if (this.state !== 'review' && this.state !== 'rewrite') return reject(`状态 ${this.state} 不允许修订后重评审`);
        return accept('review', { type: 'invalidate_previous_review' }, { type: 'switch_basis_to_revised' }, { type: 'run_review' });

      case 'ERROR_MIC_DENIED':
        if (this.state !== 'answer' && this.state !== 'followup') return reject(`状态 ${this.state} 不涉及麦克风`);
        return accept(this.state, { type: 'show_mic_denied_state' }, { type: 'allow_retry_or_end' });

      case 'ERROR_EMPTY_TRANSCRIPT':
        if (this.state !== 'answer' && this.state !== 'followup') return reject(`状态 ${this.state} 不涉及转写`);
        return accept(this.state, { type: 'show_empty_transcript_state' }, { type: 'reprompt_same_question', note: '不消耗追问次数' });

      case 'ERROR_TIMEOUT':
        if (this.state === 'answer' || this.state === 'followup') return accept(this.state, { type: 'show_timeout_state' }, { type: 'allow_continue_or_redo' });
        if (this.state === 'review') return accept('review', { type: 'retry_review_once' });
        return reject(`状态 ${this.state} 无超时处理路径`);

      case 'ERROR_DISCONNECT':
        if (this.state !== 'answer' && this.state !== 'followup' && this.state !== 'review') return reject(`状态 ${this.state} 断线恢复规则未定义`);
        return accept('answer', { type: 'recover_last_complete_turn' }, { type: 'fallback_redo_current_question_if_unrecoverable' });

      case 'ERROR_PARSE_FAILURE':
        if (this.state !== 'materials_review') return reject(`状态 ${this.state} 不在材料解析阶段`);
        return accept('materials_review', { type: 'explain_parse_failure' }, { type: 'allow_direct_paste' });

      default:
        return reject(`未知事件 ${String(event)}`);
    }
  }

  /** 点评完成后的去向：第 3 题 → report，否则回 question 出下一题。 */
  private afterReview(): MachineOutput {
    this.completed += 1;
    this.followupCount = 0;
    this.rewriteUsed = false;
    if (this.questionIndex + 1 >= MAX_QUESTIONS) {
      this.state = 'report';
      return { accepted: true, state: this.state, actions: [{ type: 'generate_report', completed: this.completed }] };
    }
    this.questionIndex += 1;
    this.state = 'question';
    return { accepted: true, state: this.state, actions: [{ type: 'send_question', questionIndex: this.questionIndex }] };
  }
}

/** 全部合法转移（供测试与文档核对）：[起始状态, 事件] → 目标状态。 */
export const LEGAL_TRANSITIONS: Array<{ from: SessionState; event: SessionEvent; to: SessionState | 'question-or-report' }> = [
  { from: 'materials_review', event: 'MATERIALS_CONFIRMED', to: 'question' },
  { from: 'question', event: 'QUESTION_SENT', to: 'answer' },
  { from: 'answer', event: 'ANSWER_START', to: 'answer' },
  { from: 'answer', event: 'ANSWER_DONE', to: 'review' },
  { from: 'answer', event: 'FOLLOWUP_NEEDED', to: 'followup' },
  { from: 'answer', event: 'NO_FOLLOWUP', to: 'answer' },
  { from: 'answer', event: 'TEXT_REVISED', to: 'answer' },
  { from: 'followup', event: 'FOLLOWUP_DONE', to: 'answer' },
  { from: 'followup', event: 'ANSWER_DONE', to: 'review' },
  { from: 'review', event: 'REVIEW_DONE', to: 'rewrite' },
  { from: 'review', event: 'REVISE_AFTER_REVIEW', to: 'review' },
  { from: 'review', event: 'ERROR_TIMEOUT', to: 'review' },
  { from: 'rewrite', event: 'REWRITE_START', to: 'answer' },
  { from: 'answer', event: 'REWRITE_DONE', to: 'review' },
  { from: 'rewrite', event: 'SKIP_REWRITE', to: 'question-or-report' },
  { from: 'rewrite', event: 'NEXT_QUESTION', to: 'question-or-report' },
  { from: 'rewrite', event: 'REVISE_AFTER_REVIEW', to: 'review' },
  { from: 'report', event: 'REPORT_GENERATED', to: 'ended' },
];
