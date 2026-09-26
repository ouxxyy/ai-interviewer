import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateQuote, sliceByLocation, foldText } from '../src/contracts/quote-locator.js';

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

/**
 * P0 回归（reviewer 2026-09-26 报告）：`foldWithMap` 每个源字符只 push 一个映射项，
 * 而 `İ`（U+0130）的小写是 `i` + U+0307 两个码元，导致折叠索引整体错位、反算区间漂移甚至 end=NaN，
 * 流水线却仍判 ok。修复后：映射与折叠文本等长，且反算区间必须通过折叠还原自检，否则明确拒绝。
 */
test('P0 回归：İ（小写后变长）＋空白差异不得错位，end 必须是整数且区间可还原', () => {
  const text = 'İstanbul 项目';
  const r = locateQuote(text, 'İstanbul项目'); // 仅空白差异
  assert.equal(r.located, true, '仅空白差异应可定位');
  if (!r.located) return;
  assert.equal(r.matchType, 'normalized');
  assert.equal(Number.isInteger(r.end), true, `end 必须是整数，实际 ${String(r.end)}`);
  assert.equal(Number.isInteger(r.start), true, `start 必须是整数，实际 ${String(r.start)}`);
  assert.equal(r.start, 0);
  assert.equal(r.end, 11, '区间应覆盖到「目」为止（含被折叠掉的那个空格）');
  // 不变量：normalized 区间按折叠比较必须还原为引用
  assert.equal(foldText(sliceByLocation(text, r.start, r.end)), foldText('İstanbul项目'));
  // 且区间确实包含被折叠掉的空白（因此不得对 normalized 结果做逐字相等判定）
  assert.notEqual(sliceByLocation(text, r.start, r.end), 'İstanbul项目');
});

test('P0 回归：İ 出现在长句开头时，后续中文区间不漂移', () => {
  const text = 'İstanbul 项目复盘由我负责。';
  const r = locateQuote(text, 'İstanbul项目复盘');
  assert.equal(r.located, true);
  if (!r.located) return;
  assert.equal(Number.isInteger(r.end), true);
  assert.equal(sliceByLocation(text, r.start, r.end), 'İstanbul 项目复盘', '区间应恰好覆盖到「盘」，不多不少');
  assert.equal(foldText(sliceByLocation(text, r.start, r.end)), foldText('İstanbul项目复盘'));
});

test('P0 回归：折叠后落在展开字符中间时明确拒绝，不含糊通过', () => {
  const text = 'İstanbul 项目';
  // 引用以组合点 U+0307 开头：折叠文本里能匹配上，但无法对应到合法源区间 → 必须拒绝
  const r = locateQuote(text, '\u0307stanbul项目');
  assert.deepEqual(r, { located: false, reason: 'not_found' });
});

test('P0 不变量：任意输入下 located 结果都满足「整数区间 + 可还原」，否则一律拒绝', () => {
  const bases = [
    'İstanbul 项目',
    'İİİ 连续大写点',
    '我负责毕业季征稿，两周收到一百四十三篇投稿。',
    'ＧＭＶ\n与 gmv 口径不同',
    'ﬁ ligature 与 ﬃ',
  ];
  const quotes = ['İ', 'İstanbul项目', 'İİİ连续', 'gmv口径', 'ﬁ ligature', 'ﬃ', '两周 收到', '一百四十三篇'];
  let located = 0;
  for (const basis of bases) {
    for (const q of quotes) {
      const r = locateQuote(basis, q);
      if (!r.located) {
        assert.ok(['empty_quote', 'quote_too_short', 'not_found'].includes(r.reason), `拒绝原因必须明确：${String(r.reason)}`);
        continue;
      }
      located++;
      assert.equal(Number.isInteger(r.start) && Number.isInteger(r.end), true, `区间必须为整数：${basis} / ${q}`);
      assert.ok(r.end > r.start && r.end <= basis.normalize('NFC').length, `区间必须落在基准文本内：${basis} / ${q}`);
      const sliced = sliceByLocation(basis, r.start, r.end);
      if (r.matchType === 'exact') {
        assert.equal(sliced, q.normalize('NFC'), `exact 必须逐字还原：${basis} / ${q}`);
      } else {
        assert.equal(foldText(sliced), foldText(q), `normalized 必须折叠还原：${basis} / ${q}`);
      }
    }
  }
  assert.ok(located > 0, '样本中应至少有若干条可定位，避免测试空转');
});
