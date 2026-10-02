# 网页出题引用修复与验收（2026-10-02）

## 结论与范围

网页出题传输适配 `web-plan@0.3.3` 已实现，免费验证通过。真实文本出题已用同一份失败材料复测通过：1次调用生成4题，全部来源精确匹配，实际编排进入answer。该结论限于本次出题，完整真人语音流程和质量标定仍未验证。

本次解决连续两次生成的 sourceExcerpt 无法定位而触发 E_PLAN_FAILED：应用先将已确认 JD 和经历分别切成连续原文片段；模型返回来源编号，应用按本次目录回填原文，再经过原有 QuestionPlan Schema、顺序、题型、重复题和精确来源校验。未放宽校验，也不编造题目或来源来强行通过。

- 目录不跨材料、不总结；每段保留原始字符及区间；按换行/句末优先分段，长段上限约240字符，不截断表情代理对，不丢末尾短段。
- 新的模型传输字段 sourceId 不入库、不传前端；正式 QuestionPlan 仍为 contract@0.3.0，规则 rules@0.3.0、共用反馈提示词 prompts@0.3.2 保持不变。文字两入口继续使用原契约。
- 来源编号不存在、类型错误或同时提交 sourceId/sourceExcerpt 时拒绝。兼容模型仍输出的旧式 sourceExcerpt，但必须通过原有严格连续定位，不自动修补。
- 首次失败仍只自动修正一次，成功即停；手动重试失败更新错误快照，成功清除错误。
- 健康接口新增 versions.webPlan，可确认运行进程是否加载本次修复。

## 免费验证

1. 先增加“来源编号计划首次即进入作答”回归测试，修复前运行 `npm run build:server && node --test --test-name-pattern='来源编号计划首次' dist/test/web-runner.test.js`：1个测试失败，实际 E_PLAN_FAILED。
2. 修复后 `npm test`：285 tests / 285 pass / 0 fail / 0 skipped。首次沙箱内运行有18项 localhost listen EPERM，使用允许本地监听的执行权限后完整重跑通过；没有将权限失败当作成功。
3. `node scripts/introduction-browser-smoke.mjs`：PASS: 22 browser checks; real Chrome + mock models; paidCalls=0。正式构建页面走完自我介绍、3道经历题、介绍与经历重答、报告、提前结束；新增断言确认模型来源编号经回填后全部精确对应原文，首次出题只调用一次。
4. 针对刚才失败会话的已保存材料运行 `node scripts/plan-model-smoke.mjs --session <原会话ID>`：dry-run，22个连续原文片段全部有效，paidCalls=0；该步骤不读取凭证、不改用户数据库。
5. `node --check scripts/plan-model-smoke.mjs` 与 `git diff --check` 通过。

原始免费证据：`evidence/upgrade-v0.3/plan-source-fix/npm-test-summary.txt` 与 `browser-smoke/summary.json`，同目录有正式页面截图。保留此前 browser-smoke 证据不覆盖。

## 真实复测的具体边界

本次已获明确授权（含阿里百炼目的地），实际运行：

```sh
node scripts/plan-model-smoke.mjs --session <原会话ID> --allow-paid
```

- 使用该失败会话的已确认材料，仅真实文本出题，最多2次调用，成功即停。
- 走实际 InterviewRunner 和原有最终契约，断言4题、来源全部精确匹配、进入answer状态、错误清除；语音使用本地替身，不触发真实语音、评审、报告或额外循环。
- 原会话数据库只读。请求、原始响应与解析后的计划仅保存到已忽略的 `data/plan-source-fix/<runId>/`，目录0700、文件0600，落盘经过 assertNoSecret；普通日志只输出汇总与固定错误码。
- HTTP成功不等于验收成功；任何最终断言失败退出1。真实模型能否稳定选择合适来源、题目质量、后续实时语音及真人麦克风，按实测范围分别报告，不以免费替身结果代替。

## 费用审批状态

用户已授权本次最多2次真实文本出题。首次执行在进程启动前被自动审批拒绝，理由为未显式确认包含 JD/经历的具体外部目的地；该次执行没有调用模型、没有产生费用。已向用户补充确认项目现用阿里百炼 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，用户随后明确授权该目的地；原命令重新通过审批后执行，未绕过审批。

## 本次真实文本结果

- 运行 ID：`2026-10-02T14-52-13-650Z-0b3b57f3`；模型 `qwen3.8-flash`；出题版本 `web-plan@0.3.3`。
- 实际1次文本调用，未用第二次额度；prompt 6813 / completion 613 / total 7426 Token；成功后已停止。
- 原失败会话的同一材料，4题计划通过完整契约和来源校验，每个回填片段均能在原文精确定位，state=answer，lastError=null。
- 独立比对原始响应与保存计划：问题文本、意图、主题和身份等字段未改写，只将 sourceId 转为目录原文 sourceExcerpt。不是只检查HTTP200。
- 汇总：`evidence/upgrade-v0.3/plan-source-fix/real-plan-summary.json`；含材料的原始请求/响应与计划仅留在私有 `data/plan-source-fix/<runId>/`。
- 真实语音、评审、报告没有产生额外调用；四环节正式页面流程由22项免费Chrome替身检查覆盖，不能混称完整真实模型语音验收。

## 本地生效

已在22:49重启8918本地服务。原失败会话已有材料留在历史库；本产品暂不支持跨进程续跑，重启后需从首页新建训练。公网未发布，未push，密钥与用户配置未修改。
