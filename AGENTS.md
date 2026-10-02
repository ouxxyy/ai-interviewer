# AGENTS.md

## Project overview

中文经历面试训练工具（三入口 MVP：本地网页／Skill／简版 Prompt），基于 Multica 任务 MYW-84。需求与验收红线以 `MULTICA_EXECUTION_PLAN.md` 与 PM 方案（issue 附件 `MYW-84-PM方案-v1.md`）为准。

- 当前阶段：**T1-S 静态通过** ＋ **T1-R 两链实时通过** ＋ **T2 契约与内容定稿完成** ＋ **T3 纯文字两入口已交付** ＋ **网页入口正式前后端已落地**（正式前端 `web-client/`，本地服务 `src/web/`）。评审延迟 P95 未达标（30.4s vs 15s），已知限制保留；`/harness` 继续用于真实模型验收，不是产品界面。
- **2026-10-02 本地增量**：用户明确授权三入口及必要网页前端升级为“自我介绍＋三道经历题”，并先合回生产埋点/麦克风差异。本轮不授权付费模型或生产发布；新版本真实模型、真人麦克风、宿主终验和质量标定均未验证。过程和最终免费证据见 `docs/upgrade-v0.3-acceptance.md`，历史阶段通过不套用到新版本。
- 同日用户追加授权**一次介绍＋一道经历题文本试验，最多10次调用**；实际8次HTTP200但闭环未通过，详细原始证据与独立诊断见 `docs/text-smoke-v0.3.0.md`。这次授权已用完，不扩量或重跑；其他付费验证与生产发布仍需另行授权。不能用CLI退出0替代closedLoop/原始字段校验。
- **入口级操作提示**（`src/rules/entry-hints.ts` 的 `ENTRY_HINTS`）**不是规则正文**，不在 `rulesDigest()` 覆盖内；两个 T3 入口逐字渲染同一常量，**网页入口必须引用同一常量**（否则 A8 被第三把尺子静默击穿）。要不要升格为规则正文，走预登记的控制实验，别顺手改。
- T3 入口：规则正文**同源生成**（`src/t3/content.ts` 渲染），改动 `src/rules/rules.ts` 后必须跑 `node dist/src/t3/cli.js skill:build`，否则测试红。`skill:run`／`prompt:run` 会真调模型。宿主实测结论由 `hosts:record` 从原始输出算出，不许手写。
- 同日用户要求按实调诊断修复：文字入口补齐字段/报告约束，Prompt应用重定位引用坐标但不代写内容；原始校验与辅助闭环分层，失败退出1，按提示词版本及runId保存证据。`prompts@0.3.1` 免费验证记录见 `docs/text-smoke-v0.3.1-optimization.md`；复测费用仍按确认边界执行。
- 同日再次授权一次0.3.1复测：8次HTTP200、51796 Token，结构与应用辅助引用闭环通过，普通聊天原始坐标仍失败；人工检查发现介绍建议将材料中未口述年限写成示范句，整体内容红线未通过。随后免费收紧至0.3.2，未再调用模型；见 `docs/text-smoke-v0.3.1.md`。此次一次费用授权已用完，不扩量或再跑。
- 契约版本：`contract@0.3.0`（四环节与显式 kind；历史0.1/0.2原样并存，二者只差版本号）；规则 `rules@0.3.0`（单源 `src/rules/rules.ts`，正文 `docs/rules.md` 由 `node dist/src/t2/run.js rules:write` 生成，**勿手改**）；提示词 `prompts@0.3.2`（**未实调、未标定**）。介绍五维按题型解释也进入规则单源，不建隐含尺子。
- 技术栈：服务端 TypeScript（NodeNext）+ `ajv` + `ws` + Node 内置 `node:sqlite`；正式产品前端为 React + Vite + Phosphor Icons，按方案 C 产出 `dist/web-client/`。
- 网页入口（`src/web/`）纪律：服务**只绑 `127.0.0.1`**、密钥不进浏览器与日志；两开关按会话快照（关历史＝不落库不落录音，关录音＝落库不落 WAV，**关开关不删旧记录**）；报告 `perQuestion.feedback` 只回填已过契约的 Feedback，`priorityPractice` 必须过「与逐题反馈共享 ≥4 字连续片段」的来源校验，否则回退派生来源并标注 `reportSource`；实时音色对当前默认 `Maia` 做前置断言、撞 400 换新连接；`Maia` 尚未当前账号实调；冻结实时模型可用 `AI_INTERVIEWER_REALTIME_MODEL` 覆盖，**覆盖必须写进验收记录**，不许悄悄改默认值。
- 真实调用：`src/t1r/` 为 T1-R 验收运行器；凭证**显式从项目根 `.env` 读取**（不依赖 shell 加载 `~/.zshrc`），落盘统一过 `assertNoSecret()` 防线。核定参数：文本 `qwen3.8-flash`，实时 `qwen3.8-omni-flash-realtime`，当前默认音色 `Maia`（静态切换，待实调）；历史 T1-R 证据音色为 `Serena`，服务端默认 `Chelsie` 当时实测被拒；输入 pcm16／输出 pcm24。
- 关键目录：`src/contracts/`（五对象契约0.3、引用定位器、三版本校验与共享计划来源检查）、`src/state/`（应用层状态机）、`src/review/`（评审与三入口共享的反馈判断来源检查）、`src/prompts/`（提示词0.3，**未标定**）、`src/clients/`（模型客户端抽象）、`src/prototype/`（音频 prototype）、`cases/`（原24合成案例＋独立介绍案例）、`docs/`（审计/契约/证据）、`reference/`（只读参考，gitignore，绝不入库）。

