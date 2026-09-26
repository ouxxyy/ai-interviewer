import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionPlanPrompt, followupDecisionPrompt, reviewPrompt, reportPrompt, PROMPT_VERSION } from '../src/prompts/prompts.js';
import { validateContract } from '../src/contracts/validate.js';
import type { ContractName } from '../src/contracts/version.js';

const mat = { jd: '负责内容运营与活动策划，基于数据复盘效果。', experience: '校内论坛运营一年，组织三次征稿活动。', stage: '应届', targetRole: '内容运营实习生' };
const basis = '我负责毕业季征稿，两周收到一百四十三篇投稿，比上期增长约八成。';

/**
 * 从提示词中抽出内嵌 JSON 模板并解析。
 * 约定：模板位于「输出 JSON 结构」标记行之后，以独立成行的 `{` 起，到括号配平为止。
 * 括号计数跳过字符串内部，避免占位符里出现花括号时误判。
 */
function extractJsonTemplate(prompt: string): unknown {
  const lines = prompt.split('\n');
  const marker = lines.findIndex((l) => l.includes('输出 JSON 结构'));
  assert.ok(marker >= 0, '提示词必须包含「输出 JSON 结构」标记行');
  const start = lines.findIndex((l, i) => i > marker && l.trim() === '{');
  assert.ok(start > marker, '模板必须以独立成行的 { 起始');

  let depth = 0;
  let inString = false;
  let escaped = false;
  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    collected.push(line);
    for (const ch of line) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { if (inString) escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) return JSON.parse(collected.join('\n'));
  }
  assert.fail('提示词 JSON 模板未闭合');
}

/** 抽取 → 解析 → 过 Schema；失败信息带上原始校验错误，便于定位是模板而非测试写错。 */
function assertTemplatePassesSchema(prompt: string, contract: ContractName): Record<string, unknown> {
  const parsed = extractJsonTemplate(prompt);
  const result = validateContract(contract, parsed);
  assert.equal(result.ok, true, `提示词内嵌模板未通过 ${contract} Schema：${result.ok ? '' : result.errors.join('; ')}`);
  return parsed as Record<string, unknown>;
}

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
    assert.ok(p.includes('占位符'), '占位符不得照抄的说明');
  }
  // 打分红线出现在评审与报告场景
  assert.ok(all[2]!.includes('不打分数'));
  assert.ok(all[3]!.includes('不打分数'));
});

test('问题计划提示词：内嵌 JSON 模板抽出后通过 QuestionPlan Schema（3 题）', () => {
  const p = questionPlanPrompt(mat);
  for (const field of ['contractVersion', 'questions', 'askedTopics', 'id', 'text', 'sourceExcerpt', 'intent', 'topics', 'q1', 'q2', 'q3', '0.2.0']) {
    assert.ok(p.includes(field), `缺少字段 ${field}`);
  }
  assert.ok(p.includes('3 道'), '必须声明 3 道主问题');
  const parsed = assertTemplatePassesSchema(p, 'question-plan');
  const questions = parsed.questions as Array<{ id: string }>;
  assert.deepEqual(questions.map((q) => q.id), ['q1', 'q2', 'q3'], '模板 id 必须依次为 q1/q2/q3');
});

test('追问判定提示词：输出契约字段与上限约束（轻量契约，无独立 Schema）', () => {
  const p = followupDecisionPrompt({ questionText: '说说你的关键动作', answerText: basis, followupCount: 1, remainingFollowups: 1 });
  for (const field of ['need', 'question', 'reason', 'gap', 'null']) {
    assert.ok(p.includes(field), `缺少字段 ${field}`);
  }
  assert.ok(p.includes('上限 2'), '追问上限写入提示词');
  assert.ok(p.includes('应用状态机'), 'D2：判断权在应用层');
  const parsed = extractJsonTemplate(p) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['gap', 'need', 'question', 'reason'], '模板字段集合必须与 FollowupDecision 类型一致');
  assert.equal(typeof parsed.need, 'boolean');
});

test('五维评审提示词：内嵌 JSON 模板抽出后通过 Feedback Schema', () => {
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

  const parsed = assertTemplatePassesSchema(p, 'feedback');
  assert.equal(parsed.reviewVersion, PROMPT_VERSION, '模板 reviewVersion 必须等于 PROMPT_VERSION');
  assert.equal(parsed.questionId, 'q1');
  // 修订版分支同样必须过 Schema（textVersion 枚举随入参切换）
  assertTemplatePassesSchema(
    reviewPrompt({ questionText: '说说你的关键动作', answerText: basis, turnIds: ['t1', 't2'], textVersion: 'revised', isRewrite: true, firstAnswerText: basis }),
    'feedback',
  );
});

test('报告生成提示词：内嵌 JSON 模板抽出后通过 SessionReport Schema，含 D6 零完成规则', () => {
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

  const zero = assertTemplatePassesSchema(p, 'session-report');
  assert.equal(zero.sessionStatus, 'ended_early');
  assert.equal(zero.completedQuestions, 0);
  // 正常完成分支
  const done = assertTemplatePassesSchema(reportPrompt({ completedQuestions: 3, endedEarly: false, perQuestionSummary: 'q1…' }), 'session-report');
  assert.equal(done.sessionStatus, 'completed');
  assert.equal(done.completedQuestions, 3);
});

