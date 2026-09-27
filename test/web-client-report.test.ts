/**
 * 引用定位坐标系的回归测试（P1-3）。
 *
 * 服务端契约（`src/contracts/quote-locator.ts`）把 start/end 定义为**NFC 归一后基准文本**的偏移。
 * 前端曾经直接 `basis.text.slice(start, end)` 并自己写了一份 fold，于是：
 * - 基准文本里存在需要 NFC 归一（长度会变）的字符时，偏移整体错位，合法锚点被误判为不可信；
 * - 折叠逻辑两份实现，任何一侧调整都会静默让引用渲染与评审对不上。
 * 这里直接拿契约定位器的输出喂给前端复核器，要求两端完全一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateQuote, foldText as contractFold } from '../src/contracts/quote-locator.js';
import { foldText, verifiedQuote } from '../web-client/src/lib/report.js';
import type { QuoteRef, ReviewBasisDetail } from '../web-client/src/types.js';

function basis(text: string): ReviewBasisDetail {
  return { questionId: 'q1', text, turnIds: ['t1'], textVersion: 'raw' };
}

function quoteFrom(basisText: string, text: string): QuoteRef {
  const located = locateQuote(basisText, text);
  assert.equal(located.located, true, `契约定位器必须能定位「${text}」`);
  return {
    text,
    start: located.start!,
    end: located.end!,
    turnId: 't1',
    textVersion: 'raw',
    matchType: located.matchType!,
  };
}

test('P1-3：基准文本需要 NFC 归一（长度变化）时，前端必须接受服务端给出的合法锚点', () => {
  // U+0344（COMBINING GREEK DIALYTIKA TONOS）NFC 后展开成两个码元，后面的偏移整体 +1。
  const basisText = 'X\u0344abc';
  const quote = quoteFrom(basisText, 'abc');

  // 记录这个样例确实是「偏移错位」型的：原文按同一区间切出来不是引用文本。
  assert.notEqual(basisText.slice(quote.start, quote.end), 'abc');
  // 旧实现（原文 slice 后严格比较）在这里返回 null，会把合法锚点丢掉。
  assert.notEqual(verifiedQuote(basis(basisText), quote), null);
});

test('P1-3：normalized 引用必须按折叠后比较，且不放松到不同文本', () => {
  const basisText = '我先　做了 用户调研ABC，然后排期。';
  const quote = quoteFrom(basisText, '先 做了用户调研abc');
  assert.equal(quote.matchType, 'normalized');
  assert.notEqual(verifiedQuote(basis(basisText), quote), null);

  const wrong: QuoteRef = { ...quote, text: '先 做了用户调研abd' };
  assert.equal(verifiedQuote(basis(basisText), wrong), null);
});

test('P1-3：exact 引用要求逐字一致；越界、空区间、非法区间一律拒绝', () => {
  const text = '我负责排期和跨组协调。';
  const exact = quoteFrom(text, '负责排期');
  assert.equal(verifiedQuote(basis(text), exact)?.text, '负责排期');
  assert.equal(verifiedQuote(basis(text), { ...exact, text: '负责排期' + '！' }), null);
  assert.equal(verifiedQuote(basis(text), { ...exact, start: 100, end: 104 }), null);
  assert.equal(verifiedQuote(basis(text), { ...exact, start: 2, end: 2 }), null);
  assert.equal(verifiedQuote(basis(text), { ...exact, start: -1, end: 4 }), null);
  assert.equal(verifiedQuote(basis(text), { ...exact, start: 1.5, end: 4 }), null);
  assert.equal(verifiedQuote(undefined, exact), null);
  assert.equal(verifiedQuote(basis(text), null), null);
});

test('P1-3：前端折叠函数与服务端契约逐字等价（不再有第二把尺子）', () => {
  const samples = [
    'ＡＢＣ　全角',
    'İstanbul 与 ﬁ 连字',
    '多行\n文本\t带空白',
    '𝕏 代理对 😀',
    '混合：Ｈｅｌｌｏ　　世界',
  ];
  for (const sample of samples) {
    assert.equal(foldText(sample), contractFold(sample), `折叠结果必须一致：${sample}`);
  }
});
