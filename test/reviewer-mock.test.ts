import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReview } from '../src/review/reviewer.js';
import { buildValidReviewJson, validChannel, invalidJsonOnceChannel, schemaInvalidChannel, quoteMissingOnceChannel, quoteAlteredChannel } from '../src/review/fixtures.js';
import { validateContract } from '../src/contracts/validate.js';
import { sliceByLocation } from '../src/contracts/quote-locator.js';

const basis = '我负责毕业季征稿，前期用问卷收集了两百份偏好，活动两周收到一百四十三篇投稿，比上一期增长约八成，复盘后我补了投稿指引。';
const input = {
  basisText: basis,
  turnIds: ['t1'],
  textVersion: 'raw' as const,
  questionId: 'q1',
};

test('有效输出：一次通过，引用被权威重定位且可逐字还原', async () => {
  const out = await runReview({ ...input, channel: validChannel(basis, 'q1', ['t1'], 'raw') });
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') {
    assert.equal(out.attempts, 1);
    const check = validateContract('feedback', out.feedback);
    assert.equal(check.ok, true, `评审结果必须通过 Schema：${JSON.stringify(check.errors)}`);
    for (const dim of Object.values(out.feedback.dimensions)) {
      if (dim.level === '无法判断') {
        assert.equal(dim.quote, null);
      } else {
        assert.ok(dim.quote, '三档必须有引用');
        const sliced = sliceByLocation(basis, dim.quote.start, dim.quote.end);
        assert.equal(sliced, dim.quote.text, `引用必须逐字还原：${dim.quote.text}`);
        assert.equal(dim.quote.turnId, 't1');
      }
    }
  }
});

test('非法 JSON 一次：带整改反馈重试后通过', async () => {
  const out = await runReview({ ...input, channel: invalidJsonOnceChannel(basis, 'q1', ['t1'], 'raw'), maxRetries: 2 });
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') assert.equal(out.attempts, 2, '第二次应成功');
});

test('Schema 恒不合规：重试耗尽后降级「暂无法评价」，不伪造等级', async () => {
  const out = await runReview({ ...input, channel: schemaInvalidChannel(), maxRetries: 2 });
  assert.equal(out.kind, 'degraded');
  if (out.kind === 'degraded') {
    assert.equal(out.cause, 'schema_error');
    const check = validateContract('feedback', out.feedback);
    assert.equal(check.ok, true, '降级对象也必须通过 Schema');
    for (const dim of Object.values(out.feedback.dimensions)) {
      assert.equal(dim.level, '无法判断');
      assert.equal(dim.quote, null);
    }
    assert.match(out.feedback.reviewVersion, /^degraded:/);
  }
});

test('引用缺失一次：重试后通过（引用校验失败重试路径）', async () => {
  const out = await runReview({ ...input, channel: quoteMissingOnceChannel(basis, 'q1', ['t1'], 'raw'), maxRetries: 2 });
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') assert.equal(out.attempts, 2);
});

test('引用被改写（永远无法定位）：降级，不展示任何三档等级', async () => {
  const out = await runReview({ ...input, channel: quoteAlteredChannel(basis, 'q1', ['t1'], 'raw'), maxRetries: 2 });
  assert.equal(out.kind, 'degraded');
  if (out.kind === 'degraded') {
    assert.equal(out.cause, 'quote_not_locatable');
    for (const dim of Object.values(out.feedback.dimensions)) {
      assert.equal(dim.level, '无法判断', '引用定位失败不得展示等级');
    }
  }
});

test('D11：修订版作为基准时 textVersion 权威回填为 revised', async () => {
  const revised = '两周收到143篇投稿（已核对），比上期增长约八成。';
  const out = await runReview({ ...input, basisText: revised, textVersion: 'revised', channel: validChannel(revised, 'q1', ['t1'], 'revised') });
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') {
    assert.equal(out.feedback.reviewBasis.textVersion, 'revised');
    for (const dim of Object.values(out.feedback.dimensions)) {
      if (dim.quote) assert.equal(dim.quote.textVersion, 'revised');
    }
  }
});


test('引用坐标缺失或类型错误：可定位原话先权威回填再过完整契约', async () => {
  const fb = JSON.parse(buildValidReviewJson(basis, 'q1', ['t1'], 'raw'));
  for (const d of Object.values(fb.dimensions) as any[]) {
    if (!d.quote) continue;
    delete d.quote.start;
    d.quote.end = '错误坐标';
    delete d.quote.matchType;
    d.quote.textVersion = '错误版本';
  }
  const out = await runReview({ ...input, channel: { call: () => JSON.stringify(fb) } });
  assert.equal(out.kind, 'ok');
  assert.equal(out.attempts, 1);
  assert.equal(validateContract('feedback', out.feedback).ok, true);
  assert.equal(out.feedback.dimensions.relevance.quote?.text, fb.dimensions.relevance.quote.text);
  assert.equal(out.feedback.dimensions.relevance.reason, fb.dimensions.relevance.reason);
});

test('非对象 JSON 安全降级而不抛异常', async () => {
  for (const raw of ['null', '42', '"文本"', '[]']) {
    const out = await runReview({ ...input, channel: { call: () => raw } });
    assert.equal(out.kind, 'degraded', raw);
    if (out.kind === 'degraded') assert.equal(out.cause, 'schema_error');
  }
});

test('字段诊断保存字段路径和规则，不含模型内容或未知字段名', async () => {
  const fb = JSON.parse(buildValidReviewJson(basis, 'q1', ['t1'], 'raw'));
  delete fb.nextFacts;
  fb.dimensions.contribution.level = '私人内容不应进入诊断';
  fb['sk-private-unknown-property-123456'] = '敏感值';
  const attempts: any[] = [];
  const out = await runReview({ ...input, channel: { call: () => JSON.stringify(fb) }, onAttempt: (n, r) => attempts.push({ n, ...r }) });
  assert.equal(out.kind, 'degraded');
  assert.ok(attempts[0].issues?.some((i: any) => i.path === '/nextFacts' && i.rule === 'required'));
  assert.ok(attempts[0].issues?.some((i: any) => i.path === '/dimensions/contribution/level' && i.rule === 'enum'));
  const diagnostics = JSON.stringify(attempts.map(a => a.issues));
  assert.doesNotMatch(diagnostics, /私人|sk-private|敏感值/);
});

test('元数据回填不能修补内容、轮次身份或不存在的引用', async () => {
  for (const mutate of [
    (fb: any) => { delete fb.nextFacts; },
    (fb: any) => { fb.dimensions.relevance.quote.turnId = 't999'; },
    (fb: any) => { fb.dimensions.relevance.quote.text = '从未口述的虚构内容'; delete fb.dimensions.relevance.quote.start; },
    (fb: any) => { delete fb.dimensions.relevance.quote.turnId; },
  ]) {
    const fb = JSON.parse(buildValidReviewJson(basis, 'q1', ['t1'], 'raw'));
    mutate(fb);
    assert.equal((await runReview({ ...input, channel: { call: () => JSON.stringify(fb) } })).kind, 'degraded');
  }
});
