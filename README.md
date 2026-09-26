# AI 面试官

基于目标岗位 JD 与本人经历的**中文经历面试训练工具**。目标是让用户（应届生／社招互联网求职者）更准确地回答问题、讲清个人贡献、识别证据缺口并通过重答改进；不声称复刻招聘方 AI 面试评分或预测录用结果。

完整需求与验收标准见 [MULTICA_EXECUTION_PLAN.md](MULTICA_EXECUTION_PLAN.md)（Multica 任务 MYW-84）。

## 当前状态（如实标注）

- **T0 基线：已完成**（reviewer 独立复核 PASS）——工程初始化、可复现环境记录（`docs/environment-baseline.md`）、参考源码审计（`docs/reference-audit.md`）。
- **T1-S 静态验收包：静态通过**（reviewer 独立复核 PASS）——契约冻结（`contract@0.1.0`）、状态机、引用定位器、中文提示词 v1、24 案例起草、评审器 mock、音频 prototype（真跑 M1 Chrome，证据 `docs/t1s-audio-prototype-evidence.md`）、客户端抽象。
- **T1-R 实时验收包：两链实时通过**（2026-09-26，真实百炼调用，证据 `docs/t1r-acceptance.md` 与 `evidence/t1r/`）——
  链 A：真实 QuestionPlan（3 题）＋ 5 份真实 Feedback 全部过 Schema、引用 23/23 可定位、0 降级；
  链 B：真实 WebSocket 语音会话跑完「提问→回答→转写→追问→打断」，两个技术前提（服务端注入问题文本、面试官音频服务端持久化）均成立。
- **T2 契约与内容定稿：完成**（2026-09-27，证据 `docs/t2-acceptance.md`、`evidence/t2/`）——`contract@0.2.0`（与 0.1.0 结构相同、双版本并存可校验）、三入口共用规则文本 `rules@0.2.0`（单源 `src/rules/rules.ts` → `docs/rules.md`）、D1–D11 冻结登记 `docs/decisions.md`、24 案例标注规范、带对照的提示词标定（`t1s` 0% → `t1r` 67% → `t2` 83% 首次通过）、代表案例真实评审 ×3（档位不跨两档 4/4、引用 100% 可定位 4/4、与预期一致 3/4）。
- **网页入口（服务端与数据层）：已交付**（2026-09-27，证据 `docs/web-acceptance.md`、`evidence/web/`）——仅绑 `127.0.0.1` 的本地 Node 服务、服务端代理 Qwen-Omni-Realtime（浏览器不接触密钥）、冻结状态机落地、材料粘贴／DOCX／PDF 提取与退路、SQLite 历史 ＋ 独立录音文件、按轮回放、显式删除（前后对照）、保存历史／保存录音两个独立开关、首次使用告知、空转写等错误状态一律不生成伪报告。**产品界面未实现**（A／B／C 方案未定），服务里只带验收用最小客户端 `/harness`。
- **T3 纯文字两入口：已交付**（2026-09-27，证据 `docs/t3-acceptance.md`、`evidence/t3/`）——Skill 包（`skills/ai-interviewer/`，含 SKILL.md／references／INSTALL.md）与自包含简版 Prompt（`prompt/ai-interviewer-prompt.md`）。规则正文由 `src/rules/rules.ts` **同源生成**，两入口都带 `rules@0.2.0` ＋ 完整 `rulesDigest()`。Skill 全流程真实跑通（7 次调用、报告见 `evidence/t3/skill/report.md`）；简版 Prompt 多轮闭环实测引用 5/5 逐字。**Codex 宿主实测通过；Claude Code 撞 1310 配额，按止损未重试，标未验证**。
- **性能**：语音腿「答完→首段回应音频」P95 **1,979 ms**（达标 ≤3 s）；评审腿「提交评审→完整点评」P95 **30,417 ms**（**未达标** ≤15 s，根因与建议见验收记录 §7.2）。T2 标定把单次 P50 从 ~12.5 s 降到 11.1 s，但**未改变未达标的结论**，已知限制保留。
- **仍未验证**：真人麦克风采集、浏览器↔服务端音频链路、提示词标定、24 案例模型侧全量校验、反抢话 A10、转写质量 A5、反注入 A9；单场成本金额与账号配额未核定（官方定价页在本机网络环境不可达）。

## 技术栈

TypeScript（NodeNext，零框架）。依赖仅 `ajv`（Schema 校验）与 `ws`（WebSocket 服务与 CDP 客户端）。
网页入口的持久化用 Node 内置 `node:sqlite`（**不引入原生依赖**），PDF／DOCX 解析同样零依赖（自写最小 ZIP 与 PDF 文本层解析，
不足时再试 macOS 自带 `textutil`／`pdftotext`）。React＋Vite 前端仍待 A／B／C 方案选定后单独开工。

## 可用命令（当前真实存在的）

