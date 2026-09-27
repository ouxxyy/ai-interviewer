/**
 * 编排器测试（离线）：完整三题闭环、追问上限、重答对比、修订后重评审、空转写、
 * 提前结束的零完成报告、额度止损（halt）、麦克风拒绝、两开关下的持久化行为。
 *
 * 用 mock 实时客户端 + 脚本化文本客户端驱动，真实执行状态机与引用定位器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { InterviewDb } from '../src/web/db.js';
import { Store } from '../src/web/store.js';
import { webPaths, REPO_ROOT } from '../src/web/paths.js';
import { InterviewRunner } from '../src/web/runner.js';
import { RealtimeBridge } from '../src/web/realtime-bridge.js';
import { Logger } from '../src/web/log.js';
import { validateContract } from '../src/contracts/validate.js';
import { locateQuote } from '../src/contracts/quote-locator.js';
import { DEMO_MATERIALS } from '../src/web/materials.js';
import type { Feedback } from '../src/contracts/types.js';
import { MockRealtimeClient, ScriptedTextClient, type MockRealtimeScript, type TextScript } from './helpers/web-mocks.js';

interface Harness {
  runner: InterviewRunner;
  store: Store;
  text: ScriptedTextClient;
  dir: string;
  cleanup(): void;
}

function harness(label: string, opts: { realtime?: MockRealtimeScript; text?: TextScript; saveHistory?: boolean; saveAudio?: boolean; transcripts?: string[] } = {}): Harness {
  const dir = path.join(REPO_ROOT, 'data', `web-test-run-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  const db = new InterviewDb(path.join(dir, 'x.sqlite'));
  db.migrate();
  const store = new Store(db, webPaths(dir));
  const text = new ScriptedTextClient(opts.text ?? {});
  const logger = new Logger(() => {}, 'error');
  const realtimeScript: MockRealtimeScript = { ...(opts.realtime ?? {}), ...(opts.transcripts === undefined ? {} : { transcripts: [...opts.transcripts] }) };
  const runner = new InterviewRunner({
    store,
    textClient: text,
    logger,
    credential: 'test-key-not-real',
    sessionId: 's-test',
    synthetic: true,
    saveHistory: opts.saveHistory ?? true,
    saveAudio: opts.saveAudio ?? true,
    createBridge: () =>
      new RealtimeBridge({
        credential: 'test-key-not-real',
        logger,
        createClient: () => new MockRealtimeClient(realtimeScript),
      }),
  });
  return {
    runner,
    store,
    text,
    dir,
    cleanup: () => {
      runner.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MATERIALS = { jd: DEMO_MATERIALS.jd, experience: DEMO_MATERIALS.experience, stage: DEMO_MATERIALS.stage, targetRole: DEMO_MATERIALS.targetRole };
const PCM = Buffer.alloc(3200, 3);

/** 完整答一题（开始→推流→回答完毕）。 */
async function answerOnce(runner: InterviewRunner, pcm = PCM) {
  await runner.answerStart();
  runner.appendAudio(pcm);
  return runner.answerDone();
}

