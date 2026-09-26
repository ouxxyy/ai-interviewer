# 契约说明（contract@0.1.0）

五个契约对象的 JSON Schema 冻结于 `src/contracts/schemas/`，TypeScript 类型见 `src/contracts/types.ts`，校验器 `src/contracts/validate.ts`（独立 CLI：`npm run validate -- <file.json> <contract-name>`）。本文件记录 Schema 之外必须共同遵守的口径。

## 评审对象口径（D1/D11）

- 每题评审对象＝该题全部已确认回答轮次按时间顺序合并的文本。
- 用户修订过任一轮次时，该轮以修订版计入合并文本（`textVersion: "revised"`），原始转写保留但不再作为评审对象。
- 重答后以重答版为最终版，初答版仅用于对比视图。

## 引用定位规则（quote-locator）

`locateQuote(basisText, quote)` 的行为契约：

1. **基准文本**：引用必须落在评审对象（合并文本）内；`start`/`end` 为基准文本按 NFC 归一后的字符偏移，区间为 `[start, end)`。
2. **两级匹配，取首次出现**（确定性，多处命中不歧义）：
   - `exact`：NFC 归一后逐字符一致；
   - `normalized`：折叠以下差异后匹配，并映射回原区间——空白差异（JS `\s` 覆盖的 Unicode 空白，含换行）、全角 ASCII 区 U+FF01–U+FF5E 与半角互认、ASCII 字母大小写。
3. **CJK 专有标点不折叠**：`、。「」` 等 U+3000–U+303F 视为不同字符——引用与原文差一个字即拒绝。
4. **明确拒绝**：空引用、长度 <2、找不到 → `located:false` + reason（`empty_quote` / `quote_too_short` / `not_found`）。**禁止模糊通过**；引用定位失败时该维度不展示等级（降级「暂无法评价」）。
5. **应用层权威重定位**：评审流水线以定位器结果覆盖模型自报的区间与 `matchType`，杜绝自报漂移。
6. **消费方注意**：`matchType:"normalized"` 时 `quote.text` 与 `basisText.slice(start,end)` **不逐字相等**——区间包含被折叠掉的空白（及其他被容忍的差异）。消费方（如 T3 的高亮渲染、重答对比）必须按 `foldText()` 比较，不得对该区间做严格字符串相等判定；只有 `matchType:"exact"` 才能逐字相等。
7. **自检不变量（P0 修复）**：`normalized` 命中后反算区间，并自检 `foldText(basisText.slice(start,end)) === foldText(quote.text)`；不成立即返回 `located:false / not_found`。因此 `located:true` ⇒ `end` 为整数且区间可折叠还原，不存在含糊通过路径。

## 评审流水线的权威回填（T1-R）

**元数据由应用层写，内容由模型写。** 下列字段的值由应用层完全掌握，模型漏写或写错都不该导致整份重试，
更不该采信模型自报，因此在校验**之前**一律由应用层覆盖：

| 字段 | 权威值来源 | 理由 |
| --- | --- | --- |
| `contractVersion` | `CONTRACT_VERSION` | 用的哪版契约是应用事实 |
| `reviewVersion` | `PROMPT_VERSION` | 这次评审由哪版提示词产出是应用事实 |
| `questionId` | 调用方入参 | 评审的是哪道题由应用状态机决定 |
| `reviewBasis.turnIds` / `textVersion` | 调用方入参（D1/D11） | 评审对象口径由应用决定 |
| `dimensions[].quote.start/end/matchType` | 引用定位器计算结果 | 应用层权威重定位（见上节第 5 条） |

**不代写**：`dimensions[].level` / `reason` / `quote.text`、`factGaps`、`topImprovement`、`nextFacts`
一律以模型输出为准；缺失或不合规就走重试，重试耗尽即降级「暂无法评价」，绝不由应用编造内容。

## 流程控制（状态机，D2/D5/D6）

- 状态：`materials_review → question → answer → followup? → review → rewrite? → next_question | report → ended`。
- 每题追问 0–2 次上限硬编码；重答每题 ≤1 次；**重答轮 0 追问**（D5）。
- 提前结束/零完成也生成报告（D6）：`priorityPractice = ["本次未完成任何题目，无有效反馈"]`。
- 实时语音模型只管听说；是否追问、何时点评、何时下一题全部由文本层产出候选＋应用状态机裁决。

## 版本

- `contract@0.1.0`：五对象 Schema（T1-S 冻结，T2 正式定稿后升版）。
- `rules@0.1.0-t1s`：三入口共用训练规则文本版本。
- `prompts@0.1.0-t1r`：中文提示词 v1 版本（**未标定**——标定需真实模型输出，属 T1-R / T2）。T1-R 起四个模板内嵌的 JSON 示例**自身即通过对应 Schema**（由 `test/prompts-align.test.ts` 抽取后调用 `validateContract` 强制），占位符统一写作 `<…>`，模型不得照抄。
