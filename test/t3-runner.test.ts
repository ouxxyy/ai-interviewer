import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DashscopeTextClient } from '../src/clients/dashscope.js';
import { EvidenceWriter } from '../src/t1r/evidence.js';
import { runPromptFlow, runSkillFlow } from '../src/t3/run.js';
import { validateContractAuto } from '../src/contracts/validate.js';
import { DIMENSIONS } from '../src/rules/rules.js';
import { PROMPT_VERSION } from '../src/prompts/prompts.js';

function mockClient(opts: { invalidPlan?: boolean; degrade?: string; followups?: boolean; unrelatedPriority?: boolean; metadataPriority?: boolean } = {}): DashscopeTextClient {
  return {
    model: 'offline-fixture',
    async complete({ prompt }: { prompt: string }) {
      let obj: unknown;
      if (prompt.includes('【出题规则】')) {
        obj = { contractVersion: '0.3.0', questions: ['请围绕岗位介绍自己', '请讲一次岗位相关经历', '请讲一次个人动作分工', '请讲一次困难权衡判断'].map((text, i) => ({ id: `q${i + 1}`, kind: i ? 'experience' : 'introduction', text, sourceExcerpt: opts.invalidPlan ? '材料不存在的来源' : '负责工具类产品的付费转化增长', intent: '验证真实动作与结果边界', topics: [text] })), askedTopics: [] };
      } else if (prompt.includes('追问判定器')) { const need = opts.followups === true; obj = { need, question: need ? '请补充这个动作的口径？' : null, reason: need ? '动作边界尚未明确' : '无额外追问', gap: need ? '动作口径' : '无' }; }
      else if (prompt.includes('报告生成器')) obj = { priorityPractice: [opts.metadataPriority ? '根据 textVersion 编造百万用户故障故事' : opts.unrelatedPriority ? '编造十倍增长的商业成果' : '说清本人承担的动作'] };
      else {
        const id = /【当前问题】(q[1-4])/.exec(prompt)?.[1] ?? 'q1';
        const turnId = /【评审对象轮次】([^\n]+)/.exec(prompt)?.[1] ?? 't1';
        obj = opts.degrade === id ? { invalid: true } : { contractVersion: '0.3.0', questionId: id, reviewBasis: { turnIds: [turnId], textVersion: 'raw' }, dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d.key, { level: '无法判断', quote: null, reason: '当前回答不足以判断' }])), factGaps: ['需要说清本人承担的动作'], topImprovement: '说清本人承担的动作', nextFacts: ['补充本人承担的动作'], reviewVersion: PROMPT_VERSION };
      }
      return { text: JSON.stringify(obj), model: 'offline-fixture', latencyMs: 0, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  } as unknown as DashscopeTextClient;
}

async function withWriter(run: (writer: EvidenceWriter) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 't3-v03-fixture-'));
  try { await run(new EvidenceWriter(path.join(tmp, 'evidence'), path.join(tmp, 'data'))); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
}

test('Skill 默认跑四项，结束标志/反馈所属题/重答轮次与报告均来自正式结果', async () => {
  await withWriter(async (writer) => {
    const r = await runSkillFlow(mockClient(), writer);
    assert.equal(r.questions.length, 4);
    assert.equal(r.endedEarly, false);
    assert.deepEqual(r.questions.map((q) => q.feedback.questionId), ['q1', 'q2', 'q3', 'q4']);
    assert.equal(validateContractAuto('session-report', r.report.raw).ok, true);
    const report = r.report.raw as { completedQuestions: number; perQuestion: Array<{ kind: string; feedback: { reviewBasis: { turnIds: string[] } } }> };
    assert.equal(report.completedQuestions, 4);
    assert.deepEqual(report.perQuestion.map((q) => q.kind), ['introduction', 'experience', 'experience', 'experience']);
    const turnIds = report.perQuestion.flatMap((q) => q.feedback.reviewBasis.turnIds);
    assert.equal(new Set(turnIds).size, turnIds.length);
    assert.match(r.report.markdown, /介绍状态/);
    assert.match(r.report.markdown, /经历题.*3\/3/);
  });
});