test('完整三题闭环：状态推进、轮次、评审过契约、引用可定位、报告过契约且优先练习点可追溯', async () => {
  const h = harness('happy', {
    transcripts: [
      '我在毕业季征稿活动里负责整体策划，联系了五个院系宣传委员，活动收到 143 篇投稿。',
      '我负责范文撰写和渠道扩散，投稿量比上一期增长约八成。',
      '重答：我负责整体策划、范文撰写和五个院系的渠道扩散，最后投稿 143 篇、增长约八成。',
      '遇到的问题是宣传委员只发了一次通知，我加了二次触达写进 SOP。',
    ],
  });
  try {
    const afterMaterials = await h.runner.confirmMaterials(MATERIALS);
    assert.equal(afterMaterials.state, 'answer');
    assert.equal(afterMaterials.plan?.questions.length, 3);
    assert.equal(h.text.counts.plan, 1);
    assert.equal(afterMaterials.currentQuestion?.id, 'q1');

    // 第 1 题
    let snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'rewrite');
    const fb1 = snap.reviews.q1 as Feedback;
    assert.equal(validateContract('feedback', fb1).ok, true);
    assert.equal(snap.reviewMeta[0]?.quotesLocated, snap.reviewMeta[0]?.quotesTotal);
    assert.equal(snap.reviewMeta[0]?.firstAttemptOk, true);
    // 三档维度的引用必须真的能定位（独立复算，不信流水线计数）
    for (const d of Object.values(fb1.dimensions)) {
      if (d.level === '无法判断') continue;
      const loc = locateQuote(snap.turns.filter((t) => t.speaker === 'user' && t.questionId === 'q1').map((t) => t.rawTranscript).join('\n'), d.quote!.text);
      assert.equal(loc.located, true, `${d.level} 的引用应可定位`);
    }

    // 第 2 题（带一次重答）
    snap = await h.runner.nextQuestion();
    assert.equal(snap.state, 'answer');
    snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'rewrite');
    snap = await h.runner.rewriteStart();
    assert.equal(snap.state, 'answer');
    assert.equal(snap.machine.rewriteUsed, true);
    snap = await answerOnce(h.runner, Buffer.alloc(3200, 9));
    assert.equal(snap.state, 'rewrite');
    assert.equal(h.text.counts.rewrite_delta, 1);
    assert.ok(snap.rewriteDeltas.q2, '重答应产出对比结果');
    assert.deepEqual(snap.rewriteDeltas.q2?.added, ['补充了个人分工']);

    // 第 3 题：点评后仍停在重答选择点，选「下一题」才进报告（第 3 题没有下一题）
    snap = await h.runner.nextQuestion();
    assert.equal(snap.state, 'answer');
    snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'rewrite');
    snap = await h.runner.nextQuestion();
    assert.equal(snap.state, 'ended', '第 3 题点评后直接生成报告并归档');
    assert.equal(snap.report?.completedQuestions, 3);
    assert.equal(snap.report?.sessionStatus, 'completed');
    assert.equal(validateContract('session-report', snap.report).ok, true);
    assert.equal(snap.report?.perQuestion.every((p) => p.status === 'reviewed'), true);
    assert.equal(snap.reportSource, 'model_priority_practice');
    // 每一题的 feedback 都是已校验对象（不是模型重写的）
    for (const p of snap.report!.perQuestion) {
      assert.equal(validateContract('feedback', p.feedback).ok, true);
    }
    // 轮次结构：每题 1 个面试官问题 + 至少 1 个用户回答
    const userTurns = snap.turns.filter((t) => t.speaker === 'user');
    const interviewerTurns = snap.turns.filter((t) => t.speaker === 'interviewer');
    assert.equal(interviewerTurns.filter((t) => t.turnType === 'question').length, 3);
    assert.equal(userTurns.length, 4, '三题 + 一次重答 = 4 轮用户回答');
  } finally {
    h.cleanup();
  }
});

test('追问：最多 2 次，追问轮的回答计入同一题的评审基准', async () => {
  const h = harness('followup', {
    text: { followups: [{ need: true, question: '你说的分工，具体是怎么安排的？' }, { need: true, question: '结果数据是怎么统计的？' }, { need: true }] },
    transcripts: ['我先做了问卷调研。', '我联系了五个院系的宣传委员。', '活动两周收到 143 篇投稿。'],
  });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    let snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'followup');
    assert.equal(snap.machine.followupCount, 1);
    snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'followup');
    assert.equal(snap.machine.followupCount, 2);
    // 第三次回答后已到上限，必须直接进入评审
    snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'rewrite');
    assert.equal(snap.machine.followupCount, 2);
    const fb = snap.reviews.q1 as Feedback;
    assert.equal(fb.reviewBasis.turnIds.length, 3, '三次回答都应计入评审基准');
    assert.equal(validateContract('feedback', fb).ok, true);
  } finally {
    h.cleanup();
  }
});

test('重答轮 0 追问（D5）：重答回答完直接进对比评审', async () => {
  const h = harness('rewrite-nofollow', {
    text: { followups: [{ need: true, question: '补充一下分工？' }] },
    transcripts: ['初答内容，只说了活动整体情况。', '追问：我负责联系院系和写范文。', '重答：我负责整体策划、联系五个院系并撰写范文，投稿 143 篇。'],
  });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    let snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'followup');
    snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'rewrite');
    snap = await h.runner.rewriteStart();
    assert.equal(snap.state, 'answer');
    const followupCallsBefore = h.text.counts.followup ?? 0;
    snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'rewrite', '重答后直接进入评审，不追问');
    assert.equal(h.text.counts.followup ?? 0, followupCallsBefore, '重答轮不应调用追问判定');
    const fb = snap.reviews.q1 as Feedback;
    assert.equal(fb.reviewBasis.turnIds.length, 1, '重答的评审基准只含重答轮');
  } finally {
    h.cleanup();
  }
});

