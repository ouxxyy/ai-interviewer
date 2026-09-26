import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReview } from '../src/review/reviewer.js';
import { validChannel, invalidJsonOnceChannel, schemaInvalidChannel, quoteMissingOnceChannel, quoteAlteredChannel } from '../src/review/fixtures.js';
import { validateContract } from '../src/contracts/validate.js';
import { sliceByLocation } from '../src/contracts/quote-locator.js';

const basis = '我负责毕业季征稿，前期用问卷收集了两百份偏好，活动两周收到一百四十三篇投稿，比上一期增长约八成，复盘后我补了投稿指引。';
const input = {
  basisText: basis,
  turnIds: ['t1'],
  textVersion: 'raw' as const,
  questionId: 'q1',
};

test('有效输出：一次通过，引用被权威重定位且可逐字还原', () => {
  const out = runReview({ ...input, channel: validChannel(basis, 'q1', ['t1'], 'raw') });
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

test('非法 JSON 一次：带整改反馈重试后通过', () => {
  const out = runReview({ ...input, channel: invalidJsonOnceChannel(basis, 'q1', ['t1'], 'raw'), maxRetries: 2 });
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') assert.equal(out.attempts, 2, '第二次应成功');
});

test('Schema 恒不合规：重试耗尽后降级「暂无法评价」，不伪造等级', () => {
  const out = runReview({ ...input, channel: schemaInvalidChannel(), maxRetries: 2 });
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

test('引用缺失一次：重试后通过（引用校验失败重试路径）', () => {
  const out = runReview({ ...input, channel: quoteMissingOnceChannel(basis, 'q1', ['t1'], 'raw'), maxRetries: 2 });
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') assert.equal(out.attempts, 2);
});

test('引用被改写（永远无法定位）：降级，不展示任何三档等级', () => {
  const out = runReview({ ...input, channel: quoteAlteredChannel(basis, 'q1', ['t1'], 'raw'), maxRetries: 2 });
  assert.equal(out.kind, 'degraded');
  if (out.kind === 'degraded') {
    assert.equal(out.cause, 'quote_not_locatable');
    for (const dim of Object.values(out.feedback.dimensions)) {
      assert.equal(dim.level, '无法判断', '引用定位失败不得展示等级');
    }
  }
});

test('D11：修订版作为基准时 textVersion 权威回填为 revised', () => {
  const revised = '两周收到143篇投稿（已核对），比上期增长约八成。';
  const out = runReview({ ...input, basisText: revised, textVersion: 'revised', channel: validChannel(revised, 'q1', ['t1'], 'revised') });
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') {
    assert.equal(out.feedback.reviewBasis.textVersion, 'revised');
    for (const dim of Object.values(out.feedback.dimensions)) {
      if (dim.quote) assert.equal(dim.quote.textVersion, 'revised');
    }
  }
});
