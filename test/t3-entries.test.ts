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
import { t3Artifacts, skillMarkdown, simplePromptMarkdown, versionStamp } from '../src/t3/content.js';
import { RULES_VERSION, rulesDigest } from '../src/rules/rules.js';
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

test('版本戳同时含三个版本号', () => {
  const stamp = versionStamp();
  assert.match(stamp, /rules@/);
  assert.match(stamp, /contract@/);
  assert.match(stamp, /prompts@/);
});