test('空转写：停在回答状态、给出明确错误、不产生轮次也不评审', async () => {
  const h = harness('empty', { transcripts: [''] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await h.runner.answerStart();
    h.runner.appendAudio(PCM);
    const snap = await h.runner.answerDone();
    assert.equal(snap.state, 'answer');
    assert.equal(snap.lastError?.code, 'E_EMPTY_TRANSCRIPT');
    assert.equal(snap.turns.filter((t) => t.speaker === 'user').length, 0);
    assert.equal(Object.keys(snap.reviews).length, 0);
  } finally {
    h.cleanup();
  }
});

test('提前结束：零完成也出报告，优先练习点固定为「无有效反馈」', async () => {
  const h = harness('early');
  try {
    const snap = await h.runner.endSession();
    assert.equal(snap.state, 'ended');
    assert.equal(snap.report?.completedQuestions, 0);
    assert.equal(snap.report?.sessionStatus, 'ended_early');
    assert.deepEqual(snap.report?.priorityPractice, ['本次未完成任何题目，无有效反馈']);
    assert.equal(snap.reportSource, 'fixed_zero_completion');
    assert.equal(validateContract('session-report', snap.report).ok, true);
    assert.equal(h.text.counts.report ?? 0, 0, '零完成不该调用报告模型');
  } finally {
    h.cleanup();
  }
});

test('报告结论来源校验：模型写了无法追溯到反馈的结论时，回退到派生来源且不编造', async () => {
  const h = harness('report-gate', {
    text: { reportPriority: ['建议你多练习微笑和眼神交流'] },
    transcripts: ['我负责策划与落地，写了两篇范文。', '我负责渠道扩散，联系了五个院系。', '我复盘了投稿集中在三个院系的问题。'],
  });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await answerOnce(h.runner);
    await h.runner.nextQuestion();
    await answerOnce(h.runner);
    await h.runner.nextQuestion();
    await answerOnce(h.runner);
    const snap = await h.runner.nextQuestion();
    assert.equal(snap.reportSource, 'derived_from_validated_feedback');
    assert.equal(snap.report?.priorityPractice.includes('建议你多练习微笑和眼神交流'), false);
    assert.equal(validateContract('session-report', snap.report).ok, true);
  } finally {
    h.cleanup();
  }
});