- **2026-10-02 网页出题修复**：`web-plan@0.3.3` 改用来源编号目录与应用原文回填，最终契约0.3.0及严格来源校验不变。285/285 测试、22/22 正式Chrome替身检查通过；同一失败材料经新授权真实文本复测1次通过（7426 Token），未调用真实语音/评审。授权已完成，不擅自追加调用；详见 `docs/plan-source-fix-v0.3.3.md`。

- **2026-10-02 评审恢复优化**：应用可计算的引用坐标先回填再过完整契约；JSON根类型检查、安全attemptLog与原回答显式重试已落地，降级不伪装正常点评。294/294 单测、27/27 正式Chrome替身检查通过，付费调用0。原失败字段不可追溯，真实模型复测仍未验证；生效状态见 `docs/review-recovery-2026-10-02.md`。

## Working rules

- 动手前先读 `MULTICA_EXECUTION_PLAN.md`、`docs/reference-audit.md`、`docs/contracts.md`：参考仓库只借鉴思路，不复制代码或整段提示词；若确需复制，保留 MIT 版权与许可文本并更新审计文件。
- 契约变更：改 `src/contracts/schemas/` 与 `types.ts` 必须同步 `docs/contracts.md`，升版本号，并保持 `npm test` 全绿；引用定位规则不得放松（100% 定位或明确拒绝）。
- **升契约版本时**：旧版 schema 原样复制到 `src/contracts/schemas/v<旧版本>/` 并登记支持版本。`assertLegacyMatchesCurrent()` 名称保留，其比较固定历史0.1/0.2只差版本号；0.3有明确结构变化，不冒充等价。历史证据按原版校验，新写入只用当前版本。
- **改 `src/rules/rules.ts` 正文**：必须同时升 `RULES_VERSION`、重跑 `rules:write`、并在 T4 交给红队复测；尺子变更不许在流水线里悄悄放宽。
- 阶段纪律：T1-R 两链已实时通过；网页入口服务端与数据层已交付（MYW-85 授权范围＝服务端与数据层，**不含前端**）。T1-S 相关产物仍只能标「静态通过」；只有真跑过的链路才能写「实时通过」，未跑的（真人麦克风、反抢话、标定、反注入对抗）一律写「未验证」。
- 提示词只做结构与契约字段对齐 + 结构标定；**质量标定**（档位判得准不准）未做，勿声称质量。共同红线逐字取自 `src/rules/rules.ts`，不许在提示词里另抄一份。
- 密钥只走环境变量／`.env`（已 gitignore）；不得出现在浏览器存储、日志、报告、录屏或 Git 历史。检查凭证只做存在性判断，不读取值。
- 不为形式完整引入生产依赖；服务仅绑定 `127.0.0.1`；不做 push、发布或修改远程资源。
- 不顺手重构无关代码；失败项如实标注，不用“应该能跑”交付。

## Commands（当前真实可用）

