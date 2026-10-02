# 契约说明（contract@0.3.0）

五个契约对象的 JSON Schema 位于 `src/contracts/schemas/`（**四环节训练版 0.3.0**），
TypeScript 类型见 `src/contracts/types.ts`，校验器 `src/contracts/validate.ts`
（独立 CLI：`npm run validate -- <file.json> <contract-name> [0.3.0|0.2.0|0.1.0]`）。
本文件记录 Schema 之外必须共同遵守的口径。

**三版本并存**：现行 `0.3.0` 新增自我介绍与题型，不能和旧版宣称结构相同。`0.1.0` 与 `0.2.0` 的五个 Schema 分别原样留档，二者仍**只差版本号**。保留名为 `assertLegacyMatchesCurrent()` 的兼容接口，但其加载时断言明确比较历史 `0.1.0` 与 `0.2.0`；当前结构变化独立校验。历史证据仍由 `validateContractAuto()` 按声明版本验证，未知版本明确拒绝，不改写旧记录。

**相关文档**：产品决策冻结登记见 `docs/decisions.md`（D1–D11）；
三入口共用规则正文见 `docs/rules.md`（由 `src/rules/rules.ts` 生成，带版本号与 sha256 摘要）。

## 四环节计划与题型

- 当前 `QuestionPlan.questions` 恰好四项，顺序与 ID 固定：`q1/introduction`、`q2/experience`、`q3/experience`、`q4/experience`；`kind` 是显式字段，不从题目措辞猜测。
- 材料确认后一次生成全部计划；自我介绍的新信息用于本环节追问，不改写后三道经历题。
- `validateQuestionPlan()` 在 Schema 之后校验重复题和 `sourceExcerpt`。来源须在 JD 或经历**某一份单独原文**中连续定位，不能跨材料拼接；仅改变行首编号、空白、大小写或标点不能算新题。
- 自我介绍默认必练，建议 1–2 分钟，不强制限时；练岗位定位、真实亮点与个人价值，不要求完整项目复盘。

网页出题自 `web-plan@0.3.3` 增加模型传输适配：模型可返回本次原文目录中的 `sourceId`，应用回填为 `sourceExcerpt` 后才调用共享 `validateQuestionPlan()`。`sourceId` 不进入正式契约、前端或持久计划；不存在的编号及同时提交两种来源字段均拒绝。旧式摘录仍须通过原严格定位。正式契约字段、历史版本和校验标准不变，详见 `docs/plan-source-fix-v0.3.3.md`。

## 岗位语境与事实证据

追问和评审新增 `context: InterviewContext`，包含题型 `kind`、岗位 `jd`、求职阶段 `stage`、`targetRole` 和当前题 `intent`。它用于理解岗位要求和问题目的，不属于回答证据。新网页与文字运行路径必须传入；旧标定调用可缺省，保留经历题口径。

贡献、结果和引用只取当前题已确认回答。简历写过但回答未提及的事、其他题回答、模型建议或招聘目的猜测，都不能补进当前题事实。缺少证明时写证据缺口，不推断没有能力；招聘可能解决的问题须标为假设。自我介绍沿用五维但按题型解释，统一定义进入规则正文，不在入口另建尺子。

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

2026-10-02 评审恢复修复：先确认 JSON 根为对象，再按已知题目/轮次回填元数据。对于 turnId 属于本题且原话可定位的引用，先计算 `start/end/matchType/textVersion`，再执行完整 Schema 和引用检查；不因模型漏报这些应用可计算字段而拒绝有效原话。缺失引用正文、轮次身份、等级、理由、事实缺口或建议仍拒绝，正式 Feedback 契约与内容规则不变。

**不代写**：`dimensions[].level` / `reason` / `quote.text`、`factGaps`、`topImprovement`、`nextFacts`
一律以模型输出为准；缺失或不合规就走重试，重试耗尽即降级「暂无法评价」，绝不由应用编造内容。

