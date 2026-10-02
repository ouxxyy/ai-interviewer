# 核心任务独立复核

修复复核后的结论：**Spec compliance = PASS（核心任务自身范围；跨任务集成仍待验证）；Code quality = PASS（唯一 P2 已关闭，本次复核未发现新增重要问题）。**

复核范围：`[任务文件：core.md]`、`shared.md`、`[任务文件：core-report.md]`、`core.diff`，以及契约／状态机／web runner／store 的当前源码与对应测试。已读项目执行计划、reference audit、contracts 文档。只读检查产品代码；未修改源码、未重复运行已完成的全量或 targeted 套件、未调用真实模型、未访问线上。仅运行了一个此前没有覆盖的重复题最小离线探针，并独立比较了旧 Schema 字节。

## 已关闭的缺陷与修复复核

### [P2] 常见裸数字编号可绕过重复题检查 — 已修复

位置：`src/contracts/question-plan.ts:15–17`。

首次复核时归一只去掉 `第3题`／`q3` 等前缀；`3.`／`3、`／`（3）` 等常见编号保留数字。因而两道经历题仅加编号就被视为不同题：

```text
q2: 请讲讲在活动中的个人贡献？
q3: 3. 请讲讲在活动中的个人贡献？
```

在其余四条计划结构及来源合法的情况下，首次复核离线直接调用 `validateQuestionPlan` 得到 `{ok:true, errors:[]}`。把 q3 改为 `第3题：请讲讲在活动中的个人贡献？` 则返回 `ok:false` 并指出 q3 重复。该历史探针使用当时任务独立编译输出 `core-tests-green/src/contracts/question-plan.js`。

原影响：模型输出常见数字题号时，完全重复的经历问题能直接进入 web 固定计划，且共享校验入口会将同一漏洞带到 T3；不满足“不能仅换措辞重复”与任务报告声称的“只改题号也拒绝”。

修复复核：已只读检查 `src/contracts/question-plan.ts` 新行首正则与 `test/contracts.test.ts` 新断言。归一在标点删除前处理裸数字点号／顿号／冒号、括号、圈号等明确行首编号；保留行首正文 `3个院系`，数字分隔符的负向前瞻保留 `3.14`／`3:00`。测试覆盖 `3. `、`3、`、`（3）`、`(3) `、`３．`、`第3题：`、`q3: `、`③ ` 八种编号，以及正文 `3个院系` 与 `4个院系` 仍为不同问题。未改变既有来源定位或 web 重试。

已读取主代理的 `[任务文件：core-report.md]` 修复段及 `numbering-red.log`／`numbering-green.log`：窄编译＋契约测试修改前 9/10（新编号断言预期失败）、修改后 10/10。该修复复核没有重新运行测试；结论依据源码、新测试内容与实际日志。此 P2 关闭，无剩余本任务内必须修复项。

## 已核实的合规项

- 五个 `schemas/v0.2.0/` 文件分别与 `git show HEAD:src/contracts/schemas/<name>.schema.json` 比较，全部 `BYTE_IDENTICAL`。0.1/0.2 等价断言仅比较两份历史版本，0.3 不冒充历史等价；auto 校验保留未知版本拒绝与旧对象不改写。
- 当前计划 Schema 固定四项、q1 introduction、q2–q4 experience、顺序与长度；共享校验确实按 JD／经历的**单份原文**调用既有定位器，不跨原文拼接，不放松 CJK 引用规则。
- 当前 report Schema 要求四条、对应 id／kind、reviewed 有 feedback、未评审没有 feedback 或 rewriteDelta。`validate.ts` 的现行版本附加语义校验再约束完成数、终态和 feedback.questionId。旧版结构不受新语义约束，历史证据兼容性保留。
- 完成数在正式 `REVIEW_DONE` 时更新；同题重答和修订先作废旧计数，降级不计完成，当前题／最后一题点评后立刻结束按有效反馈统计。web 报告从应用持有的已校验反馈回填，模型只提供 priorityPractice；四字来源校验与派生回退保留。报告生成前机器计数与有效反馈数不一致会明确拒绝。
- web 修订限制在当前题；初答修订与重答后的修订按最终重答版评审。重评前同步删除内存及持久旧 feedback／rewrite_delta，网络异常或降级不会保留旧正常评分。正常追问／review 调用确实传完整 InterviewContext，report 调用传 totalQuestions=4。
- 新历史摘要区分介绍与经历；新活动记录以正式反馈和最新 reviewMeta 判定完成，反馈所属 questionId 匹配；旧历史缺少 kind 时仍为 not_included，轮次版本从所属会话 JSON／原规则版本恢复。没有 SQL 迁移或旧 JSON 回写。
- 实现规模集中在指定契约／状态／数据链路，不引入依赖，不改变追问上限与重答限制。报告中的两个已知失败确为内容任务未合并所致，不能算作这项任务故意忽略的失败，也不能在集成验收前宣称整项通过。

## 主代理后续跨任务验证

1. 内容任务合并后，验证 `followupDecisionPrompt`／`reviewPrompt` 正文真正渲染 JD、stage、targetRole、kind、intent，并明确 context 不能替代当前题确认回答。复跑现有“新环节的追问与评审均传岗位题型语境”断言。
2. rules/prompts 升 0.3 后复跑 health 的 rules@0.3.0 断言；报告示例必须自身满足四条、kind、反馈归属及完成计数，不能通过放宽 Schema 来适配旧三条模板。同步 docs/contracts.md 的 0.3／三版本说明。
3. T3 必须接入 `validateQuestionPlan`，正常追问与评审传 context；正式 vs degraded 的 `REVIEW_DONE` 使用 reviewValid；完成数必须由正式有效反馈统计。验证介绍→三道经历题及中途结束／重答／修订的报告一致性。
4. 前端新总完成数为 4，但经历计数和五维汇总只取 experience；kind 缺失的旧报告按经历题读取，介绍单独展示，所有题重答可见。检查新历史摘要消费和新四项 completed 埋点的 schema_version=2，旧会话继续 1。
5. 编号绕过断言已补充并通过；仍由主代理最终统一编译、生成规则/T3 包、全量免费验证。现有任务报告的 66/67、15/16 或本修复的 10/10 不能代替集成后的实际结果。

真实模型／真人麦克风／质量标定仍未验证；本复核不扩大此前的验收结论。


归档说明：本机用户路径及临时任务文件标识已脱敏；技术位置、命令与结果保留。原始报告仍保存在本地临时目录。
