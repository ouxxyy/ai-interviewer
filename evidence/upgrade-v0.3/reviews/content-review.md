# 内容 / T3 独立只读审查

最终复核结论：**spec compliance = PASS（本内容 / T3 审查范围）；code quality = PASS（本轮两项问题已关闭）**。下方保留首次发现与原始离线证据；关闭依据见本节。未实调模型、未改产品代码、未重复全量测试；整体产品复核另行进行。

## 修复关闭复核

1. **P1 CLOSED**：网页、Skill、Prompt 均调用 `src/review/feedback-source.ts::hasFeedbackSource()`。该函数逐一匹配正式 Feedback 的 topImprovement、factGaps、nextFacts 与维度 reason 的单个判断字段，不包含 JSON key、版本、ID、引文，不拼接不同字段。Skill 无来源候选走派生回退；Prompt 无来源报告 `reportValid=false`。
2. **P2 CLOSED**：`src/t3/run.ts` 新反馈与报告仅用 `validateContract` 现行 Schema；反馈另要求 `reviewVersion === PROMPT_VERSION`，保留正确 q/t、textVersion 与引用定位验证。旧契约和旧提示词版本各有独立回归，均不记介绍/经历已点评。
3. 已读最新 [任务文件：content-report.md] 的修复补段，核对源代码、三入口调用与新增回归。`integration-targeted-final.log` 实际为 39 tests / 39 pass / 0 fail / 0 skipped；`final-tests.log` 实际为 256 tests / 256 pass / 0 fail / 0 skipped，包含旧契约、旧 reviewVersion、metadata source 与网页维度 key 回归。日志为主代理执行证据，本复核未重新运行上述套件。
4. **独立重放原始反例**：`node /private/tmp/ai-interviewer-v03/content-review-closure-probe.mjs`，exit 0，使用最新工作区 dist。与首次探针完全相同的 metadata 恶意候选现在被 Skill 拒绝并派生真实反馈，Prompt reportValid=false；旧 0.2 Feedback 的 gaveFeedback / introductionReviewed / experienceReviewed 均 false。真实 API 调用数 0。
5. 关闭探针证据单独落在 `/private/tmp/ai-interviewer-v03/content-review-closure-probe/result.json` 与对应 transcript/raw 目录；首次证据保持原样。`git diff --check` exit 0；`git diff --name-only -- evidence/t3 evidence/t1r evidence/t2` 无输出，历史证据未改。
6. docs/rules 与两个文字入口的正式生成及磁盘一致性以主代理生成记录和 256/256 全量为依据。新版真实宿主、真实模型、质量标定与真人音频仍未验证，不把本轮关闭复核称为实时通过。

## 首次发现（历史记录，已关闭）

### [P1] 报告来源校验把 JSON 字段名当成已出现的判断

- 位置：`src/t3/run.ts:316`、`:433`；corpus 为 `JSON.stringify(reviewed/validFeedbacks)`。
- 触发：模型只输出优先练习点 `根据 textVersion 编造百万用户故障故事`。这句话既不来自正式反馈的判断文本，也没有对应事实；仅 `textVersion` 与序列化元数据键名共享四字。
- 实际离线结果：Skill 将该条写入正式报告，`report.source=model_priority_practice`；Prompt 的 `closedLoop` 八个布尔值全为 `true`，包括 `reportValid`。
- 影响：要求的「来自已出现的判断」来源边界能被 JSON 元数据绕过，编造请求亦进入报告；当前无来源测试只用完全不含 JSON key 的候选，没有覆盖这一场景。
- 建议：四字匹配仅针对已校验 Feedback 的判断文本字段（reason、factGaps、topImprovement、nextFacts 等实际内容），不包含 JSON key、ID、版本、枚举等技术元数据；不要靠 JSON 字符串作来源 corpus。Skill 拒绝后走已有派生回退；Prompt 记 `reportValid=false`。增加两入口最小离线回归。

### [P2] 新版 Prompt 将旧版反馈算作已完成介绍 / 经历

