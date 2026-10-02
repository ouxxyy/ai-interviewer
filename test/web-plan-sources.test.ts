import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanSources, resolvePlanSources } from '../src/web/plan-sources.js';
import { questionPlanPrompt } from '../src/prompts/prompts.js';
import { validateQuestionPlan } from '../src/contracts/question-plan.js';

const materials = { jd: '负责产品设计。需要沟通能力。', experience: '在一个项目中负责需求分析和流程设计。', stage: '社招', targetRole: '产品经理' };
const draft = () => ({ contractVersion: '0.3.0', questions: [
  { id: 'q1', kind: 'introduction', text: '请介绍与岗位相关的个人经历。', sourceId: 'jd:1', intent: '了解岗位匹配', topics: ['自我介绍'] },
  { id: 'q2', kind: 'experience', text: '请说明这段经历中你做了什么。', sourceId: 'experience:1', intent: '验证个人贡献', topics: ['个人贡献'] },
  { id: 'q3', kind: 'experience', text: '请说明你如何解决沟通中的困难。', sourceId: 'jd:1', intent: '验证沟通能力', topics: ['困难处理'] },
  { id: 'q4', kind: 'experience', text: '请说明这次项目复盘中的收获。', sourceId: 'experience:1', intent: '了解复盘反思', topics: ['复盘反思'] },
], askedTopics: [] });

test('长材料、换行、标点、表情与尾段全部保留为单份原文的连续区间', () => {
  for (const experience of ['段落。\n'.repeat(160) + '尾', '甲'.repeat(239) + '😀' + '乙'.repeat(480) + '末尾', 'a'.repeat(480) + '。\n结束', '行首\n\n' + '有空格 和标点；'.repeat(60)]) {
    const inputs = { ...materials, experience };
    const sources = buildPlanSources(inputs);
    assert.equal(new Set(sources.map(s => s.id)).size, sources.length);
    for (const name of ['jd', 'experience'] as const) {
      const parts = sources.filter(s => s.material === name);
      assert.equal(parts.map(s => s.text).join(''), inputs[name]);
      for (const part of parts) {
        assert.equal(inputs[name].slice(part.start, part.end), part.text);
        assert.ok(part.text.length >= 4);
        assert.equal(Buffer.from(part.text, 'utf8').toString('utf8'), part.text);
      }
    }
  }
});

test('编号转换保留问题内容、通过原有契约且不修改模型原始对象', () => {
  const raw = draft();
  const before = JSON.stringify(raw);
  const result = resolvePlanSources(raw, buildPlanSources(materials));
  assert.ok(result.ok);
  assert.equal(validateQuestionPlan(result.plan, materials).ok, true);
  assert.equal(JSON.stringify(raw), before);
  const plan = result.plan as { questions: Array<{ text: string; sourceExcerpt: string }> };
  assert.equal(plan.questions[1]!.sourceExcerpt, materials.experience);
  assert.deepEqual(plan.questions.map(q => q.text), raw.questions.map(q => q.text));
});

test('未知编号、数组、对象和两种来源冲突均拒绝，不盲选默认片段', () => {
  for (const sourceId of ['experience:999', 'jd:1,experience:1', '__proto__', ['jd:1'], {}, null]) {
    const raw = draft();
    Object.assign(raw.questions[1]!, { sourceId });
    assert.equal(resolvePlanSources(raw, buildPlanSources(materials)).ok, false);
  }
  const raw = draft();
  Object.assign(raw.questions[1]!, { sourceExcerpt: '模型编造的原文' });
  assert.equal(resolvePlanSources(raw, buildPlanSources(materials)).ok, false);
});

test('回填不能放宽重复题、错误身份、缺字段和额外字段校验', () => {
  for (const mutate of [
    (p: ReturnType<typeof draft>) => { p.questions[1]!.text = p.questions[0]!.text; },
    (p: ReturnType<typeof draft>) => { p.questions[1]!.id = 'q4'; },
    (p: ReturnType<typeof draft>) => { Object.assign(p.questions[1]!, { intent: '' }); },
    (p: ReturnType<typeof draft>) => { Object.assign(p, { unexpected: true }); },
  ]) {
    const raw = draft(); mutate(raw);
    const result = resolvePlanSources(raw, buildPlanSources(materials));
    assert.ok(result.ok);
    assert.equal(validateQuestionPlan(result.plan, materials).ok, false);
  }
});

test('旧格式只接受能定位的原文；改写和跨材料拼接仍失败', () => {
  for (const excerpt of ['负责产品设计', '负责优秀产品设计', materials.jd + materials.experience]) {
    const raw = draft();
    const legacy = { ...raw, questions: raw.questions.map(({ sourceId: _id, ...q }) => ({ ...q, sourceExcerpt: excerpt })) };
    const result = resolvePlanSources(legacy, buildPlanSources(materials));
    assert.ok(result.ok);
    assert.equal(validateQuestionPlan(result.plan, materials).ok, excerpt === '负责产品设计');
  }
});

test('网页提示词结构只要求编号且带完整目录；文字入口保持原契约', () => {
  const sources = buildPlanSources(materials);
  const prompt = questionPlanPrompt(materials, sources);
  assert.ok(prompt.includes(JSON.stringify(sources.map(({ id, text }) => ({ id, text })))));
  assert.ok(prompt.includes('"sourceId": "jd:1"'));
  assert.ok(!prompt.includes('"sourceExcerpt":'));
  assert.ok(prompt.includes('"askedTopics": []'));
  const textPrompt = questionPlanPrompt(materials);
  assert.ok(textPrompt.includes('"sourceExcerpt":'));
  assert.ok(!textPrompt.includes('sourceId'));
});
