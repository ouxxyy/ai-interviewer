import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateQuote, sliceByLocation } from '../src/contracts/quote-locator.js';

const basis = '我负责毕业季征稿，两周收到一百四十三篇投稿，比上期增长约八成。';

test('精确匹配：原话片段逐字定位，返回首次出现区间', () => {
  const r = locateQuote(basis, '两周收到一百四十三篇投稿');
  assert.deepEqual(r, { located: true, start: 9, end: 21, matchType: 'exact' });
  assert.equal(sliceByLocation(basis, 9, 21), '两周收到一百四十三篇投稿');
});

test('多处命中取首次出现（确定性）', () => {
  const text = '他说好的，我们说好的就算数。';
  const r = locateQuote(text, '说好的');
  assert.equal(r.located, true);
  assert.equal(sliceByLocation(text, (r as { start: number }).start, (r as { end: number }).end), '说好的');
});

test('空白差异：跨换行/多空格容忍（normalized）', () => {
  const text = '前期调研\n\n做了问卷，收集了两百份 回复。';
  const r = locateQuote(text, '调研 做了问卷');
  assert.equal(r.located, true);
  if (r.located) {
    assert.equal(r.matchType, 'normalized');
    const sliced = sliceByLocation(text, r.start, r.end).replace(/\s+/g, '');
    assert.equal(sliced, '调研做了问卷');
  }
});

test('全角半角与大小写差异容忍（normalized）', () => {
  const text = 'GMV是8万元，ＧＭＶ口径含退款前。';
  const r1 = locateQuote(text, 'ｇｍｖ是8万元');
  assert.equal(r1.located, true);
  const r2 = locateQuote(text, 'GMV口径');
  assert.equal(r2.located, true);
  if (r2.located) assert.equal(r2.matchType, 'normalized');
});

test('CJK 专有标点不折叠：改字即拒绝，不含糊通过', () => {
  const text = '先做调研、再上线。';
  const r = locateQuote(text, '先做调研,再上线'); // 半角逗号 vs 顿号：不同字符
  assert.equal(r.located, false);
  if (!r.located) assert.equal(r.reason, 'not_found');
});

test('引用被改写一个字：明确拒绝', () => {
  const r = locateQuote(basis, '两周收到一百四十篇投稿'); // 少了“三”
  assert.deepEqual(r, { located: false, reason: 'not_found' });
});

test('空引用与过短引用：明确拒绝', () => {
  assert.deepEqual(locateQuote(basis, ''), { located: false, reason: 'empty_quote' });
  assert.deepEqual(locateQuote(basis, '我'), { located: false, reason: 'quote_too_short' });
});

test('修订版基准切换（D11）：引用只在修订版中可定位', () => {
  const raw = '两周收到一百四十三篇投稿';
  const revised = '两周收到143篇投稿（数据已核对）';
  assert.equal(locateQuote(raw, '数据已核对').located, false);
  assert.equal(locateQuote(revised, '数据已核对').located, true);
});

test('构造样本集：20 个真实子串引用 100% 定位（T1-S 验收线）', () => {
  const longText = '我负责毕业季征稿活动。前期用问卷收集了两百份同学偏好，把主题定为毕业故事。我联系了五个院系的宣传委员扩散，自己写了两篇范文冷启动。活动两周收到一百四十三篇投稿，比上一期增长约八成。复盘发现初审通过率只有六成，因为投稿规则没写清字数要求，我补了一份投稿指引，下一期通过率提到八成五。';
  let locatedCount = 0;
  for (let len = 2; len <= 20; len += 2) {
    for (let start = 0; start + len <= longText.length; start += 7) {
      const quote = longText.slice(start, start + len);
      const r = locateQuote(longText, quote);
      if (r.located) {
        locatedCount++;
        assert.equal(sliceByLocation(longText, r.start, r.end), quote, `子串 [${start},${start + len}) 必须逐字还原`);
        assert.equal(r.matchType, 'exact');
      } else {
        assert.fail(`真实子串被拒绝: ${quote}`);
      }
    }
  }
  assert.ok(locatedCount >= 20, `样本数 ${locatedCount} 应不少于 20`);
});