**T3 Prompt 验收的两层判定**（`prompts@0.3.1`）：运行器先严格校验原始 Feedback 的内容与版本/题目/轮次身份，只对在当前题回答中可定位的引用重算 `start/end/matchType`。保留 `rawFeedback`、`rawFeedbackValid` 和自报坐标，另存应用可用的 `feedback`/`feedbackValid`；`rawClosedLoop` 与 `closedLoop` 分开记录。不能把应用辅助通过宣称为普通聊天原始输出或原生宿主通过；身份错误、内容缺失、错引材料仍拒绝，不能自动补 `nextFacts`。报告按完整契约输出，不删非法字段或替模型改状态。

T3 新证据按契约＋提示词版本隔离；每次付费运行另建 `runs/<runId>`，免费生成与 manifest 不覆盖已有真实运行。Prompt 闭环任一必验项失败，CLI 保留失败证据并退出1，HTTP200或进程执行结束不能替代验收。

## 流程控制（状态机，D2/D5/D6）

- 状态：`materials_review → question → answer → followup? → review → rewrite? → next_question | report → ended`。
- 四环节均每题追问 0–2 次；重答每题 ≤1 次；**重答轮 0 追问**（D5）。
- 完成数在有效点评时计算，不等点击下一题；重答不重复计数。新确认的重答或修订使旧反馈失效；评审失败或降级不能沿用旧等级计作成功。`REVIEW_DONE` 的 `reviewValid` 标记由运行器依据评审结果写入。
- 提前结束/零完成也生成报告（D6）：`priorityPractice = ["本次未完成任何题目，无有效反馈"]`。
- 实时语音模型只管听说；是否追问、何时点评、何时下一题全部由文本层产出候选＋应用状态机裁决。

## 报告与历史

- 当前 `SessionReport` 固定四条 `perQuestion`，每条含 `kind`，ID/题型顺序与计划相同。`completedQuestions` 等于 `reviewed` 条目数；四项全部有效才是 `completed`，其余为 `ended_early`。未点评条目不能携带反馈或重答结论。
- 报告仅回填最新且已通过契约和引用校验的正式反馈；降级提示可在会话页呈现，但不计正式完成。网页保留练习点的来源验证与 `reportSource`。
- 产品展示“自我介绍状态＋经历题 x/3”，经历五维汇总排除介绍；所有环节的重答对比均分别展示。
- 历史列表新增 `introductionStatus`、`completedExperienceQuestions`、`totalExperienceQuestions`。旧三题记录没有介绍，显示 `not_included`；旧材料、计划、报告与轮次保持原版本，不写回新字段或新版本号。SQLite 表结构不因第四环节迁移。

## 版本

| 版本号 | 对象 | 说明 |
| --- | --- | --- |
| `contract@0.3.0` | 五对象 Schema ＋ TS 类型 | 四环节、显式题型、报告计数与历史兼容；新写入使用此版 |
| `contract@0.2.0` | 同上（留档） | 历史 T2 定稿；与 0.1.0 只差版本号，仍可校验 |
| `contract@0.1.0` | 同上（留档） | T1 期证据记录的版本；只读留档，不用于新写入 |
| `rules@0.3.0` | 三入口共用训练规则正文 | 唯一源 `src/rules/rules.ts`；生成正文、摘要及入口，包含按题型使用五维与岗位/经历分析边界 |
| `prompts@0.3.2` | 当前中文提示词 | 保持规则与契约0.3.0；收紧全部反馈字段的事实边界与禁止局部示范句，未实调、质量未标定 |
| `prompts@0.3.1` | 历史中文提示词 | 补齐字段/报告形状；实调结构与应用辅助引用通过，但介绍建议内容越界，原始证据保留 |
| `prompts@0.3.0` | 历史中文提示词 | 首次四环节文本实调失败原样保留，不能借新版本回放改变结论 |

**标定状态**：当前 0.3 提示词质量仍「**未标定**」。历史 T2 结构标定对应旧提示词，不证明新介绍与岗位语境的档位准确性。新增固定合成案例、离线校验和 mock 流程也不能替代真实模型质量标定。
