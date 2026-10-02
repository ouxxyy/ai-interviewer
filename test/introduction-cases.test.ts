import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/t1r/env.js';
import { locateQuote } from '../src/contracts/quote-locator.js';
import { introductionRubric } from '../src/rules/rules.js';
import { reviewPrompt } from '../src/prompts/prompts.js';

test('八类合成介绍/经历案例保留真实证据边界与未标定标注', () => {
  const doc = JSON.parse(readFileSync(path.join(REPO_ROOT, 'cases/introduction-cases.json'), 'utf8')) as { synthetic: boolean; qualityCalibration: string; cases: Array<{ id: string; category: string; kind: 'introduction' | 'experience'; stage: '应届' | '社招'; targetRole: string; jd: string; experience: string; answer: string; allowedQuote: string; forbiddenQuote: string; acceptance: string }> };
  assert.equal(doc.synthetic, true);
  assert.equal(doc.qualityCalibration, '未标定');
  assert.equal(doc.cases.length, 8);
  assert.equal(new Set(doc.cases.map((c) => c.category)).size, 8);
  for (const c of doc.cases) {
    assert.equal(locateQuote(c.answer, c.allowedQuote).located, true, `${c.id} 正向事实引用`);
    assert.equal(locateQuote(c.answer, c.forbiddenQuote).located, false, `${c.id} 不得引用材料或编造的事实`);
    const prompt = reviewPrompt({ questionText: c.kind === 'introduction' ? '请围绕岗位介绍自己' : '请说明本人动作与结果', context: { kind: c.kind, stage: c.stage, targetRole: c.targetRole, jd: c.jd, intent: c.acceptance }, answerText: c.answer, turnIds: ['t1'], textVersion: 'raw', isRewrite: false });
    assert.match(prompt, /当前题已确认回答.*唯一事实证据/);
    if (c.kind === 'introduction') assert.ok(prompt.includes(introductionRubric()), `${c.id} 使用同源介绍标尺`);
  }
});
