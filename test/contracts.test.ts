import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContract } from '../src/contracts/validate.js';
import type { CandidateMaterials, QuestionPlan, Turn, Feedback, SessionReport } from '../src/contracts/types.js';

const jd = '负责社区产品内容运营与活动策划，能基于数据复盘活动效果，输出迭代建议。';
const exp = '校内论坛运营负责人一年，组织三次主题征稿活动，注册用户从八千增至一万二。';

const materials: CandidateMaterials = {
  contractVersion: '0.2.0',
  jd,
  experience: exp,
  stage: '应届',
  targetRole: '内容运营实习生',
  materialsVersion: 1,
  confirmed: true,
};

const plan: QuestionPlan = {
  contractVersion: '0.2.0',
  questions: [
    { id: 'q1', text: '说说你负责征稿活动时个人做了哪些关键动作？', sourceExcerpt: '组织三次主题征稿活动', intent: '考察个人贡献与动作', topics: ['活动运营'] },
    { id: 'q2', text: '数据增长背后你做了什么取舍？', sourceExcerpt: '注册用户从八千增至一万二', intent: '考察归因与反思', topics: ['数据复盘'] },
    { id: 'q3', text: '如果重来一次你会改进什么？', sourceExcerpt: '输出迭代建议', intent: '考察反思深度', topics: ['反思'] },
  ],
  askedTopics: ['活动运营', '数据复盘', '反思'],
};

const turn: Turn = {
  contractVersion: '0.2.0',
  id: 't1',
  questionId: 'q1',
  speaker: 'user',
  turnType: 'answer',
  seq: 1,
  startedAt: '2026-09-26T22:00:00+08:00',
  endedAt: '2026-09-26T22:01:30+08:00',
  rawTranscript: '我负责毕业季征稿，两周收到一百四十三篇投稿。',
  revisedText: null,
  audioFile: 'data/prototype/s1/turn-1-user.webm',
};

const basis = '我负责毕业季征稿，两周收到一百四十三篇投稿，比上期增长约八成。';
const dim = (level: Feedback['dimensions']['relevance']['level'], quoteText: string | null) =>
  level === '无法判断'
    ? { level, quote: null, reason: '回答中未见相关信息' }
    : { level, quote: { text: quoteText!, start: 0, end: 4, turnId: 't1', textVersion: 'raw' as const, matchType: 'exact' as const }, reason: '依据所引原话' };

const feedback: Feedback = {
  contractVersion: '0.2.0',
  questionId: 'q1',
  reviewBasis: { turnIds: ['t1'], textVersion: 'raw' },
  dimensions: {
    relevance: dim('充分清楚', '我负责毕业季征稿'),
    specificity: dim('部分清楚', '两周收到一百四十三篇投稿'),
    contribution: dim('充分清楚', '我负责毕业季征稿'),
    resultsReflection: dim('部分清楚', '比上期增长约八成'),
    structure: dim('无法判断', null),
  },
  factGaps: ['增长基线口径未说明'],
  topImprovement: '补充增长基线与个人动作的对应关系',
  nextFacts: ['上一期的投稿数量'],
  reviewVersion: 'prompts@0.2.0',
};

const report: SessionReport = {
  contractVersion: '0.2.0',
  sessionStatus: 'completed',
  completedQuestions: 3,
  totalQuestions: 3,
  perQuestion: [
    { questionId: 'q1', status: 'reviewed', feedback, rewriteDelta: null },
    { questionId: 'q2', status: 'reviewed', feedback: null, rewriteDelta: { added: ['补充了样本量'], corrected: [], stillMissing: ['显著性'] } },
    { questionId: 'q3', status: 'not_reached', feedback: null, rewriteDelta: null },
  ],
  priorityPractice: ['先说结论再展开'],
  versions: { ruleVersion: 'rules@0.2.0', realtimeModel: null, textModel: null },
};

test('五个契约对象：合法样例全部通过 Schema 校验', () => {
  assert.equal(validateContract('candidate-materials', materials).ok, true);
  assert.equal(validateContract('question-plan', plan).ok, true);
  assert.equal(validateContract('turn', turn).ok, true);
  assert.equal(validateContract('feedback', feedback).ok, true);
  assert.equal(validateContract('session-report', report).ok, true);
});

test('candidate-materials：未确认 / 空材料 / 多余字段 / 错误阶段 拒绝', () => {
  assert.equal(validateContract('candidate-materials', { ...materials, confirmed: false }).ok, true, '未确认本身合法（由状态机把关）');
  const bad1 = validateContract('candidate-materials', { ...materials, jd: '太短' });
  assert.equal(bad1.ok, false);
  const bad2 = validateContract('candidate-materials', { ...materials, stage: '实习生' });
  assert.equal(bad2.ok, false);
  const bad3 = validateContract('candidate-materials', { ...materials, extra: 1 });
  assert.equal(bad3.ok, false);
});

test('question-plan：题目数 ≠3 拒绝', () => {
  const two = { ...plan, questions: plan.questions.slice(0, 2) };
  assert.equal(validateContract('question-plan', two).ok, false);
  const four = { ...plan, questions: [...plan.questions, { ...plan.questions[0]!, id: 'q4' }] };
  assert.equal(validateContract('question-plan', four).ok, false);
});

test('turn：时间戳格式与空转写拒绝', () => {
  assert.equal(validateContract('turn', { ...turn, startedAt: '2026/09/26 22:00' }).ok, false);
  assert.equal(validateContract('turn', { ...turn, rawTranscript: '' }).ok, false);
  assert.equal(validateContract('turn', { ...turn, revisedText: '' }).ok, false, '修订文本为空串应拒绝（要么 null 要么非空）');
});

test('feedback：三档缺引用 / 无法判断带引用 / 缺维度 拒绝', () => {
  const noQuote = structuredClone(feedback);
  noQuote.dimensions.specificity = { level: '部分清楚', quote: null, reason: 'x' };
  assert.equal(validateContract('feedback', noQuote).ok, false);

  const quotedUnable = structuredClone(feedback);
  quotedUnable.dimensions.structure = {
    level: '无法判断',
    quote: { text: basis.slice(0, 4), start: 0, end: 4, turnId: 't1', textVersion: 'raw', matchType: 'exact' },
    reason: 'x',
  };
  assert.equal(validateContract('feedback', quotedUnable).ok, false);

  const missingDim = structuredClone(feedback) as unknown as Record<string, unknown>;
  const dims = missingDim.dimensions as Record<string, unknown>;
  delete dims.structure;
  assert.equal(validateContract('feedback', missingDim).ok, false);
});

test('session-report：题数越界 / 非法状态 拒绝；零完成报告合法（D6）', () => {
  assert.equal(validateContract('session-report', { ...report, completedQuestions: 4 }).ok, false);
  assert.equal(validateContract('session-report', { ...report, sessionStatus: 'paused' }).ok, false);
  const zero: SessionReport = {
    contractVersion: '0.2.0',
    sessionStatus: 'ended_early',
    completedQuestions: 0,
    totalQuestions: 3,
    perQuestion: [],
    priorityPractice: ['本次未完成任何题目，无有效反馈'],
    versions: { ruleVersion: 'rules@0.2.0', realtimeModel: null, textModel: null },
  };
  assert.equal(validateContract('session-report', zero).ok, true);
});

test('契约版本号：错误版本拒绝', () => {
  assert.equal(validateContract('turn', { ...turn, contractVersion: '0.0.9' }).ok, false);
});
