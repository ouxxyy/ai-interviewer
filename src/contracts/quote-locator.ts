/**
 * 引用定位器（docs/contracts.md §引用定位规则）。
 *
 * 规则：
 * 1. 基准文本＝该题评审对象（D1 合并文本；D11 修订版优先），引用必须落在基准文本内。
 * 2. 两级匹配，均取首次出现（确定性）：
 *    a. exact：NFC 归一后逐字符一致；
 *    b. normalized：折叠空白（JS \s 覆盖的 Unicode 空白）、全角 ASCII 区 U+FF01–U+FF5E 折半角、
 *       ASCII 字母小写后匹配，命中后映射回原始字符区间。
 *    CJK 专有标点（、。「」等 U+3000–U+303F）不折叠，视为不同字符。
 * 3. start/end 为基准文本（NFC 归一后）的字符偏移，区间为 [start, end)。
 * 4. 空引用、长度 <2、找不到 → 明确拒绝（located:false），禁止模糊通过。
 */
import type { QuoteLocation } from './types.js';

/** NFC 归一并返回归一文本到原文本的索引映射。 */
function nfcWithMap(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  for (let i = 0; i < s.length; i++) {
    const chunk = s[i]!.normalize('NFC');
    for (let j = 0; j < chunk.length; j++) map.push(i);
    text += chunk;
  }
  return { text, map };
}

/** 折叠：去空白、全角→半角（FF01–FF5E）、ASCII 小写。返回折叠文本与到 NFC 文本的索引映射。 */
function foldWithMap(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]!;
    if (/\s/.test(ch)) continue;
    const code = ch.codePointAt(0)!;
    if (code >= 0xff01 && code <= 0xff5e) ch = String.fromCodePoint(code - 0xfee0);
    ch = ch.toLowerCase();
    map.push(i);
    text += ch;
  }
  return { text, map };
}

export function locateQuote(basisText: string, quote: string): QuoteLocation {
  if (quote.length === 0) return { located: false, reason: 'empty_quote' };
  if (quote.length < 2) return { located: false, reason: 'quote_too_short' };

  const basis = nfcWithMap(basisText);
  const q = nfcWithMap(quote);
  if (q.text.length < 2) return { located: false, reason: 'quote_too_short' };

  // 第一级：exact
  const exactIdx = basis.text.indexOf(q.text);
  if (exactIdx >= 0) {
    return {
      located: true,
      start: exactIdx,
      end: exactIdx + q.text.length,
      matchType: 'exact',
    };
  }

  // 第二级：normalized（空白/全角半角/大小写差异容忍）
  const basisFold = foldWithMap(basis.text);
  const qFold = foldWithMap(q.text);
  if (qFold.text.length === 0) return { located: false, reason: 'not_found' };
  const foldIdx = basisFold.text.indexOf(qFold.text);
  if (foldIdx < 0) return { located: false, reason: 'not_found' };

  const nfcStart = basisFold.map[foldIdx]!;
  const nfcEnd = basisFold.map[foldIdx + qFold.text.length - 1]! + 1;
  return {
    located: true,
    start: nfcStart,
    end: nfcEnd,
    matchType: 'normalized',
  };
}

/** 定位校验辅助：按 QuoteRef 重建区间文本并与引用比对（供评审流水线复核）。 */
export function sliceByLocation(basisText: string, start: number, end: number): string {
  const basis = nfcWithMap(basisText);
  return basis.text.slice(start, end);
}
