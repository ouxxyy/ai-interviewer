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
 * 5. normalized 命中后必须反算区间并自检 `fold(区间) === fold(引用)`；不成立即按 not_found 拒绝。
 *    因此 `located:true` ⇒ `end` 为整数且区间可折叠还原，不存在「含糊通过」路径。
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

/**
 * 折叠：去空白、全角→半角（FF01–FF5E）、ASCII 小写。返回折叠文本与到 NFC 文本的索引映射。
 *
 * 映射必须「按折叠后的码元」逐个 push 源索引：`toLowerCase()` 可能改变长度
 * （U+0130 `İ` → `i` + U+0307 是两个码元），只 push 一次会让 map 相对折叠文本整体错位，
 * 反算出的区间随之漂移。这是引用定位「100% 精确或明确拒绝」的底层不变量。
 */
function foldWithMap(s: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]!;
    if (/\s/.test(ch)) continue;
    const code = ch.codePointAt(0)!;
    if (code >= 0xff01 && code <= 0xff5e) ch = String.fromCodePoint(code - 0xfee0);
    const folded = ch.toLowerCase();
    for (let j = 0; j < folded.length; j++) map.push(i);
    text += folded;
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

  const nfcStart = basisFold.map[foldIdx];
  const nfcEndLast = basisFold.map[foldIdx + qFold.text.length - 1];
  // 防御性下界：map 与折叠文本现已等长，仍显式拒绝越界，绝不返回 NaN/undefined 区间。
  if (nfcStart === undefined || nfcEndLast === undefined) return { located: false, reason: 'not_found' };
  const nfcEnd = nfcEndLast + 1;

  // 反算区间自检（P0 修复）：折叠映射在个别字符上不是一一对应，
  // 只要反算出的区间折叠后还原不出引用，就明确拒绝而不是返回错位区间。
  // 不变量：located===true 的区间必然满足 fold(slice) === fold(quote)，且 end 为整数。
  if (foldWithMap(basis.text.slice(nfcStart, nfcEnd)).text !== qFold.text) {
    return { located: false, reason: 'not_found' };
  }

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

/**
 * 折叠文本（不含索引映射）。`matchType:"normalized"` 时 `quote.text` 与
 * `basisText.slice(start,end)` 不逐字相等（区间含被折叠掉的空白），消费方必须按本函数比较。
 */
export function foldText(s: string): string {
  return foldWithMap(nfcWithMap(s).text).text;
}