test('Skill 拒绝无法从材料定位的计划来源，不调用评审', async () => {
  await withWriter(async (writer) => { await assert.rejects(runSkillFlow(mockClient({ invalidPlan: true }), writer), /来源|sourceExcerpt|计划/); });
});

test('Skill 提前结束只完成前两项；降级不能记正式完成', async () => {
  await withWriter(async (writer) => {
    const r = await runSkillFlow(mockClient({ degrade: 'q2' }), writer, { endEarly: true });
    assert.equal(r.endedEarly, true);
    const report = r.report.raw as { completedQuestions: number; perQuestion: Array<{ status: string; feedback: unknown }> };
    assert.equal(report.completedQuestions, 1);
    assert.equal(report.perQuestion[1]!.feedback, null);
    assert.equal(report.perQuestion[1]!.status, 'skipped');
    assert.equal(validateContractAuto('session-report', report).ok, true);
  });
});


function mockChat(opts: { invalidQuote?: boolean; proseFeedback?: boolean; unrelatedPriority?: boolean; metadataPriority?: boolean; legacyFeedback?: boolean; legacyReviewVersion?: boolean; wrongOffsets?: boolean; emptyNextFacts?: boolean; wrongTurn?: boolean; zeroReport?: boolean; extraReportField?: boolean; changedUnreached?: boolean; invalidPlan?: boolean; throwFeedback?: boolean } = {}): DashscopeTextClient {
  return {
    model: 'offline-fixture',
    async completeChat(messages: Array<{ content: string }>) {
      const last = messages[messages.length - 1]!.content;
      let response: unknown;
      if (messages.length === 1) return { text: '请提供目标 JD、个人经历、求职阶段。' };
      if (last.startsWith('目标岗位：')) return { text: '请确认上面的 JD 和个人经历。' };
      if (opts.invalidPlan && (last.includes('一次输出冻结四项计划 JSON') || last.startsWith('计划未通过'))) return { text: '{"invalid":true}' };
      if (last.includes('一次输出冻结四项计划 JSON')) {
        const r = await mockClient().complete({ prompt: '【出题规则】' });
        return r;
      }
      if (last.includes('按已冻结计划原文提问')) return { text: /原文提问 q[1-4]：([^\n]+)/.exec(last)?.[1] ?? '错误' };
      if (last.startsWith('【本题已确认回答】')) {
        if (opts.throwFeedback) throw new Error('offline_provider_error');
        if (opts.proseFeedback) return { text: '你表现很好，继续保持。' };
        const answer = last.split('【本题已确认回答】\n')[1]!.split('\n【回答结束】')[0]!;
        const id = /questionId=(q[1-4])/.exec(last)![1]!;
        const turnId = /turnIds=\["(t[1-9][0-9]*)"\]/.exec(last)![1]!;
        const text = opts.invalidQuote && id === 'q1' ? '负责工具类产品的付费转化增长' : id === 'q1' ? '我的应聘方向是增长运营经理。' : '我先拆了漏斗：';
        const start = Math.max(0, answer.indexOf(text));
        response = { contractVersion: opts.legacyFeedback ? '0.2.0' : '0.3.0', questionId: id, reviewBasis: { turnIds: [turnId], textVersion: 'raw' }, dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d.key, { level: '部分清楚', quote: { text, start, end: start + text.length, turnId, textVersion: 'raw', matchType: 'exact' }, reason: '已说明一处真实回答依据' }])), factGaps: ['需要说清本人承担的动作'], topImprovement: '说清本人承担的动作', nextFacts: ['补充本人承担的动作'], reviewVersion: opts.legacyReviewVersion ? 'prompts@0.2.0' : PROMPT_VERSION };
        const feedback = response as { nextFacts: string[]; dimensions: Record<string, { quote: { start: number; end: number; turnId: string } }> };
        if (opts.emptyNextFacts) feedback.nextFacts = [];
        for (const dimension of Object.values(feedback.dimensions)) {
          if (opts.wrongOffsets) { dimension.quote.start = 0; dimension.quote.end = 1; }
          if (opts.wrongTurn) dimension.quote.turnId = 't99';
        }
      } else if (last.startsWith('结束训练。')) {
        const perQuestion = JSON.parse(last.slice(last.indexOf('\n') + 1)) as Array<{ status: string }>;
        response = { contractVersion: '0.3.0', sessionStatus: 'ended_early', completedQuestions: perQuestion.filter((q) => q.status === 'reviewed').length, totalQuestions: 4, perQuestion, priorityPractice: opts.metadataPriority ? ['根据 textVersion 编造百万用户故障故事'] : opts.unrelatedPriority ? ['编造十倍增长的商业成果'] : ['说清本人承担的动作'], versions: { ruleVersion: 'rules@0.3.0', realtimeModel: null, textModel: 'offline-fixture' } };
        if (opts.zeroReport) (response as { priorityPractice: string[] }).priorityPractice = ['本次未完成任何题目，无有效反馈'];
        if (opts.extraReportField) (response as Record<string, unknown>).versionStamp = '非法报告字段';
        if (opts.changedUnreached) perQuestion[3]!.status = 'skipped';
      } else throw new Error(`未处理的离线聊天输入：${last.slice(0, 40)}`);
      return { text: JSON.stringify(response), latencyMs: 0, usage: { totalTokens: 2 } };
    },
  } as unknown as DashscopeTextClient;
}

