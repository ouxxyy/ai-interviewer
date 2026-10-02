# 文本实调失败后的修复与免费验证

日期：2026-10-02。本页记录修订当时的 `contract@0.3.0`／`rules@0.3.0`／`prompts@0.3.1`，本地分支 `codex/introduction-v03`。后续授权复测和0.3.2免费收紧见 [复测记录](text-smoke-v0.3.1.md)。

**修复已实现；当前记录仅证明免费回归，不证明新模型实调通过。** 首次8次真实调用的失败输出保留在 `evidence/t3/v0.3.0/prompt/`，原始结论见 [首次实调诊断](text-smoke-v0.3.0.md)。本轮没有新增付费调用、语音或生产操作。

## 已修复内容

- Skill 与简版 Prompt 由同一生成器补齐 `nextFacts` 至少1项、题目/轮次/版本身份要求及完整 SessionReport 示例；不能为填字段编造事实缺口或数字。
- 报告只允许正式字段，明确 reviewed／skipped／not_reached 的实际含义、四项完成计数、零完成固定练习点和反馈来源。完整版本戳在 JSON 外说明；只要求 JSON 时不添加 versionStamp／summaryNote。
- Prompt 运行器严格校验内容和身份；引用必须在当前题已确认回答中定位，只允许应用重算 start／end／matchType，不修引用文字、等级、理由或事实内容。不补空 nextFacts，不修错误题号/轮次/版本。
- 原始 `rawFeedback`／`rawFeedbackValid`／`rawClosedLoop` 与应用重定位后的 `feedback`／`feedbackValid`／`closedLoop` 分开保留。应用辅助通过不能宣称为普通聊天坐标已验证、原生宿主通过或质量标定完成。
- CLI 闭环失败退出1；HTTP200不能替代训练验收。每次请求前后保存对话，计划耗尽重试/提供方异常也保留失败原始记录、summary和manifest。
- 新免费产物在 `evidence/t3/v0.3.0/prompts-v0.3.1/`，每次真实运行在其下新建 `runs/<runId>/`；旧证据与当前版本的其他实调不覆盖。`--output-root <目录>` 支持隔离验收产物，不改变项目凭证、规则源或生成物位置。

契约和评价规则未放宽，规则摘要不变。提示词补丁升为0.3.1，避免把新模板与首次0.3.0失败输出混为同一版本。

## 免费验证

| 检查 | 命令或证据 | 实际结果 |
| --- | --- | --- |
| 坐标与缺字段反例 | 新回归修改前运行 | 12项中2项失败，复现“坐标未重定位”和“内容失败时丢引用诊断” |
| 异常证据反例 | 审查与新增回归修改前运行 | 计划失败和请求异常均缺 transcript；独立计划反例5次mock调用后0产物 |
| 针对性最终回归 | `node --test dist/test/t3-cli.test.js dist/test/t3-runner.test.js dist/test/t3-version-paths.test.js` | 19 tests / 19 pass / 0 fail |
| 首次失败免费回放 | `node scripts/prompt-smoke-replay.mjs` | 0网络调用；10/10引用文字可定位、仅1/10模型元数据正确；两题仍拒绝，报告仍拒绝，原始文件摘要不变 |
| 同源生成 | `npm run build`、`node dist/src/t2/run.js rules:write`、`node dist/src/t3/cli.js skill:build` | 规则正文、Skill及简版Prompt重新生成；模板与Schema/磁盘一致性由全量测试校验 |

全量最终输出与日志摘要写入 `evidence/t3/v0.3.0/prompts-v0.3.1/free-verification.json`。首次沙箱全量18项失败均为本地回环监听 EPERM；允许本地监听后273/273通过。独立审查发现的中途丢证据问题另有修复/复测，最终数字以新记录为准，不用早先输出替代。

本轮不涉及音频采集修改，未重复付费网页/语音验收。既有免费音频与页面验证的适用范围见 [四环节升级验收](upgrade-v0.3-acceptance.md)，不能替代新提示词真实输出。

## 下一次具体实调范围

需另行确认费用后才执行：同一合成案例C13，一次“自我介绍＋一道经历题”的 Prompt 应用辅助文本试验，使用既有 `qwen3.8-flash` 默认模型/端点；硬上限10次调用，每次最多4096输出Token。只跑一次，失败保留原始输出并停止，不自动扩量或追加语音/其他宿主/部署。费用以实际百炼账单为准，不给未核定金额保证。

验收分别记录：四项冻结计划及材料来源、实际两题提问、反馈内容/身份/原话引用、模型自报坐标与应用重定位结果、原样回填报告、CLI退出状态及调用Token台账。通过只能声称这一次合成案例的应用辅助文字流程；普通聊天/Skill原生宿主、档位质量、网页语音和生产统计仍需各自证据。
