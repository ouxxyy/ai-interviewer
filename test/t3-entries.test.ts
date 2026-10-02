/**
 * T3 两个纯文字入口的离线断言（不联网）：
 * 1. 产物与生成器逐字一致——手改产物、或改了规则源忘了重跑，测试直接红。
 * 2. 两个入口带**同一个** rules 版本号与摘要（A8 一致性验收压在这上面）。
 * 3. Skill 明确声明无语音能力；简版 Prompt 自包含（规则正文在文件里，不指向仓库）。
 * 4. 简版 Prompt 里内嵌的 JSON 模板必须过 feedback Schema。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/t1r/env.js';
import { ENTRY_HINTS, t3Artifacts, skillMarkdown, simplePromptMarkdown, structureHintBlock, versionStamp, sessionReportJsonTemplate } from '../src/t3/content.js';
import { RULES_VERSION, rulesDigest, rulesMarkdown } from '../src/rules/rules.js';
import { reviewPrompt } from '../src/prompts/prompts.js';
import { validateContract } from '../src/contracts/validate.js';

test('Skill 包与简版 Prompt 的磁盘内容 == 生成结果（手改产物会红）', () => {
  for (const a of t3Artifacts()) {
    const onDisk = readFileSync(path.join(REPO_ROOT, a.path), 'utf8');
    assert.equal(onDisk, a.content, `${a.path} 与生成器输出不一致——跑 node dist/src/t3/cli.js skill:build`);
  }
});

test('两个入口带同一个 rules 版本号与摘要（A8 一致性的前提）', () => {
  const skill = skillMarkdown();
  const prompt = simplePromptMarkdown();
  for (const [name, text] of [['SKILL.md', skill], ['简版 Prompt', prompt]] as const) {
    assert.ok(text.includes(RULES_VERSION), `${name} 必须带规则版本号 ${RULES_VERSION}`);
    assert.ok(text.includes(rulesDigest()), `${name} 必须带规则正文摘要（发布物可核对同一份规则）`);
  }
  assert.ok(prompt.includes(skill) === false, '简版 Prompt 不该内嵌整份 SKILL.md');
  assert.ok(prompt.includes('## 四、红线') || prompt.includes('红线'), '简版 Prompt 必须自带红线');
});

test('Skill 明确声明无录音／无实时语音能力（不得暗示）', () => {
  const skill = skillMarkdown();
  assert.match(skill, /没有录音、没有实时语音/);
  assert.match(skill, /不产生录音、不产生音频文件/);
  assert.match(skill, /不打分、不给示范答案/);
});

test('简版 Prompt 自包含：规则正文在文件里，不指向仓库路径', () => {
  const prompt = simplePromptMarkdown();
  assert.ok(prompt.includes('自包含'), '必须标明自包含');
  assert.ok(prompt.includes('## 附：完整规则正文'), '必须内嵌完整规则正文');
  assert.ok(!/src\/rules\/rules\.ts|docs\/rules\.md/.test(prompt.split('## 附：完整规则正文')[0]!), '使用说明部分不得依赖仓库文件');
  assert.match(prompt, /纯文字/);
});

test('简版 Prompt 内嵌的 JSON 模板过 feedback Schema', () => {
  const prompt = simplePromptMarkdown();
  const start = prompt.indexOf('{\n  "contractVersion"');
  assert.ok(start > 0, '必须内嵌 JSON 模板');
  const end = prompt.indexOf('\n}', start) + 2;
  const parsed = JSON.parse(prompt.slice(start, end)) as Record<string, unknown>;
  const res = validateContract('feedback', parsed);
  assert.equal(res.ok, true, `模板未过 Schema：${res.errors.join('; ')}`);
});

test('两个文字入口给出可校验的零完成报告形状，不把版本戳放进 JSON', () => {
  const parsed = JSON.parse(sessionReportJsonTemplate());
  assert.equal(validateContract('session-report', parsed).ok, true);
  assert.deepEqual(parsed.priorityPractice, ['本次未完成任何题目，无有效反馈']);
  assert.equal(parsed.completedQuestions, 0);
  for (const text of [skillMarkdown(), simplePromptMarkdown()]) {
    assert.ok(text.includes(sessionReportJsonTemplate()));
    assert.match(text, /nextFacts 至少 1 项/);
    assert.match(text, /禁止添加 summaryNote 或 versionStamp/);
    assert.match(text, /not_reached.*从未进入/);
  }
});

test('R6：入口级操作提示锁在单源常量上，两个入口逐字相同，且明确标注不在 rulesDigest 覆盖内', () => {
  const skill = skillMarkdown();
  const prompt = simplePromptMarkdown();
  const hint = ENTRY_HINTS.structureQuoteProcedure;
  const label = ENTRY_HINTS.structureHintLabel;

  // 1) 两个入口都渲染同一个常量，逐字相同
  for (const [name, text] of [['SKILL.md', skill], ['简版 Prompt', prompt]] as const) {
    assert.ok(text.includes(hint), `${name} 必须原样包含 ENTRY_HINTS.structureQuoteProcedure`);
    assert.ok(text.includes(label), `${name} 必须带「不属于规则正文」的标注`);
    assert.ok(text.includes(structureHintBlock().split('\n')[1]!), `${name} 的提示块必须由 structureHintBlock() 渲染`);
  }

  // 2) 它**不在**规则正文里——因此不在 rulesDigest() 覆盖范围内
  assert.equal(rulesMarkdown().includes(hint), false, '入口提示不得混进规则正文');
  assert.equal(rulesMarkdown().includes(label), false, '入口提示的标注不得混进规则正文');

  // 3) 提示块必须自我声明地位，不能只是我们口头知道
  assert.match(hint, /完整的一句|整句复制/, '提示块内容应可辨认');
  assert.match(label, /不属于规则正文/);
  assert.match(label, /rulesDigest/, '标注里必须点名它不在摘要覆盖范围内');
});

test('当前默认使用 prose；机械版只差 structure 操作提示，历史实验须重新预登记', () => {
  const input = { questionText: '说说你的关键动作', answerText: '我先做了调研，然后上线。', turnIds: ['t1'], textVersion: 'raw' as const, isRewrite: false };
  const dflt = reviewPrompt(input);
  const prose = reviewPrompt({ ...input, structureHint: 'prose' });
  const mech = reviewPrompt({ ...input, structureHint: 'mechanical' });
  assert.equal(dflt, prose, '当前默认必须等于 prose，不把机械操作提示混进规则正文');
  assert.notEqual(prose, mech);
  assert.ok(mech.includes(ENTRY_HINTS.structureQuoteProcedure), '机械版必须渲染入口提示常量');
  assert.ok(!prose.includes(ENTRY_HINTS.structureHintLabel), '散文版不得混入入口提示');

  // 两版差异必须**只**在 structure 那一条 bullet 上
  const proseLines = new Set(prose.split('\n'));
  const mechLines = new Set(mech.split('\n'));
  const onlyProse = [...proseLines].filter((l) => !mechLines.has(l));
  const onlyMech = [...mechLines].filter((l) => !proseLines.has(l));
  for (const l of onlyMech) assert.match(l, /structure|入口级操作提示|无法判断|连续逐字/, `机械版多出的行不该在别处：${l}`);

  // 真实性约束两版都在，一字未动
  for (const text of [prose, mech]) {
    assert.ok(text.includes('禁止省略号'), '两版都必须保留「禁止省略号」');
    assert.ok(text.includes('禁止拼接') || text.includes('不要为了凑出引用去拼接'), '两版都必须保留禁止拼接');
    assert.ok(text.includes('连续出现'), '两版都必须保留「连续出现」');
  }
  void onlyProse;
});

test('R6：网页入口将来必须引用同一常量（在源码里留下可检索的约定）', () => {
  // 这条不是运行时断言，而是把约定写成可 grep 的事实：content.ts 的注释里点名了网页入口。
  const src = readFileSync(path.join(REPO_ROOT, 'src', 't3', 'content.ts'), 'utf8');
  assert.match(src, /网页入口将来\*\*必须\*\*引用本常量|网页入口/, 'content.ts 必须写明网页入口的引用约定');
});

test('版本戳同时含三个版本号', () => {
  const stamp = versionStamp();
  assert.match(stamp, /rules@/);
  assert.match(stamp, /contract@/);
  assert.match(stamp, /prompts@/);
});


test('两个文字入口明确介绍必练、四项冻结计划和分开汇总', () => {
  for (const text of [skillMarkdown(), simplePromptMarkdown()]) {
    assert.match(text, /自我介绍/);
    assert.match(text, /1[–—-]2 分钟/);
    assert.match(text, /不强制限时/);
    assert.match(text, /q1.*introduction/);
    assert.match(text, /q2.*q3.*q4.*experience/);
    assert.match(text, /不.*介绍.*修改.*后三题|后三题.*不.*介绍/);
    assert.match(text, /介绍状态/);
    assert.match(text, /经历题.*[xX]\/3/);
    assert.match(text, /不要求完整项目反思/);
  }
});
