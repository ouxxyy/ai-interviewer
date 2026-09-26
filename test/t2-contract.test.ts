/**
 * T2 定稿的离线断言（不联网、不调模型）：
 * 1. 三入口共用规则文本：`docs/rules.md` 与 `src/rules/rules.ts` 必须逐字一致，且版本号/摘要可核对。
 * 2. 契约双版本：0.2.0 与 0.1.0 只差版本号；T1 期证据在 0.1.0 下仍可校验。
 * 3. 24 案例标注规范：字段齐、全标合成、分布对得上 issue §7、（注入类）有预期行为。
 * 4. 标定对照的冻结基线必须能在 git 里对上号。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RULES_VERSION, rulesDigest, rulesMarkdown, DIMENSIONS, LEVELS } from '../src/rules/rules.js';
import { CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS } from '../src/contracts/version.js';
import { validateContract, validateContractAt, validateContractAuto, assertLegacyMatchesCurrent } from '../src/contracts/validate.js';
import { PROMPT_VERSION, questionPlanPrompt, reviewPrompt, reportPrompt, followupDecisionPrompt } from '../src/prompts/prompts.js';
import { REPO_ROOT } from '../src/t1r/env.js';
import { loadCases } from '../src/t1r/chain-a.js';
import { verifyFrozenBaseline, VARIANTS, calibrationBatch } from '../src/t2/run-t2.js';

test('规则文本：docs/rules.md 与 src/rules/rules.ts 逐字一致，且版本号/摘要可核对', () => {
  const onDisk = readFileSync(path.join(REPO_ROOT, 'docs', 'rules.md'), 'utf8');
  assert.equal(onDisk, rulesMarkdown(), 'docs/rules.md 必须由 rulesMarkdown() 生成（跑 node dist/src/t2/run.js rules:write）');
  assert.ok(onDisk.includes(RULES_VERSION), '规则正文必须带版本号');
  assert.match(rulesDigest(), /^[0-9a-f]{64}$/, 'rulesDigest() 必须是 sha256');
  assert.equal(DIMENSIONS.length, 5);
  assert.deepEqual([...LEVELS], ['证据不足', '部分清楚', '充分清楚', '无法判断']);
});

test('三入口共用同一规则版本：四个提示词模板都带 RULES_VERSION', () => {
  const all = [
    questionPlanPrompt({ jd: 'jd', experience: 'exp', stage: '应届', targetRole: '内容运营' }),
    followupDecisionPrompt({ questionText: 'q', answerText: 'a', followupCount: 0, remainingFollowups: 2 }),
    reviewPrompt({ questionText: 'q', answerText: 'a', turnIds: ['t1'], textVersion: 'raw', isRewrite: false }),
    reportPrompt({ completedQuestions: 0, endedEarly: true, perQuestionSummary: '（无）' }),
  ];
  for (const p of all) {
    assert.ok(p.includes(RULES_VERSION), `提示词必须带共用规则版本 ${RULES_VERSION}`);
    assert.ok(p.includes('素材'), '共同红线必须逐字来自规则源');
  }
  assert.equal(VARIANTS.t2.promptVersion, PROMPT_VERSION);
});

test('契约双版本：0.1.0 与 0.2.0 只差版本号，加载时自检通过', () => {
  assert.doesNotThrow(() => assertLegacyMatchesCurrent());
  assert.equal(CONTRACT_VERSION, '0.2.0');
  assert.deepEqual([...SUPPORTED_CONTRACT_VERSIONS], ['0.2.0', '0.1.0']);
});

test('契约双版本：0.2.0 对象在 0.1.0 校验器下必须失败（版本号不是摆设）', () => {
  const fb = {
    contractVersion: '0.2.0',
    questionId: 'q1',
    reviewBasis: { turnIds: ['t1'], textVersion: 'raw' },
    dimensions: Object.fromEntries(
      ['relevance', 'specificity', 'contribution', 'resultsReflection', 'structure'].map((k) => [
        k,
        { level: '无法判断', quote: null, reason: '信息不足' },
      ]),
    ),
    factGaps: [],
    topImprovement: '补充事实',
    nextFacts: ['补充事实'],
    reviewVersion: PROMPT_VERSION,
  };
  assert.equal(validateContract('feedback', fb).ok, true);
  assert.equal(validateContractAt('feedback', '0.2.0', fb).ok, true);
  assert.equal(validateContractAt('feedback', '0.1.0', fb).ok, false, '0.2.0 的对象不该被 0.1.0 校验器接受');
  const legacy = { ...fb, contractVersion: '0.1.0' };
  assert.equal(validateContractAt('feedback', '0.1.0', legacy).ok, true);
  assert.equal(validateContract('feedback', legacy).ok, false, '0.1.0 的对象不该被当前校验器接受');
  const auto = validateContractAuto('feedback', legacy);
  assert.equal(auto.usedVersion, '0.1.0');
  assert.equal(auto.claimedVersion, '0.1.0');
});

test('F6 fail-closed：自报版本认不出来就拒绝，绝不静默回落到当前版本', () => {
  const base = { questionId: 'q1', reviewBasis: { turnIds: ['t1'], textVersion: 'raw' }, dimensions: {}, factGaps: [], topImprovement: 'x', nextFacts: ['y'], reviewVersion: 'v' };
  for (const claimed of ['9.9.9', 'v0.2.0', '0.1.0 ', '', 1, null, undefined]) {
    const res = validateContractAuto('feedback', { ...base, contractVersion: claimed });
    assert.equal(res.rejected, 'unrecognized_contract_version', `自报 ${JSON.stringify(claimed)} 必须被拒绝`);
    assert.equal(res.ok, false);
    assert.equal(res.usedVersion, null, '被拒绝时不得声称用某个版本校验过');
  }
  // 认得出的版本正常走
  const good = validateContractAuto('feedback', { ...base, contractVersion: '0.2.0' });
  assert.equal(good.rejected, undefined);
  assert.equal(good.usedVersion, '0.2.0');
  assert.equal(good.claimedVersion, '0.2.0');
});

test('T1 期真实证据在 0.1.0 校验器下仍可校验（升版不能让历史证据失效）', () => {
  const dir = path.join(REPO_ROOT, 'evidence', 't1r', 'chain-a');
  const plan = JSON.parse(readFileSync(path.join(dir, 'question-plan.json'), 'utf8')) as { contractVersion: string };
  assert.equal(plan.contractVersion, '0.1.0');
  const planResult = validateContractAuto('question-plan', plan);
  assert.equal(planResult.usedVersion, '0.1.0');
  assert.equal(planResult.ok, true, `T1 QuestionPlan 应在 0.1.0 下通过：${planResult.errors.join('; ')}`);

  for (const id of ['C01', 'C02', 'C03', 'C15', 'C19']) {
    const doc = JSON.parse(readFileSync(path.join(dir, `feedback-${id}.json`), 'utf8')) as { feedback: { contractVersion: string } };
    const res = validateContractAuto('feedback', doc.feedback);
    assert.equal(res.usedVersion, '0.1.0');
    assert.equal(res.ok, true, `T1 Feedback ${id} 应在 0.1.0 下通过：${res.errors.join('; ')}`);
  }
});

test('24 案例标注规范：字段齐、全标合成、分布对得上 issue §7', () => {
  const cases = loadCases();
  assert.equal(cases.length, 24, '固定案例必须恰好 24 个');
  const required = ['id', 'synthetic', 'stage', 'track', 'targetRole', 'flawType', 'flawNote', 'materials', 'questionText', 'firstAnswer', 'expectedDims', 'expectedGaps', 'expectedBehavior'];
  for (const c of cases) {
    for (const field of required) {
      assert.ok(field in c, `${c.id} 缺字段 ${field}`);
    }
    assert.equal(c.synthetic, true, `${c.id} 必须标注合成`);
    assert.equal(Object.keys(c.expectedDims).length, 5, `${c.id} 预期档位必须覆盖五维`);
    for (const [dim, level] of Object.entries(c.expectedDims)) {
      assert.ok([...LEVELS].includes(level as (typeof LEVELS)[number]), `${c.id}.${dim} 档位取值非法：${level}`);
    }
    assert.ok(c.firstAnswer.length >= 100, `${c.id} 首轮回答过短`);
    assert.ok(c.materials.jd.length > 0 && c.materials.experience.length > 0, `${c.id} 材料不完整`);
    if (c.flawType === '简历提示注入' || c.flawType === '要求编造经历') {
      assert.ok(typeof c.expectedBehavior === 'string' && c.expectedBehavior.length >= 20, `${c.id} 注入/编造类必须有预期行为`);
    }
  }
  const tally = (fn: (c: (typeof cases)[number]) => string): Record<string, number> =>
    cases.reduce<Record<string, number>>((acc, c) => ({ ...acc, [fn(c)]: (acc[fn(c)] ?? 0) + 1 }), {});
  assert.deepEqual(tally((c) => c.track), { 产品运营: 12, 研发数据: 12 }, 'issue §7：12 产品运营 / 12 研发数据');
  assert.deepEqual(tally((c) => c.stage), { 应届: 12, 社招: 12 }, 'issue §7：12 应届 / 12 社招');
  const injection = cases.filter((c) => c.flawType === '简历提示注入').length;
  const fabricate = cases.filter((c) => c.flawType === '要求编造经历').length;
  assert.ok(injection >= 3, `issue §7：注入类至少 3 个（实际 ${injection}）`);
  assert.ok(fabricate >= 1, `issue §7：要求编造经历至少 1 个（实际 ${fabricate}）`);
});

test('标定案例批次是确定性抽样，不按结果挑', () => {
  const cases = loadCases();
  const batch = calibrationBatch(cases, 4);
  assert.deepEqual(batch.map((c) => c.id), ['C01', 'C05', 'C09', 'C13', 'C17', 'C21']);
  assert.equal(batch.length, 6);
});

test('对照标定的冻结基线能在 git 里对上号（对不上就不该拿来做对照）', () => {
  for (const v of ['t1s', 't1r'] as const) {
    const res = verifyFrozenBaseline(v);
    assert.equal(res.ok, true, `${v} 基线校验失败：${res.detail}`);
  }
  assert.equal(verifyFrozenBaseline('t2').ok, true);
});
