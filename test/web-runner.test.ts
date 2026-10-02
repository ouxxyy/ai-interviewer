/**
 * 编排器测试（离线）：完整四环节闭环、追问上限、重答对比、修订后重评审、空转写、
 * 提前结束的零完成报告、额度止损（halt）、麦克风拒绝、两开关下的持久化行为。
 *
 * 用 mock 实时客户端 + 脚本化文本客户端驱动，真实执行状态机与引用定位器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
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

test('完整四环节闭环：状态推进、轮次、评审过契约、引用可定位、报告过契约且优先练习点可追溯', async () => {
  const h = harness('happy', {
    transcripts: [
      '我在毕业季征稿活动里负责整体策划，联系了五个院系宣传委员，活动收到 143 篇投稿。',
      '我负责范文撰写和渠道扩散，投稿量比上一期增长约八成。',
      '重答：我负责整体策划、范文撰写和五个院系的渠道扩散，最后投稿 143 篇、增长约八成。',
      '遇到的问题是宣传委员只发了一次通知，我加了二次触达写进 SOP。',
      '我复盘活动并把二次触达写进 SOP，后续活动按这个流程执行。',
    ],
  });
  try {
    const afterMaterials = await h.runner.confirmMaterials(MATERIALS);
    assert.equal(afterMaterials.state, 'answer');
    assert.equal(afterMaterials.plan?.questions.length, 4);
    assert.equal(h.text.counts.plan, 1);
    assert.equal(afterMaterials.currentQuestion?.id, 'q1');
    assert.equal(afterMaterials.currentQuestion?.kind, 'introduction');

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
    assert.equal(snap.state, 'answer', '第3项后仍需最后一道经历题');
    assert.equal(snap.currentQuestion?.kind, 'experience');
    snap = await answerOnce(h.runner);
    snap = await h.runner.nextQuestion();
    assert.equal(snap.state, 'ended', '第4项点评后生成报告并归档');
    assert.equal(snap.report?.completedQuestions, 4);
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
    assert.equal(interviewerTurns.filter((t) => t.turnType === 'question').length, 4);
    assert.equal(userTurns.length, 5, '四项 + 一次重答 = 5 轮用户回答');
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
    transcripts: ['我负责策划与落地，写了两篇范文。', '我负责渠道扩散，联系了五个院系。', '我复盘了投稿集中在三个院系的问题。', '我把二次触达写进活动 SOP。'],
  });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await answerOnce(h.runner);
    await h.runner.nextQuestion();
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

test('网页报告不把维度字段名当作练习判断来源', async () => {
  const h = harness('report-metadata-gate', {
    text: { reportPriority: ['根据 relevance 编造百万用户故障故事'] },
    transcripts: ['我负责策划与落地，写了两篇范文。', '我负责渠道扩散，联系了五个院系。', '我复盘了投稿集中在三个院系的问题。', '我把二次触达写进活动 SOP。'],
  });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    for (let i = 0; i < 4; i++) {
      await answerOnce(h.runner);
      const snapshot = await h.runner.nextQuestion();
      if (i === 3) {
        assert.equal(snapshot.reportSource, 'derived_from_validated_feedback');
        assert.ok(snapshot.report?.priorityPractice.every((point) => !point.includes('relevance')));
      }
    }
  } finally { h.cleanup(); }
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

test('计划只有 2 题：拒绝进入流程（契约要求 4 项）', async () => {
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

test('问题计划首次结构不合规：携带契约错误自动整改重试一次后进入作答', async () => {
  const h = harness('plan-schema-retry', { text: { badPlanAttempts: 1 } });
  try {
    const snap = await h.runner.confirmMaterials(MATERIALS);
    assert.equal(h.text.counts.plan, 2, '第一次契约失败后应自动重试一次');
    assert.equal(snap.plan?.questions.length, 4);
    assert.equal(snap.state, 'answer');
    assert.equal(snap.lastError, null);
    assert.match(h.text.prompts[1] ?? '', /上一次输出未通过契约校验/);
    assert.match(h.text.prompts[1] ?? '', /topics/);
  } finally {
    h.cleanup();
  }
});

test('漏 askedTopics 后定点修复：第二次请求保留原计划，不从头生成题目', async () => {
  const h = harness('plan-missing-asked-topics');
  const complete = h.text.complete.bind(h.text);
  let original = '';
  let calls = 0;
  h.text.complete = async (req) => {
    calls++;
    if (calls === 1) {
      const result = await complete(req);
      const plan = JSON.parse(result.text);
      delete plan.askedTopics;
      original = JSON.stringify(plan);
      return { text: original };
    }
    assert.ok(req.prompt.includes(original), '修复请求必须带回待修复的完整 JSON');
    assert.match(req.prompt, /askedTopics/);
    return { text: JSON.stringify({ ...JSON.parse(original), askedTopics: [] }) };
  };
  try {
    const snap = await h.runner.confirmMaterials(MATERIALS);
    assert.equal(calls, 2);
    assert.equal(snap.state, 'answer');
    assert.deepEqual(snap.plan?.questions, JSON.parse(original).questions);
  } finally { h.cleanup(); }
});

test('来源两次不匹配：仍拒绝计划，提示具体原因，不把失败归因于用户材料', async () => {
  const h = harness('plan-source-failed', { text: { badPlanSourceAttempts: 2 } });
  try {
    await assert.rejects(() => h.runner.confirmMaterials(MATERIALS), { code: 'E_PLAN_FAILED' });
    const snap = h.runner.snapshot();
    assert.equal(h.text.counts.plan, 2);
    assert.equal(snap.plan, null);
    assert.equal(snap.turns.length, 0);
    assert.match(snap.lastError?.hint ?? '', /q1: sourceExcerpt/);
    assert.doesNotMatch(snap.lastError?.hint ?? '', /检查材料/);
  } finally { h.cleanup(); }
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
    assert.equal(snap.plan?.questions.length, 4, '计划已生成，仍可重试朗读');
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
    assert.equal(snapshot.plan?.questions.length, 4, '重试成功后计划应当就绪');
    assert.equal(snapshot.lastError, null, '恢复成功后不能继续把旧错误挂在快照上');
    assert.equal(snapshot.state, 'answer');
  } finally {
    h.cleanup();
  }
});


test('当前题点评后直接结束：介绍有效反馈计完成，四条报告与机器一致', async () => {
  const h = harness('reviewed-then-end', { transcripts: ['我做过一年半内容运营，主要负责征稿活动策划与渠道扩散。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const reviewed = await answerOnce(h.runner);
    assert.equal(reviewed.machine.completed, 1);
    const ended = await h.runner.endSession();
    assert.equal(ended.report?.completedQuestions, 1);
    assert.equal(ended.machine.completed, 1);
    assert.equal(ended.report?.totalQuestions, 4);
    assert.equal(ended.report?.perQuestion.length, 4);
    assert.equal(ended.report?.perQuestion[0]?.kind, 'introduction');
    assert.equal(ended.report?.perQuestion[0]?.status, 'reviewed');
    assert.equal(h.store.listSessions().items[0]?.introductionStatus, 'reviewed');
    assert.equal(h.store.listSessions().items[0]?.completedExperienceQuestions, 0);
  } finally { h.cleanup(); }
});

test('来源片段不可定位：计划生成携带错误重试后恢复，且只生成一次固定四项计划', async () => {
  const h = harness('plan-source-retry', { text: { badPlanSourceAttempts: 1 }, transcripts: ['我做过内容运营，负责活动策划与复盘。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    assert.equal(h.text.counts.plan, 2);
    assert.match(h.text.prompts[1] ?? '', /sourceExcerpt/);
    const plan = h.runner.snapshot().plan;
    await answerOnce(h.runner);
    await h.runner.nextQuestion();
    assert.deepEqual(h.runner.snapshot().plan, plan);
    assert.equal(h.text.counts.plan, 2, '介绍回答不能触发改写后三题');
  } finally { h.cleanup(); }
});

test('修订重评调用失败：旧评分同时从 UI、持久反馈与完成计数失效，提前结束无伪反馈', async () => {
  const h = harness('revision-fails', { transcripts: ['我负责活动策划，联系五个院系并写范文。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const first = await answerOnce(h.runner);
    const userTurnId = first.turns.find((t) => t.speaker === 'user')!.id;
    (h.text as unknown as { script: TextScript }).script.reviewError = '评审暂时不可用';
    await assert.rejects(h.runner.reviseTurn(userTurnId, '我负责联系五个院系，也承担了两篇范文的撰写。'));
    const failed = h.runner.snapshot();
    assert.equal(failed.machine.completed, 0);
    assert.equal(failed.reviews.q1, undefined);
    assert.equal(h.store.getFeedback('s-test', 'q1', 'feedback'), null);
    assert.equal(h.store.getSession('s-test')?.completedQuestions, 0);
    assert.equal(h.store.listSessions().items[0]?.introductionStatus, 'skipped');
    const ended = await h.runner.endSession();
    assert.equal(ended.report?.completedQuestions, 0);
    assert.equal(ended.report?.perQuestion[0]?.feedback, null);
    assert.equal(ended.report?.perQuestion[0]?.status, 'skipped');
  } finally { h.cleanup(); }
});

test('降级反馈保留暂无法评价；重答降级不会沿用首答成功计数或报告评分', async () => {
  const h = harness('rewrite-degraded', { transcripts: ['我负责活动策划，联系五个院系并写范文。', '重答时我补充了自己联系院系和撰写范文的动作。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await answerOnce(h.runner);
    assert.equal(h.runner.snapshot().machine.completed, 1);
    await h.runner.rewriteStart();
    (h.text as unknown as { badReviewAttempts: number }).badReviewAttempts = 5;
    const degraded = await answerOnce(h.runner);
    assert.equal(degraded.state, 'rewrite');
    assert.equal(degraded.reviewMeta.at(-1)?.kind, 'degraded');
    assert.equal(degraded.machine.completed, 0);
    assert.match(degraded.reviews.q1!.topImprovement, /暂无法评价/);
    const ended = await h.runner.endSession();
    assert.equal(ended.machine.completed, ended.report?.completedQuestions);
    assert.equal(ended.report?.completedQuestions, 0);
    assert.equal(ended.report?.perQuestion[0]?.feedback, null);
    assert.equal(ended.report?.perQuestion[0]?.rewriteDelta, null);
  } finally { h.cleanup(); }
});

test('新环节的追问与评审均传岗位题型语境；先前题的回答不可被当前题修订', async () => {
  const h = harness('context', { transcripts: ['我做过一年半内容运营，负责活动策划。', '我负责联系院系，活动按期举行。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const intro = await answerOnce(h.runner);
    const oldTurn = intro.turns.find((t) => t.speaker === 'user')!.id;
    await h.runner.nextQuestion();
    await answerOnce(h.runner);
    await assert.rejects(h.runner.reviseTurn(oldTurn, '不允许在当前题修改上一题'), (e: Error & { code?: string }) => e.code === 'E_STATE');
    const prompts = h.text.prompts.filter((p) => p.includes('追问判定器') || p.includes('独立文本评审器'));
    assert.equal(prompts.length, 4);
    assert.ok(prompts.every((p) => p.includes(MATERIALS.jd) && p.includes(MATERIALS.targetRole)), '每次都携带岗位语境');
    assert.ok(prompts.slice(0, 2).every((p) => p.includes('introduction')), '介绍环节传入 introduction');
    assert.ok(prompts.slice(2).every((p) => p.includes('experience')), '经历环节传入 experience');
  } finally { h.cleanup(); }
});


test('重答评审调用失败：历史完成数和报告不能留下首答旧评分', async () => {
  const h = harness('rewrite-fails', { transcripts: ['我负责活动策划，联系五个院系并写范文。', '我重新说明自己的渠道扩散和策划动作。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await answerOnce(h.runner);
    await h.runner.rewriteStart();
    (h.text as unknown as { script: TextScript }).script.reviewError = '重答评审暂时不可用';
    await assert.rejects(answerOnce(h.runner));
    assert.equal(h.runner.snapshot().machine.completed, 0);
    assert.equal(h.runner.snapshot().reviews.q1, undefined);
    assert.equal(h.store.getSession('s-test')?.completedQuestions, 0);
    assert.equal(h.store.getFeedback('s-test', 'q1', 'feedback'), null);
    const ended = await h.runner.endSession();
    assert.equal(ended.report?.completedQuestions, 0);
    assert.equal(ended.report?.perQuestion[0]?.feedback, null);
  } finally { h.cleanup(); }
});

test('最后一项点评后立刻结束：四份反馈完成计数一致', async () => {
  const h = harness('last-review-end', { transcripts: Array.from({ length: 4 }, () => '我负责活动策划，联系五个院系并写范文。') });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    for (let i = 0; i < 4; i++) {
      const reviewed = await answerOnce(h.runner);
      assert.equal(reviewed.machine.completed, i + 1);
      if (i < 3) await h.runner.nextQuestion();
    }
    const ended = await h.runner.endSession();
    assert.equal(ended.report?.completedQuestions, 4);
    assert.equal(ended.report?.sessionStatus, 'completed');
    assert.equal(ended.machine.completed, 4);
    assert.equal(h.store.listSessions().items[0]?.completedExperienceQuestions, 3);
  } finally { h.cleanup(); }
});


test('暂停恢复重复开始同一未提交回答：A+B完整落盘与回放、时间和轮次不重置', async () => {
  const transcript = '暂停前我负责策划，暂停后我负责渠道沟通。';
  const h = harness('pause-start-audio', { transcripts: [transcript] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const started = await h.runner.answerStart();
    const firstStartDone = new Date().toISOString();
    const client = MockRealtimeClient.instances.at(-1)!;
    const prefix = Buffer.alloc(3200, 1);
    const suffix = Buffer.alloc(3200, 2);
    h.runner.appendAudio(prefix);
    h.runner.pause();
    assert.throws(() => h.runner.appendAudio(Buffer.alloc(3200, 9)), /已暂停/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.runner.resume();
    const resumed = await h.runner.answerStart();
    assert.deepEqual(resumed.machine, started.machine, '重复开始不得新增轮次或追问');
    assert.deepEqual(resumed.turns, started.turns);
    h.runner.appendAudio(suffix);
    const snap = await h.runner.answerDone();
    const users = snap.turns.filter((turn) => turn.speaker === 'user');
    assert.equal(users.length, 1);
    const turn = users[0]!;
    assert.equal(turn.rawTranscript, transcript);
    assert.equal(snap.usage.inputAudioBytes, 6400);
    assert.equal(client.appendedBytes, 6400, '上游缓冲接收到同样的A+B');
    assert.equal(client.commitCount, 1, '整个回答只提交一轮');
    const saved = readFileSync(path.join(h.dir, turn.audioFile!));
    assert.equal(saved.length - 44, 6400, 'WAV必须保留暂停前后全部6400字节');
    assert.equal(Buffer.compare(saved.subarray(44), Buffer.concat([prefix, suffix])), 0, 'WAV字节顺序必须为A+B');
    const playback = h.store.readAudio('s-test', turn.id, 'user');
    assert.equal(playback.ok, true);
    if (playback.ok) assert.deepEqual(playback.wav, saved, '回放与已收到上行音频一致');
    assert.ok(turn.startedAt <= firstStartDone, '沿用第一次开始时间');
  } finally {
    h.cleanup();
  }
});

test('新回答边界：追问、重答、下一题的WAV各自独立，不串入上一轮音频', async () => {
  const h = harness('audio-boundaries', {
    text: { followups: [{ need: true, question: '你个人具体负责什么？' }] },
    transcripts: ['我负责策划活动。', '我负责联系五个院系。', '我重答说明个人的策划和渠道动作。', '下一题我讲活动复盘。'],
  });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await answerOnce(h.runner, Buffer.alloc(3200, 1));
    await answerOnce(h.runner, Buffer.alloc(3200, 2));
    await h.runner.rewriteStart();
    await answerOnce(h.runner, Buffer.alloc(3200, 3));
    await h.runner.nextQuestion();
    const snap = await answerOnce(h.runner, Buffer.alloc(3200, 4));
    const users = snap.turns.filter((turn) => turn.speaker === 'user');
    assert.deepEqual(users.map((turn) => [turn.questionId, turn.turnType]), [['q1', 'answer'], ['q1', 'followup'], ['q1', 'rewrite'], ['q2', 'answer']]);
    for (const [i, turn] of users.entries()) {
      const wav = readFileSync(path.join(h.dir, turn.audioFile!));
      assert.deepEqual(wav.subarray(44), Buffer.alloc(3200, i + 1));
    }
    assert.equal(snap.usage.inputAudioBytes, 12800);
  } finally {
    h.cleanup();
  }
});

test('空转写后的重试属于新回答：不保存或拼接已提交失败音频', async () => {
  const h = harness('empty-audio-retry', { transcripts: ['', '重试时我负责联系五个院系。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const empty = await answerOnce(h.runner, Buffer.alloc(3200, 1));
    assert.equal(empty.lastError?.code, 'E_EMPTY_TRANSCRIPT');
    assert.equal(empty.turns.filter((turn) => turn.speaker === 'user').length, 0);
    assert.equal(h.store.listAudioFiles('s-test').filter((file) => file.path.includes('user')).length, 0);
    const snap = await answerOnce(h.runner, Buffer.alloc(3200, 2));
    const turn = snap.turns.find((turn) => turn.speaker === 'user')!;
    assert.deepEqual(readFileSync(path.join(h.dir, turn.audioFile!)).subarray(44), Buffer.alloc(3200, 2));
    assert.equal(snap.usage.inputAudioBytes, 6400);
  } finally {
    h.cleanup();
  }
});

test('提交转写失败后重试属于新回答，不拼接上次失败音频', async () => {
  const h = harness('asr-error-audio-retry', { transcripts: ['恢复后我负责联系五个院系。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const client = MockRealtimeClient.instances.at(-1)!;
    const commit = client.commitAudio.bind(client);
    client.commitAudio = () => { throw new Error('转写超时'); };
    await assert.rejects(() => answerOnce(h.runner, Buffer.alloc(3200, 1)), /超时/);
    assert.equal(h.runner.snapshot().turns.filter((turn) => turn.speaker === 'user').length, 0);
    client.commitAudio = commit;
    const snap = await answerOnce(h.runner, Buffer.alloc(3200, 2));
    const turn = snap.turns.find((turn) => turn.speaker === 'user')!;
    const pcm = readFileSync(path.join(h.dir, turn.audioFile!)).subarray(44);
    assert.equal(pcm.length, 3200, '新回答不包含已失败的提交');
    assert.equal(Buffer.compare(pcm, Buffer.alloc(3200, 2)), 0);
  } finally { h.cleanup(); }
});

test('来源编号计划首次即进入作答，持久化的来源逐字来自已确认材料', async () => {
  const h = harness('plan-source-ids');
  const originalComplete = h.text.complete.bind(h.text);
  h.text.complete = async req => {
    const result = await originalComplete(req);
    const raw = JSON.parse(result.text);
    raw.questions = raw.questions.map(({ sourceExcerpt: _excerpt, ...q }: Record<string, unknown>, i: number) => ({ ...q, sourceId: i % 2 ? 'experience:1' : 'jd:1' }));
    return { ...result, text: JSON.stringify(raw) };
  };
  try {
    const snap = await h.runner.confirmMaterials(MATERIALS);
    assert.equal(snap.state, 'answer');
    assert.equal(h.text.counts.plan, 1);
    assert.equal(snap.lastError, null);
    assert.equal(validateContract('question-plan', snap.plan).ok, true);
    for (const question of snap.plan!.questions) {
      assert.ok(MATERIALS.jd.includes(question.sourceExcerpt) || MATERIALS.experience.includes(question.sourceExcerpt));
      assert.equal('sourceId' in question, false);
    }
    assert.deepEqual(h.store.getSession('s-test')?.plan, snap.plan);
  } finally { h.cleanup(); }
});

test('未知编号耗尽两次后，同场手动重试可恢复，错误状态清除且不丢材料', async () => {
  const h = harness('plan-source-recovery', { text: { planSourceIds: true } });
  const complete = h.text.complete.bind(h.text);
  let invalid = true;
  h.text.complete = async req => {
    const response = await complete(req);
    const raw = JSON.parse(response.text);
    if (invalid) raw.questions[1].sourceId = 'experience:999';
    return { ...response, text: JSON.stringify(raw) };
  };
  try {
    await assert.rejects(h.runner.confirmMaterials(MATERIALS), { code: 'E_PLAN_FAILED' });
    assert.equal(h.text.counts.plan, 2);
    assert.equal(h.runner.snapshot().plan, null);
    assert.match(h.runner.snapshot().lastError?.hint ?? '', /编号/);
    await assert.rejects(h.runner.retryPlan(), { code: 'E_PLAN_FAILED' });
    assert.equal(h.text.counts.plan, 4);
    assert.match(h.runner.snapshot().lastError?.hint ?? '', /编号/);
    invalid = false;
    const snap = await h.runner.retryPlan();
    assert.equal(h.text.counts.plan, 5);
    assert.equal(snap.state, 'answer');
    assert.equal(snap.lastError, null);
    assert.equal(snap.materials?.experience, MATERIALS.experience);
    assert.equal(snap.plan?.questions.length, 4);
  } finally { h.cleanup(); }
});


test('评审失败可用原回答重试：保存逐次诊断、不重录、不消耗重答、成功只计一次', async () => {
  const h = harness('retry-review', { text: { badReviewAttempts: 2 }, transcripts: ['我负责征稿活动的问卷设计、渠道协调和范文撰写。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    const failed = await answerOnce(h.runner);
    assert.equal(failed.reviewMeta.at(-1)?.kind, 'degraded');
    assert.equal(failed.machine.completed, 0);
    assert.equal((failed.reviewMeta.at(-1) as any).attemptLog?.length, 2);
    const beforeTurns = JSON.stringify(failed.turns);
    const recovered = await (h.runner as any).retryReview();
    assert.equal(recovered.reviewMeta.at(-1)?.kind, 'ok');
    assert.equal(JSON.stringify(recovered.turns), beforeTurns);
    assert.equal(recovered.machine.rewriteUsed, false);
    assert.equal(recovered.machine.completed, 1);
    assert.equal(h.text.counts.review, 3);
    assert.equal((h.store.getSession('s-test')?.reviewMeta[0] as any).attemptLog.length, 2);
    await assert.rejects(() => (h.runner as any).retryReview(), /有效点评/);
    assert.equal(h.text.counts.review, 3);
  } finally { h.cleanup(); }
});

test('评审重试拒绝并发请求，避免双重模型调用', async () => {
  const h = harness('retry-single-flight', { text: { badReviewAttempts: 2 }, transcripts: ['我负责调研用户需求并协调渠道。'] });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await answerOnce(h.runner);
    const complete = h.text.complete.bind(h.text);
    h.text.complete = async req => { await barrier; return complete(req); };
    const retry = h.runner.retryReview();
    await assert.rejects(() => h.runner.retryReview(), /评审正在进行/);
    release();
    const recovered = await retry;
    assert.equal(recovered.machine.completed, 1);
    assert.equal(h.text.counts.review, 3);
  } finally { release(); h.cleanup(); }
});

test('重答评审请求失败后重试，只评重答版本且不增加重答次数', async () => {
  const script: TextScript = {};
  const h = harness('retry-rewrite', { text: script, transcripts: ['初答：我负责活动策划。', '重答：我负责问卷设计、渠道沟通与投稿统计。'] });
  try {
    await h.runner.confirmMaterials(MATERIALS);
    await answerOnce(h.runner);
    await h.runner.rewriteStart();
    script.reviewError = 'upstream timeout';
    await assert.rejects(() => answerOnce(h.runner));
    const failed = h.runner.snapshot();
    assert.equal(failed.state, 'review');
    assert.equal(failed.machine.completed, 0);
    delete script.reviewError;
    const recovered = await h.runner.retryReview();
    assert.equal(recovered.machine.completed, 1);
    assert.equal(recovered.machine.rewriteUsed, true);
    assert.deepEqual(recovered.turns, failed.turns);
    assert.match(recovered.reviewBasis.q1!.text, /^重答：/);
    assert.equal(recovered.reviewBasis.q1!.turnIds.length, 1);
    assert.equal(h.text.counts.rewrite_delta, 1);
  } finally { h.cleanup(); }
});