test('Prompt 介绍与一经历题均从原始反馈算闭环，引用按实际扩展回答定位', async () => {
  await withWriter(async (writer) => {
    const r = await runPromptFlow(mockChat(), writer);
    assert.equal(Object.values(r.closedLoop).every(Boolean), true);
    assert.deepEqual(r.questions!.map((q) => q.kind), ['introduction', 'experience']);
    assert.ok(r.quoteChecks.some((q) => q.text === '我的应聘方向是增长运营经理。' && q.located));
  });
});

test('Prompt 不把材料引用或普通散文当成已完成反馈，不放过无来源报告', async () => {
  await withWriter(async (writer) => {
    const material = await runPromptFlow(mockChat({ invalidQuote: true }), writer);
    assert.equal(material.closedLoop.introductionReviewed, false);
    assert.equal(material.closedLoop.gaveFeedback, false);
    assert.equal(material.closedLoop.quotedVerbatim, false);
    const prose = await runPromptFlow(mockChat({ proseFeedback: true }), writer);
    assert.equal(prose.closedLoop.feedbackHasAllFiveDims, false);
    assert.equal(prose.closedLoop.gaveFeedback, false);
    const badReport = await runPromptFlow(mockChat({ unrelatedPriority: true }), writer);
    assert.equal(badReport.closedLoop.reportValid, false);
  });
});


test('Skill 两次追问均记录且重答零追问，无来源优先点回退已校验反馈', async () => {
  await withWriter(async (writer) => {
    const r = await runSkillFlow(mockClient({ followups: true, unrelatedPriority: true }), writer);
    assert.ok(r.questions.every((q) => q.followups.length === 2));
    assert.equal(r.turns.filter((t) => t.step.startsWith('追问判定')).length, 8);
    assert.equal(r.report.source, 'derived_from_validated_feedback');
    assert.ok(r.report.raw.priorityPractice.every((p) => !p.includes('编造十倍')));
    assert.equal(r.report.raw.completedQuestions, 4);
  });
});

test('优先练习点不能用 JSON 字段名或版本元数据冒充判断来源', async () => {
  await withWriter(async (writer) => {
    const skill = await runSkillFlow(mockClient({ metadataPriority: true }), writer);
    assert.equal(skill.report.source, 'derived_from_validated_feedback');
    assert.ok(skill.report.raw.priorityPractice.every((text) => !text.includes('textVersion')));
    const prompt = await runPromptFlow(mockChat({ metadataPriority: true }), writer);
    assert.equal(prompt.closedLoop.reportValid, false);
  });
});