```bash
npm test                 # 构建并运行全部单测（node --test，当前 55 项）
npm run build            # tsc 编译到 dist/
npm run validate -- <file.json> <contract-name>   # 独立契约校验 CLI
npm run web:serve        # 启动网页入口本地服务（127.0.0.1:8918，仅本机回环）
npm run web:info         # 打印数据目录、迁移版本、凭证存在性（不打印值）与当前设置
npm run web:evidence     # 真实 Chrome + 真实模型跑完整验收并写 docs/web-acceptance.md 与 evidence/web/
npm run prototype        # 启动音频 prototype mock 服务（127.0.0.1:8917）
npm run prototype:run    # 自动拉起 mock 服务+headless Chrome 跑完整音频链路并生成证据文档
npm run check:env        # 环境基线核对（打印到 stdout）
bash scripts/env-check.sh --write          # 重新生成 docs/environment-baseline.md
bash scripts/checkout-references.sh        # 按固定 commit 检出两个 MIT 参考仓库到 reference/

# T1-R 真实调用（需要项目根 .env 里的 DASHSCOPE_API_KEY；会产生 API 费用）
node dist/src/t1r/run-t1r.js models        # 核定模型列表/文本模型可用性
node dist/src/t1r/run-t1r.js chain-a       # 链 A：真实 QuestionPlan + 真实 Feedback
node dist/src/t1r/run-t1r.js chain-b       # 链 B：真实语音会话（提问→回答→转写→追问→打断）
node dist/src/t1r/run-t1r.js latency       # 延迟抽样（20 轮语音 + 20 轮评审）
node dist/src/t1r/run-t1r.js all           # 以上全部，重写 evidence/t1r/

# T2 契约与内容（rules:write / manifest 不花钱；calibration / representative 会真调模型）
node dist/src/t2/run.js rules:write        # 由 src/rules/rules.ts 生成 docs/rules.md
node dist/src/t2/run.js calibration        # 三版本对照标定（t1s / t1r / t2）
node dist/src/t2/run.js representative     # 代表案例重复评审 ×3
node dist/src/t2/run.js all                # 以上全部
```

注意：prototype 端口为 8917（8787 曾被本机 ActivityWatch 占用）。`prototype:run` 需要 Chrome（`/Applications/Google Chrome.app`）。

## 目录结构

```
├── MULTICA_EXECUTION_PLAN.md   # 需求与验收计划（2026-09-23 交接稿）
├── docs/
│   ├── reference-audit.md      # 参考源码审计（固定 commit、行级证据、采用/改写/舍弃）
│   ├── environment-baseline.md # T0 环境基线记录（脚本生成，含失败项与 PATH 快照说明）
│   ├── contracts.md            # 契约口径：评审对象、引用定位规则、流程控制
│   ├── t1s-audio-prototype-evidence.md  # 音频 prototype 真跑证据（Chrome 153 · M1）
│   ├── t1r-acceptance.md       # T1-R 实时验收记录（核定参数、两链证据、延迟、未做到项）
│   ├── t2-acceptance.md        # T2 契约与内容验收记录（对照标定、代表案例复测、未做到项）
│   ├── decisions.md            # D1–D11 产品决策冻结登记
│   ├── web-server.md           # 网页入口：启动、接口契约、隐私与开关、已知限制
│   ├── web-acceptance.md       # 网页入口真实链路验收记录（脚本生成，含逐条实测数字）
│   └── rules.md                # 三入口共用规则正文（由 src/rules/rules.ts 生成，勿手改）
├── src/
│   ├── contracts/              # 五对象 TS 类型 + JSON Schema + 校验器 CLI + 引用定位器
│   ├── state/machine.ts        # 应用层状态机（D2/D5/D6）
│   ├── review/                 # 评审流水线（校验→重试→降级）与 mock fixture
│   ├── prompts/prompts.ts      # 中文提示词 v1（四模板，未标定）
│   ├── clients/                # 百炼文本适配器（真实调用已验证）+ Qwen-Omni-Realtime WS 客户端
│   ├── prototype/              # 音频 prototype：mock 服务 + 页面 + CDP 证据采集
│   ├── t1r/                    # T1-R 验收运行器：.env 加载/密钥防线、音频工具、链 A/B、延迟、证据清单
│   ├── t2/                     # T2 运行器：对照标定、代表案例复测、汇总与清单
│   ├── t3/                     # T3 运行器：Skill／Prompt 内容生成、真实调用跑流程、宿主实测记录、控制实验
│   ├── web/                    # 网页入口服务端与数据层（MYW-85）：本地服务、实时桥、编排器、迁移、材料解析
│   └── web/public/harness.html # 验收用最小客户端（不是产品界面）
│   ├── rules/rules.ts          # 三入口共用训练规则文本（唯一源）
│   └── rules/entry-hints.ts    # 入口级操作提示（≠ 规则正文，不在 rulesDigest 覆盖内）
├── cases/cases.json            # 24 个固定案例（全合成，人工预期标注）
├── evidence/t1r/               # T1-R 真实调用证据（模型目录、QuestionPlan、Feedback、事件日志、延迟、短音频片段）
├── evidence/t2/                # T2 证据（三版本对照标定、代表案例 ×3、manifest 带 sha256）
├── evidence/t3/                # T3 证据（Skill 会话与报告、Prompt 会话、宿主实测原始输出）
├── evidence/web/               # 网页入口证据（验收 summary.json ＋ manifest，每条带 sha256）
├── skills/ai-interviewer/      # Skill 包（SKILL.md ＋ references/rules.md ＋ INSTALL.md）
├── prompt/ai-interviewer-prompt.md   # 自包含简版 Prompt
├── scripts/                    # env-check / checkout-references
└── test/                       # 79 项单测（契约/定位器/状态机/mock/提示词/案例/基线/T1-R 护栏/T2 定稿/T3 入口/证据纪律）
```