test('评审重试口径：第一次坏 JSON，第二次通过 —— firstAttemptOk=false、attempts=2', async () => {
  const h = harness('retry', { text: { badReviewAttempts: 1 }, transcripts: ['我负责策划与落地。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const snap = await answerOnce(h.runner);
    assert.equal(snap.reviewMeta[0]?.attempts, 2);
    assert.equal(snap.reviewMeta[0]?.firstAttemptOk, false);
    assert.equal(snap.reviewMeta[0]?.kind, 'ok');
    assert.equal(validateContract('feedback', snap.reviews.q1).ok, true);
  } finally {
    h.cleanup();
  }
});

test('修订后重评审（D11）：评审基准切到修订版，区间在修订文本上重新定位', async () => {
  const h = harness('revise', { transcripts: ['我负责策划，然后联系院系，最后做复盘。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    let snap = await answerOnce(h.runner);
    assert.equal(snap.state, 'rewrite');
    const userTurnId = snap.turns.find((t) => t.speaker === 'user')!.id;
    snap = await h.runner.reviseTurn(userTurnId, '我负责整体策划与落地，联系了五个院系的宣传委员，活动收到 143 篇投稿，比上一期增长约八成。');
    assert.equal(snap.state, 'rewrite', '评审后修订会重新评审并回到重答选择点');
    const fb = snap.reviews.q1 as Feedback;
    assert.equal(fb.reviewBasis.textVersion, 'revised');
    const revised = snap.turns.find((t) => t.id === userTurnId)!.revisedText!;
    for (const d of Object.values(fb.dimensions)) {
      if (d.level === '无法判断') continue;
      assert.equal(locateQuote(revised, d.quote!.text).located, true);
    }
    assert.equal(validateContract('feedback', fb).ok, true);
  } finally {
    h.cleanup();
  }
});

test('额度不足（1310）：立刻 halt，不再发起模型调用', async () => {
  const h = harness('quota', { text: { planError: 'DashScope HTTP 429（model=qwen3.8-flash）：{"code":"1310","message":"您已达到每周/每月使用上限"}' } });
  try {
    await assert.rejects(() => h.runner.confirmMaterials(MATERIALS), (e: Error & { code?: string; halt?: boolean }) => e.code === 'E_QUOTA' && e.halt === true);
    assert.equal(h.runner.snapshot().halted, true);
    const callsAfterHalt = h.text.prompts.length;
    await assert.rejects(() => h.runner.confirmMaterials(MATERIALS), (e: Error & { code?: string }) => e.code === 'E_QUOTA');
    assert.equal(h.text.prompts.length, callsAfterHalt, 'halt 之后不允许再调用模型');
  } finally {
    h.cleanup();
  }
});

test('麦克风被拒绝：落到明确状态，仍可结束且不产生伪报告', async () => {
  const h = harness('mic');
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const denied = h.runner.micDenied('NotAllowedError');
    assert.equal(denied.lastError?.code, 'E_MIC_DENIED');
    assert.equal(denied.state, 'answer');
    const ended = await h.runner.endSession();
    assert.equal(ended.report?.completedQuestions, 0);
    assert.deepEqual(ended.report?.priorityPractice, ['本次未完成任何题目，无有效反馈']);
  } finally {
    h.cleanup();
  }
});

test('计划只有 2 题：拒绝进入流程（契约要求 3 题）', async () => {
  const h = harness('plan2', { text: { planQuestionCount: 2 } });
  try {
    await assert.rejects(() => h.runner.confirmMaterials(MATERIALS), (e: Error & { code?: string }) => e.code === 'E_PLAN_FAILED');
    const snap = h.runner.snapshot();
    assert.equal(snap.plan, null);
    assert.equal(snap.lastError?.code, 'E_PLAN_FAILED');
  } finally {
    h.cleanup();
  }
});

test('关「保存历史」：整场跑完库里零条记录、无音频文件；关「保存录音」：记录在、无音频文件', async () => {
  const off = harness('toggle-off', { saveHistory: false, saveAudio: true, transcripts: ['我负责策划与落地，收到 143 篇投稿。'] });
  try {
    await off.runner.confirmMaterials(MATERIALS);
    await answerOnce(off.runner);
    assert.equal(off.store.listSessions().total, 0);
    assert.equal(off.store.listSessions({ includeSynthetic: false }).total, 0);
    const snap = off.runner.snapshot();
    const userTurn = snap.turns.find((t) => t.speaker === 'user')!;
    assert.equal(userTurn.audioFile, null);
    assert.equal(off.runner.hasAudio(userTurn.id, 'user'), true, '关保存时本场仍应有内存音频可回放');
    assert.equal(off.store.getSession('s-test')?.persisted, false);
  } finally {
    off.cleanup();
  }
  const noAudio = harness('toggle-noaudio', { saveAudio: false, transcripts: ['我负责策划与落地，收到 143 篇投稿。'] });
  try {
    await noAudio.runner.confirmMaterials(MATERIALS);
    await answerOnce(noAudio.runner);
    assert.equal(noAudio.store.listSessions().total, 1);
    assert.equal(noAudio.store.listAudioFiles('s-test').length, 0);
    const userTurn = noAudio.runner.snapshot().turns.find((t) => t.speaker === 'user')!;
    assert.equal(userTurn.audioFile, null);
    assert.equal(noAudio.runner.hasAudio(userTurn.id, 'user'), true);
  } finally {
    noAudio.cleanup();
  }
});

test('实时连接失败（音色断言连续两次不过）：给出明确错误并落到断线状态，不产生问题轮次', async () => {
  const h = harness('voicefail', { realtime: { openFailures: 5 } });
  try {
    await assert.rejects(() => h.runner.confirmMaterials(MATERIALS), (e: Error & { code?: string }) => e.code === 'E_REALTIME' || e.code === 'E_OFFLINE' || e.code === 'E_UPSTREAM');
    const snap = h.runner.snapshot();
    assert.equal(snap.lastError?.code === 'E_REALTIME' || snap.lastError?.code === 'E_UPSTREAM' || snap.lastError?.code === 'E_OFFLINE', true);
    assert.equal(snap.turns.length, 0);
    assert.equal(snap.plan?.questions.length, 3, '计划已生成，仍可重试朗读');
  } finally {
    h.cleanup();
  }
});

test('P1-2 恢复：出题失败后重试成功，快照里的 lastError 必须被清掉', async () => {
  const h = harness('retry-plan', { text: { planError: '出题失败（注入）' } });
  try {
    await h.runner.confirmMaterials(MATERIALS).catch(() => undefined);
    assert.equal(h.runner.snapshot().plan, null, '出题失败时计划应当为空');
    assert.notEqual(h.runner.snapshot().lastError, null, '失败要如实记录 lastError');

    // 模拟「服务端已恢复」：清掉注入的失败，再按真实阶段重试出题。
    (h.text as unknown as { script: { planError?: string } }).script.planError = undefined;
    await h.runner.retryPlan();

    const snapshot = h.runner.snapshot();
    assert.equal(snapshot.plan?.questions.length, 3, '重试成功后计划应当就绪');
    assert.equal(snapshot.lastError, null, '恢复成功后不能继续把旧错误挂在快照上');
    assert.equal(snapshot.state, 'answer');
  } finally {
    h.cleanup();
  }
});
