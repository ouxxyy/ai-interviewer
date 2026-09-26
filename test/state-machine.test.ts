import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionMachine, LEGAL_TRANSITIONS } from '../src/state/machine.js';

function fresh(): SessionMachine {
  return new SessionMachine();
}

function oneQuestionCycle(m: SessionMachine, opts: { followups: number; rewrite: boolean } = { followups: 0, rewrite: false }): void {
  m.fire('QUESTION_SENT');
  m.fire('ANSWER_START');
  for (let i = 0; i < opts.followups; i++) {
    m.fire('FOLLOWUP_NEEDED');
    m.fire('FOLLOWUP_DONE');
  }
  m.fire('ANSWER_DONE');
  m.fire('REVIEW_DONE');
  if (opts.rewrite) {
    m.fire('REWRITE_START');
    m.fire('REWRITE_DONE');
    m.fire('REVIEW_DONE');
  }
  m.fire('SKIP_REWRITE'); // 跳过重答选择点 → 下一题或报告
}

test('主链路：3 题 happy path 全程合法转移', () => {
  const m = fresh();
  assert.equal(m.fire('MATERIALS_CONFIRMED').accepted, true);
  assert.equal(m.snapshot().state, 'question');
  oneQuestionCycle(m, { followups: 2, rewrite: false });
  assert.equal(m.snapshot().state, 'question');
  assert.equal(m.snapshot().questionIndex, 1);
  oneQuestionCycle(m, { followups: 0, rewrite: true });
  assert.equal(m.snapshot().state, 'question');
  assert.equal(m.snapshot().questionIndex, 2);
  oneQuestionCycle(m, { followups: 1, rewrite: false });
  assert.equal(m.snapshot().state, 'report');
  assert.equal(m.snapshot().completed, 3);
  const r = m.fire('REPORT_GENERATED');
  assert.equal(r.accepted, true);
  assert.equal(m.snapshot().state, 'ended');
});

test('追问上限：第 3 次追问被拒绝', () => {
  const m = fresh();
  m.fire('MATERIALS_CONFIRMED');
  m.fire('QUESTION_SENT');
  m.fire('FOLLOWUP_NEEDED');
  m.fire('FOLLOWUP_DONE');
  m.fire('FOLLOWUP_NEEDED');
  m.fire('FOLLOWUP_DONE');
  const third = m.fire('FOLLOWUP_NEEDED');
  assert.equal(third.accepted, false);
  assert.match(third.error ?? '', /上限/);
});

test('重答上限：每题最多一次；重答轮禁止追问（D5）', () => {
  const m = fresh();
  m.fire('MATERIALS_CONFIRMED');
  m.fire('QUESTION_SENT');
  m.fire('ANSWER_DONE');
  m.fire('REVIEW_DONE');
  assert.equal(m.fire('REWRITE_START').accepted, true);
  const followupInRewrite = m.fire('FOLLOWUP_NEEDED');
  assert.equal(followupInRewrite.accepted, false);
  assert.match(followupInRewrite.error ?? '', /D5|重答/);
  m.fire('REWRITE_DONE');
  m.fire('REVIEW_DONE');
  const again = m.fire('REWRITE_START');
  assert.equal(again.accepted, false, '同一题不允许第二次重答（SKIP/NEXT 之前 rewriteUsed 未复位）');
});

test('非法转移样例被拒绝（状态不匹配）', () => {
  const m = fresh();
  const cases: Array<[ReturnType<SessionMachine['fire']>['state'] | null, Parameters<SessionMachine['fire']>[0], string]> = [];
  void cases;
  assert.equal(m.fire('QUESTION_SENT').accepted, false, 'materials_review 不能直接出题（未确认材料）');
  assert.equal(m.fire('ANSWER_DONE').accepted, false);
  assert.equal(m.fire('REVIEW_DONE').accepted, false);
  m.fire('MATERIALS_CONFIRMED');
  assert.equal(m.fire('MATERIALS_CONFIRMED').accepted, false, '材料不能二次确认进入');
  assert.equal(m.fire('REVIEW_DONE').accepted, false, 'question 状态没有待完成点评');
  m.fire('QUESTION_SENT');
  assert.equal(m.fire('NEXT_QUESTION').accepted, false, 'NEXT_QUESTION 只在 rewrite 选择点有效');
  m.fire('ANSWER_DONE');
  assert.equal(m.fire('QUESTION_SENT').accepted, false, 'review 状态不能直接出题');
});

test('异常路径：麦克风拒绝、空转写、超时', () => {
  const m = fresh();
  m.fire('MATERIALS_CONFIRMED');
  m.fire('QUESTION_SENT');
  const mic = m.fire('ERROR_MIC_DENIED');
  assert.equal(mic.accepted, true);
  assert.equal(mic.actions.some((a) => a.type === 'show_mic_denied_state'), true);
  const empty = m.fire('ERROR_EMPTY_TRANSCRIPT');
  assert.equal(empty.accepted, true);
  assert.equal(empty.actions.some((a) => a.type === 'reprompt_same_question'), true);
  assert.equal(m.snapshot().followupCount, 0, '空转写不消耗追问次数');
  m.fire('ANSWER_DONE');
  const timeout = m.fire('ERROR_TIMEOUT');
  assert.equal(timeout.accepted, true);
  assert.equal(timeout.actions.some((a) => a.type === 'retry_review_once'), true);
});

