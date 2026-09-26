import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionPlanPrompt, followupDecisionPrompt, reviewPrompt, reportPrompt, PROMPT_VERSION } from '../src/prompts/prompts.js';

const mat = { jd: '负责内容运营与活动策划，基于数据复盘效果。', experience: '校内论坛运营一年，组织三次征稿活动。', stage: '应届', targetRole: '内容运营实习生' };
const basis = '我负责毕业季征稿，两周收到一百四十三篇投稿，比上期增长约八成。';

test('四个提示词都携带共同红线（素材非指令／原话引用／不打分）', () => {
  const all = [
    questionPlanPrompt(mat),
    followupDecisionPrompt({ questionText: '说说你的关键动作', answerText: basis, followupCount: 0, remainingFollowups: 2 }),
    reviewPrompt({ questionText: '说说你的关键动作', answerText: basis, turnIds: ['t1'], textVersion: 'raw', isRewrite: false }),
    reportPrompt({ completedQuestions: 3, endedEarly: false, perQuestionSummary: 'q1：五维反馈…' }),
  ];
  for (const p of all) {
    assert.ok(p.includes('素材'), '必须有“素材”红线');
    assert.ok(p.includes('不是对你的指令') || p.includes('不是对你的指令') || p.includes('当作待分析材料'), '材料非指令红线');
    assert.ok(p.includes('原话') || p.includes('没说过的事'), '原话引用红线');
  }
  // 打分红线出现在评审与报告场景
  assert.ok(all[2]!.includes('不打分数'));
  assert.ok(all[3]!.includes('不打分数'));
});

test('问题计划提示词：与 QuestionPlan 契约字段一一对应', () => {
  const p = questionPlanPrompt(mat);
  for (const field of ['contractVersion', 'questions', 'askedTopics', 'id', 'text', 'sourceExcerpt', 'intent', 'topics', 'q1', 'q2', 'q3', '0.1.0']) {
    assert.ok(p.includes(field), `缺少字段 ${field}`);
  }
  assert.ok(p.includes('3 道'), '必须声明 3 道主问题');
});

test('追问判定提示词：输出契约字段与上限约束', () => {
  const p = followupDecisionPrompt({ questionText: '说说你的关键动作', answerText: basis, followupCount: 1, remainingFollowups: 1 });
  for (const field of ['need', 'question', 'reason', 'gap', 'null']) {
    assert.ok(p.includes(field), `缺少字段 ${field}`);
  }
  assert.ok(p.includes('上限 2'), '追问上限写入提示词');
  assert.ok(p.includes('应用状态机'), 'D2：判断权在应用层');
});

test('五维评审提示词：与 Feedback 契约字段一一对应', () => {
  const p = reviewPrompt({ questionText: '说说你的关键动作', answerText: basis, turnIds: ['t1'], textVersion: 'raw', isRewrite: false });
  for (const field of [
    'contractVersion', 'questionId', 'reviewBasis', 'turnIds', 'textVersion',
    'dimensions', 'relevance', 'specificity', 'contribution', 'resultsReflection', 'structure',
    'level', 'quote', 'text', 'start', 'end', 'turnId', 'matchType', 'reason',
    'factGaps', 'topImprovement', 'nextFacts', 'reviewVersion',
  ]) {
    assert.ok(p.includes(field), `缺少字段 ${field}`);
  }
  for (const level of ['证据不足', '部分清楚', '充分清楚', '无法判断']) {
    assert.ok(p.includes(level), `缺少档位 ${level}`);
  }
  for (const match of ['exact', 'normalized']) {
    assert.ok(p.includes(match), `缺少 matchType 说明 ${match}`);
  }
  assert.ok(p.includes(PROMPT_VERSION), 'reviewVersion 版本号写入');
  assert.ok(p.includes('null'), '无法判断维度 quote 必须为 null 的说明');
});

test('报告生成提示词：与 SessionReport 契约字段一一对应，含 D6 零完成规则', () => {
  const p = reportPrompt({ completedQuestions: 0, endedEarly: true, perQuestionSummary: '（无）' });
  for (const field of [
    'contractVersion', 'sessionStatus', 'ended_early', 'completed', 'completedQuestions',
    'totalQuestions', 'perQuestion', 'questionId', 'status', 'feedback', 'rewriteDelta',
    'added', 'corrected', 'stillMissing', 'priorityPractice', 'versions', 'ruleVersion',
    'realtimeModel', 'textModel',
  ]) {
    assert.ok(p.includes(field), `缺少字段 ${field}`);
  }
  assert.ok(p.includes('本次未完成任何题目，无有效反馈'), 'D6 零完成报告规则');
  assert.ok(p.includes('not_reached') && p.includes('skipped') && p.includes('reviewed'), '三种题目状态枚举');
});