- 位置：`src/t3/run.ts:407`；新运行使用历史复核用的 `validateContractAuto('feedback', ...)`。
- 触发：四项现行计划正常，宿主返回 `contractVersion=0.2.0`、`reviewVersion=prompts@0.2.0` 的反馈，当前 q/t 身份和引用都合法。
- 实际离线结果：`introductionReviewed`、`experienceReviewed`、`gaveFeedback`、`feedbackHasAllFiveDims`、`quotedVerbatim` 全为 `true`；rawFeedbackVersion 为 `0.2.0`。最终新报告嵌套反馈 Schema 兜底，`reportValid=false`，所以没有整个报告误判通过，但已点评统计已被旧证据污染。
- 建议：新运行写入使用 `validateContract` 当前版（或明确要求 claimedVersion === CONTRACT_VERSION）；Auto 保留在显式历史复核路径。把旧版反馈/当前 q/t 引用的离线场景加入回归。`reviewVersion` 的当前版本一致性也应明确核对，不能只靠非空字符串 Schema。

## 最小离线探针与证据

- 命令：`node /private/tmp/ai-interviewer-v03/content-review-probe.mjs`
- 结果：exit 0；无真实模型调用（注入离线 complete / completeChat），在 `/private/tmp` 归档 Skill、Prompt、旧版 Prompt 三场的原始 transcript / raw 输出与派生报告。
- 探针引用任务实现者的独立编译产物 `content-green/src/t3/run.js`，未使用工作区可能较旧的 dist。
- 结果文件：`/private/tmp/ai-interviewer-v03/content-review-probe/result.json`。
- 原始证据：`.../skill/{evidence,data}`、`.../prompt/evidence/prompt/transcript.json`、`.../legacy/evidence/prompt/transcript.json`。

## 已符合部分

1. `INTRODUCTION_DIMENSIONS` 与 `introductionRubric()` 是介绍五维唯一源，规则正文、contextBlock、Skill、Prompt 都从该源渲染；经历五维保留原意义。
2. 四项冻结计划 / q1 introduction + q2–q4 experience / 每项最多两追问 / 重答零追问 / 介绍不强制限时 / 介绍无需完整项目反思均明确表达；材料只作岗位判断语境，当前题已确认回答作事实证据。
3. 共用红线直接引用 rules.ts，未改变入口结构操作提示的正文地位。现行四模板合法 JSON、介绍语境、报告零/部分/最后一题完成分支有针对性测试覆盖。
4. Skill 默认跑四项，显式 endEarly 才跑前两项；计划共享校验拒绝假来源；降级传 reviewValid=false，不记正式完成；重答最终版与唯一 tN 身份一致；正确传 questionId/context，报告条目含 kind，初答/重答均展示。
5. Prompt 真正问介绍和一经历题，来源从原始宿主输出/计划共享校验/Feedback 引用定位/报告原样回填推出，不再把散文或材料引用算正式反馈；上述 P1/P2 是其剩余边界。
6. 新版 CLI evidence/data/hosts/manifest 路径按版本隔离，旧 raw 只读；缺新版宿主原始输出标未验证，旧 0.2 宿主声明不能通过 0.3 检查；Claude 无稳定最终块协议时保守未验证。
7. CLI experiment/experiment:dry 在 env/证据/模型步骤前明确拒绝；直接结构实验也先比预登记版本，冻结旧路径和实验判据未修改。
8. 八类 synthetic 介绍/经历案例均标未标定，不宣称模型质量；既有 24 案例保留。网页 qid 集成提醒按主代理已修复处理，不重复列为问题。

## 已有验证记录复核

读取原日志，未重新执行：`content-targeted-final.log` 为 26 tests / 26 pass / 0 fail；`content-core-context.log` 为 1 test / 1 pass / 0 fail。报告明确生成物磁盘一致性由主代理统一生成与最终全量检查；真实新版宿主、真实文本模型和质量标定均未验证。

本审查另执行 `git diff --check`，exit 0。未执行付费调用、线上操作、push、改规则或生成正式入口文件。


归档说明：本机用户路径及临时任务文件标识已脱敏；技术位置、命令与结果保留。原始报告仍保存在本地临时目录。