test('异常路径：断线恢复到最近完整轮次', () => {
  const m = fresh();
  m.fire('MATERIALS_CONFIRMED');
  m.fire('QUESTION_SENT');
  m.fire('FOLLOWUP_NEEDED');
  const disc = m.fire('ERROR_DISCONNECT');
  assert.equal(disc.accepted, true);
  assert.equal(m.snapshot().state, 'answer');
  assert.equal(disc.actions.some((a) => a.type === 'recover_last_complete_turn'), true);
  assert.equal(disc.actions.some((a) => a.type === 'fallback_redo_current_question_if_unrecoverable'), true);
});

test('异常路径：文件解析失败留在材料阶段并允许直接粘贴', () => {
  const m = fresh();
  const r = m.fire('ERROR_PARSE_FAILURE');
  assert.equal(r.accepted, true);
  assert.equal(m.snapshot().state, 'materials_review');
  assert.equal(r.actions.some((a) => a.type === 'allow_direct_paste'), true);
});

test('提前结束：任意非终态可进报告；零完成报告（D6）', () => {
  const m0 = fresh();
  const early = m0.fire('END_SESSION');
  assert.equal(early.accepted, true);
  assert.equal(m0.snapshot().state, 'report');
  assert.equal(m0.snapshot().completed, 0);
  assert.equal(early.actions.some((a) => a.type === 'generate_report'), true);

  const m1 = fresh();
  m1.fire('MATERIALS_CONFIRMED');
  m1.fire('QUESTION_SENT');
  oneQuestionCycle(m1); // 注意：这会推进一整题
  const e2 = m1.fire('END_SESSION');
  assert.equal(e2.accepted, true);
  assert.equal(m1.fire('END_SESSION').accepted, false, 'report 状态不能再 END_SESSION');
  m1.fire('REPORT_GENERATED');
  assert.equal(m1.fire('END_SESSION').accepted, false, 'ended 是终态');
});

test('修订后重评审：作废旧点评、基准切到修订版', () => {
  const m = fresh();
  m.fire('MATERIALS_CONFIRMED');
  m.fire('QUESTION_SENT');
  const revBefore = m.fire('REVISE_AFTER_REVIEW');
  assert.equal(revBefore.accepted, false, 'answer 阶段用 TEXT_REVISED，不用重评审');
  const tr = m.fire('TEXT_REVISED');
  assert.equal(tr.accepted, true);
  assert.equal(tr.actions.some((a) => a.type === 'keep_revision_apart_from_raw'), true);
  m.fire('ANSWER_DONE');
  const rev = m.fire('REVISE_AFTER_REVIEW');
  assert.equal(rev.accepted, true);
  assert.equal(m.snapshot().state, 'review');
  assert.equal(rev.actions.some((a) => a.type === 'invalidate_previous_review'), true);
  assert.equal(rev.actions.some((a) => a.type === 'switch_basis_to_revised'), true);
});

test('转移表文档与实现一致：LEGAL_TRANSITIONS 每条可实际执行', () => {
  let checked = 0;
  for (const t of LEGAL_TRANSITIONS) {
    const m = fresh();
    // 构造到 from 状态的最短路径
    if (t.event === 'REWRITE_DONE') {
      // REWRITE_DONE 只在重答轮（rewriteUsed=true）合法
      m.fire('MATERIALS_CONFIRMED');
      m.fire('QUESTION_SENT');
      m.fire('ANSWER_DONE');
      m.fire('REVIEW_DONE');
      m.fire('REWRITE_START');
    } else
    switch (t.from) {
      case 'materials_review':
        break;
      case 'question':
        m.fire('MATERIALS_CONFIRMED');
        break;
      case 'answer':
        m.fire('MATERIALS_CONFIRMED');
        m.fire('QUESTION_SENT');
        break;
      case 'followup':
        m.fire('MATERIALS_CONFIRMED');
        m.fire('QUESTION_SENT');
        m.fire('FOLLOWUP_NEEDED');
        break;
      case 'review':
        m.fire('MATERIALS_CONFIRMED');
        m.fire('QUESTION_SENT');
        m.fire('ANSWER_DONE');
        break;
      case 'rewrite':
        m.fire('MATERIALS_CONFIRMED');
        m.fire('QUESTION_SENT');
        m.fire('ANSWER_DONE');
        m.fire('REVIEW_DONE');
        break;
      case 'report':
        m.fire('MATERIALS_CONFIRMED');
        oneQuestionCycle(m);
        oneQuestionCycle(m);
        oneQuestionCycle(m);
        break;
      default:
        continue;
    }
    assert.equal(m.snapshot().state, t.from, `前置构造应到达 ${t.from}`);
    const r = m.fire(t.event);
    assert.equal(r.accepted, true, `${t.from} --${t.event}--> 应被接受`);
    if (!t.to.endsWith('question-or-report')) {
      assert.equal(m.snapshot().state, t.to, `${t.from} --${t.event}--> ${t.to}`);
    }
    checked++;
  }
  assert.ok(checked >= 17, `转移表条目 ${checked}`);
});