## 已知限制

1. **仍非完整产品**：服务端与数据层已交付并有真实链路证据（`docs/web-acceptance.md`），但没有产品界面——`/harness` 只是验收用最小客户端。
2. **真人麦克风采集未验证**：T1-R 的「用户回答」音频由 macOS `say` 合成后推流，服务端 ASR／模型／事件链路真实；网页入口验收同样用合成语音（原因见第 15 条）。真人麦克风、环境噪声与真实语速仍未验证。
3. **浏览器 ↔ 服务端音频链路已验证、但输入不是真人声音**：网页入口验收在同一次运行里接通了 Chrome（getUserMedia ＋ AudioWorklet 16k）→ 本地服务 → 服务端代理 → 真实 ASR，浏览器侧音频分片数与字节数都有实测记录（`docs/web-acceptance.md`）。
4. **提示词未标定**：只做了结构与契约对齐（含「引用必须连续逐字、禁止省略号拼接」等硬约束）；24 案例预期档位仍是人工标注。
5. **评审延迟未达标**：P95 30.4 s（目标 15 s），根因是单次输出 ~800 tokens 与 25% 重试率；T3 建议流式渲染或五维拆分调用。
6. 反抢话（A10）、转写质量（A5）、反注入（A9）对抗测试未做；单场成本金额与账号配额未核定。
7. 音频 prototype 的音频输入为 Chrome 官方 fake device（真实 getUserMedia/MediaRecorder API，非真人声音）；面试官回应为 mock 服务合成音频。
8. 百炼实时接口的服务端默认音色 `Chelsie` 实测**不可用**，必须显式指定（本项目固定 `Serena`，代码层已加前置断言）。
9. **代表案例 C19 的 contribution 维度与人工预期不一致**（3 次里 1 次相邻下档），未解决，见 `docs/t2-acceptance.md` §4.2；24 案例的模型侧**全量**校验与提示词质量定标仍未做。
10. **structure 维度的标尺收敛（`rules@0.2.0`）改了尺子，必须交 T4 红队复测**，本轮不自我背书。
11. **Claude Code 宿主未验证**（配额 1310，按止损未重试）；**A8 三入口一致性验收**要等网页前端落地（网页服务端已交付，规则与提示词同源可直接复用）。
12. 简版 Prompt **没有引用校验回环**：`structure` 维度曾连续 3 次写出省略号拼接稿，改成「按句切开、整句复制」的机械做法后 5/5 逐字（`docs/t3-acceptance.md` §2.3）。仓库流水线尚未采用该做法，属待评估的提示词变更。
13. 简版 Prompt 的实测宿主是百炼 chat completions 多轮会话（粘贴进普通聊天的 API 等价物），**第三方聊天 UI 未实测**。
14. **网页入口的产品界面未实现**：`/harness` 只是验收用最小客户端（没有设计、没有移动端适配）；A／B／C 方案选定后另开前端包。
15. **网页入口的真人麦克风仍未验证**：本机 Chrome 153 的 `--use-file-for-fake-audio-capture` 预检为静音（RMS 0.0，默认假设备 0.72），验收里的作答语音由页面按同一 WS 协议推流注入（`say` 合成语音），真实麦克风链路由 Chrome 假设备（提示音）单独覆盖空转写状态；真人说话、环境噪声、真实语速未验证。
16. **冻结的实时模型 `qwen3.8-omni-flash-realtime` 当前在上游侧故障**（`COMMON_ERROR`：服务端内部 `Connect call failed 127.0.0.1:8090`）；服务支持 `AI_INTERVIEWER_REALTIME_MODEL` 覆盖，验收用 `qwen3.5-omni-flash-realtime` 完成，**默认值未改**，是否变更冻结模型由 lead 决定。
17. **网页入口的历史会话不能续跑**：重启后可查看、回放、删除，继续作答返回 409（不做跨进程会话恢复）。
18. **`structure` 维度存在两套口径**：`rules@0.2.0` 正文是散文口径，两个 T3 入口渲染的是机械口径（入口级操作提示 `src/rules/entry-hints.ts`，**不在 `rulesDigest` 覆盖内**）。它带回退、可能改变档位输出，目前只有 n=1，已预登记控制实验；**是否升 `rules@0.2.1` 由 lead 决定**，本轮不动版本号。