test('新版 Prompt 不把旧契约反馈标记为介绍或经历已点评', async () => {
  await withWriter(async (writer) => {
    const r = await runPromptFlow(mockChat({ legacyFeedback: true }), writer);
    assert.equal(r.closedLoop.introductionReviewed, false);
    assert.equal(r.closedLoop.experienceReviewed, false);
    assert.equal(r.closedLoop.gaveFeedback, false);
  });
});

test('新版 Prompt 的反馈提示词版本必须与本次使用版本一致', async () => {
  await withWriter(async (writer) => {
    const r = await runPromptFlow(mockChat({ legacyReviewVersion: true }), writer);
    assert.equal(r.closedLoop.gaveFeedback, false);
    assert.equal(r.closedLoop.introductionReviewed, false);
  });
});

test('Prompt 权威重定位只修坐标，保留原输出且单列原始校验失败', async () => {
  await withWriter(async (writer) => {
    const r = await runPromptFlow(mockChat({ wrongOffsets: true }), writer);
    assert.equal(Object.values(r.closedLoop).every(Boolean), true);
    assert.ok('rawClosedLoop' in r, '应用校验通过不能冒充普通聊天原始输出通过');
    assert.equal('rawClosedLoop' in r && Object.values(r.rawClosedLoop as Record<string, boolean>).every(Boolean), false);
    assert.ok(r.questions!.every((q) => q.rawFeedback.includes('"end":1')));
  });
});

test('Prompt 不代写空 nextFacts，不修错误轮次；零完成报告仍可合法结束', async () => {
  await withWriter(async (writer) => {
    const empty = await runPromptFlow(mockChat({ emptyNextFacts: true, wrongOffsets: true, zeroReport: true }), writer);
    assert.equal(empty.closedLoop.gaveFeedback, false);
    assert.equal(empty.closedLoop.reportValid, true);
    assert.equal(empty.quoteChecks.length, 10, '内容契约失败也应保留引用诊断');
    const wrongTurn = await runPromptFlow(mockChat({ wrongTurn: true, zeroReport: true }), writer);
    assert.equal(wrongTurn.closedLoop.gaveFeedback, false);
  });
});

test('Prompt 报告新增版本戳字段或改写未进入状态仍被拒绝', async () => {
  await withWriter(async (writer) => {
    assert.equal((await runPromptFlow(mockChat({ extraReportField: true }), writer)).closedLoop.reportValid, false);
    assert.equal((await runPromptFlow(mockChat({ changedUnreached: true }), writer)).closedLoop.reportValid, false);
  });
});

test('Prompt 计划三次不合规时仍保留5次离线对话与失败原因', async () => {
  await withWriter(async (writer) => {
    await assert.rejects(runPromptFlow(mockChat({ invalidPlan: true }), writer), /四项计划/);
    const saved = JSON.parse(readFileSync(path.join(writer.evidenceDir, 'prompt/transcript.json'), 'utf8'));
    assert.equal(saved.transcript.filter((t: { role: string }) => t.role === 'assistant').length, 5);
    assert.ok(readFileSync(path.join(writer.evidenceDir, 'prompt/failure.json'), 'utf8').includes('plan_invalid'));
  });
});

test('Prompt 中途提供方异常时保留已成功对话和待请求文本', async () => {
  await withWriter(async (writer) => {
    await assert.rejects(runPromptFlow(mockChat({ throwFeedback: true }), writer), /offline_provider_error/);
    const saved = JSON.parse(readFileSync(path.join(writer.evidenceDir, 'prompt/transcript.json'), 'utf8'));
    assert.equal(saved.transcript.filter((t: { role: string }) => t.role === 'assistant').length, 4);
    assert.match(saved.transcript.at(-1).content, /本题已确认回答/);
    assert.ok(readFileSync(path.join(writer.evidenceDir, 'prompt/failure.json'), 'utf8').includes('model_request_failed'));
  });
});