```bash
npm test                              # 构建并跑全部单测（数量以实际输出为准）
npm run build                         # tsc 编译到 dist/
npm run validate -- <file> <name>     # 独立契约校验 CLI
npm run web:serve                     # 网页入口本地服务（127.0.0.1:8918；只绑回环）
npm run web:dev                       # Vite 开发服务，同源代理 API 与 WS 到 8918
npm run web:info                      # 数据目录/迁移版本/凭证存在性/当前设置
npm run web:evidence                  # 真实 Chrome + 真实模型（花钱，写版本隔离的验收目录/文档）
npm run prototype                     # 音频 prototype mock 服务（127.0.0.1:8917）
npm run prototype:run                 # headless Chrome 真跑音频链路并生成证据文档
npm run check:env                     # 环境基线核对（stdout）
bash scripts/env-check.sh --write     # 重新生成 docs/environment-baseline.md
bash scripts/checkout-references.sh   # 固定 commit 检出参考仓库（需 GitHub 代理）

# T3（skill:build / hosts:record / manifest 不花钱；skill:run / prompt:run 真调模型）
node dist/src/t3/cli.js skill:build    # 生成 Skill 包与简版 Prompt
node dist/src/t3/cli.js skill:run      # 按 Skill 流程真跑一场
node dist/src/t3/cli.js prompt:run     # 简版 Prompt 多轮闭环
node dist/src/t3/cli.js hosts:record   # 判定宿主实测结论
node dist/src/t3/cli.js manifest
node scripts/prompt-smoke-replay.mjs  # 免费回放首次失败输出，不改原始证据/不调用模型
node dist/src/t3/cli.js experiment     # 预登记控制实验（36 次真实调用）

# T2（rules:write / manifest 不花钱；calibration / representative 真调模型）
node dist/src/t2/run.js rules:write    # 生成 docs/rules.md（改了 rules.ts 必须重跑，否则单测红）
node dist/src/t2/run.js calibration    # 三版本对照标定
node dist/src/t2/run.js representative # 代表案例 ×3
node dist/src/t2/run.js manifest       # 由磁盘重建 evidence/t2/manifest.json
node dist/src/t2/run.js calibration:rounds  # 归档标定轮次并重建带 round 字段的合并视图

# T1-R 真实调用（需 .env 里的 DASHSCOPE_API_KEY，产生费用；凭证缺失时不要跑）
node dist/src/t1r/run-t1r.js models   # 模型核定
node dist/src/t1r/run-t1r.js chain-a  # 链 A
node dist/src/t1r/run-t1r.js chain-b  # 链 B
node dist/src/t1r/run-t1r.js latency  # 延迟抽样
node dist/src/t1r/run-t1r.js all      # 全部（重写 evidence/t1r/）
```

注意：prototype 端口 8917（8787 曾被本机 ActivityWatch 占用）。`prototype:run` 依赖 `/Applications/Google Chrome.app`。

## Validation requirements

- 任何改动：跑 `npm test`，贴实际输出；涉及音频链路的改动补跑 `npm run prototype:run` 并检查证据文档断言全过。涉及真实调用的改动重跑 `run-t1r.js` 对应子命令，并更新 `docs/t1r-acceptance.md` 的数字。
- 涉及网页入口（`src/web/`）的改动：跑 `npm test`；改到实时/数据链路时补跑 `npm run web:evidence`（真实 Chrome ＋ 真实模型，会花钱），证据写 `docs/web-acceptance.md` 与 `evidence/web/`，未做到项写进 `docs/web-server.md` §8 与验收记录末尾。
- 0.3增量证据写版本子目录及 `docs/web-acceptance-v0.3.0.md`，保留旧实调文档与原始数据；不能把免费规则生成与旧标定结果混入同一汇总。付费验证未获授权时先完成免费检查、记录未验证并提交具体实调清单。
- 免费正式页面检查：构建后 `node scripts/introduction-browser-smoke.mjs`，真实Chrome/假音频设备/本地模型与ASR替身，不读项目凭证、不发送真实统计。暂停恢复须保持同一未提交回答的已收音频；结束本场取消本地待授权和采集，不声称取消后台已发出的模型请求。
- 契约与案例改动：`docs/reference-audit.md` 固定 commit 断言、案例覆盖矩阵断言必须仍通过。
- 交付说明三要素：改了什么、怎么验证的（真实命令＋输出）、遗留问题。无法验证的部分标“未验证”。

## Delivery boundaries

- 按 MYW-84／MYW-85 当前分派的阶段范围执行（T0/T1-S/T1-R/T2、T3 纯文字两入口、MYW-85 网页服务端与数据层已完成）；**网页前端不在 developer 身份授权范围**，方案 C 的正式实现交前端角色或另行授权。
- 不上传远程仓库、不创建 GitHub 仓库、不执行 push、不修改全局 Git 配置。
- 高风险操作（删除数据、覆盖配置、真实 API 花费）先确认；用户自行承担 API 费用。

## Jev 协作流程

- `on` 模式下，任务开始先使用平台本轮已注入的 `jev route` 建议，相同输入和判断不重复请求。仅当还需选择执行者或 Skill、且已查明真实候选 ID 时，才携带 `task`、`goal`、`acceptance` 和 `candidates` 补充调用 `jev route`；没有候选就不编造选择。
- Jev 对任务类型、联网、深思、风险和并行的判断仅供参考。调用方依据项目事实、用户授权及工具能力决定并执行；Jev 不生成操作参数，也不替代验证或权限判断。
- 对目标明确、产物和证据可核验的代码、报告等交付，整理实际产物与检查结果后调用 `jev review`；同一版交付不重复复核，普通问答不复核。证据不足先补证据，关键决策交用户处理。
- 遵守共用总开关：`on` 时使用建议，`shadow` 时只观察、不采用建议，`off`、超时或失败时继续原流程。已有的路由或复核结果不重复请求。

本项目 Jev 候选来源：暂无已确认的候选 Skill 清单；验证命令以 Commands 节为准；交付物为代码与文档时按 Validation requirements 执行。
