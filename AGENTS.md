# AGENTS.md

## Project overview

中文经历面试训练工具（三入口 MVP：本地网页／Skill／简版 Prompt），基于 Multica 任务 MYW-84。需求与验收红线以 `MULTICA_EXECUTION_PLAN.md` 与 PM 方案（issue 附件 `MYW-84-PM方案-v1.md`）为准。

- 当前阶段：**T1-S 静态通过**；T1-R（真实模型链路）待阿里百炼凭证。
- 技术栈：TypeScript（NodeNext），依赖仅 `ajv` 与 `ws`。产品形态（React＋Vite、SQLite、实时语音）在 T1-R 通过后于 T3 落地。
- 关键目录：`src/contracts/`（五对象契约 `contract@0.1.0`＋引用定位器）、`src/state/`（应用层状态机）、`src/review/`（评审流水线与 mock）、`src/prompts/`（提示词 v1，未标定）、`src/clients/`（模型客户端抽象）、`src/prototype/`（音频 prototype）、`cases/`（24 合成案例）、`docs/`（审计/基线/契约/证据）、`reference/`（第三方参考仓库，gitignore，绝不入库）。

## Working rules

- 动手前先读 `MULTICA_EXECUTION_PLAN.md`、`docs/reference-audit.md`、`docs/contracts.md`：参考仓库只借鉴思路，不复制代码或整段提示词；若确需复制，保留 MIT 版权与许可文本并更新审计文件。
- 契约变更：改 `src/contracts/schemas/` 与 `types.ts` 必须同步 `docs/contracts.md`，升版本号，并保持 `npm test` 全绿；引用定位规则不得放松（100% 定位或明确拒绝）。
- 阶段纪律：T1-R 两链实时通过前不进入页面全面开发；凭证缺失时一切真实模型结论只能写「未验证」，产物只能标「静态通过」，不得出现「实时通过」「已验证模型输出」。
- 提示词只做结构与契约字段对齐；标定属 T1-R，勿提前声称质量。
- 密钥只走环境变量／`.env`（已 gitignore）；不得出现在浏览器存储、日志、报告、录屏或 Git 历史。检查凭证只做存在性判断，不读取值。
- 不为形式完整引入生产依赖；服务仅绑定 `127.0.0.1`；不做 push、发布或修改远程资源。
- 不顺手重构无关代码；失败项如实标注，不用“应该能跑”交付。

## Commands（当前真实可用）

```bash
npm test                              # 构建并跑全部单测（当前 50 项）
npm run build                         # tsc 编译到 dist/
npm run validate -- <file> <name>     # 独立契约校验 CLI
npm run prototype                     # 音频 prototype mock 服务（127.0.0.1:8917）
npm run prototype:run                 # headless Chrome 真跑音频链路并生成证据文档
npm run check:env                     # 环境基线核对（stdout）
bash scripts/env-check.sh --write     # 重新生成 docs/environment-baseline.md
bash scripts/checkout-references.sh   # 固定 commit 检出参考仓库（需 GitHub 代理）
```

注意：prototype 端口 8917（8787 曾被本机 ActivityWatch 占用）。`prototype:run` 依赖 `/Applications/Google Chrome.app`。

## Validation requirements

- 任何改动：跑 `npm test`，贴实际输出；涉及音频链路的改动补跑 `npm run prototype:run` 并检查证据文档断言全过。
- 契约与案例改动：`docs/reference-audit.md` 固定 commit 断言、案例覆盖矩阵断言必须仍通过。
- 交付说明三要素：改了什么、怎么验证的（真实命令＋输出）、遗留问题。无法验证的部分标“未验证”。

## Delivery boundaries

- 按 MYW-84 当前分派的阶段范围执行（当前为 T0）；未获明确授权不跨阶段开发。
- 不上传远程仓库、不创建 GitHub 仓库、不执行 push、不修改全局 Git 配置。
- 高风险操作（删除数据、覆盖配置、真实 API 花费）先确认；用户自行承担 API 费用。

## Jev 协作流程

- `on` 模式下，任务开始先使用平台本轮已注入的 `jev route` 建议，相同输入和判断不重复请求。仅当还需选择执行者或 Skill、且已查明真实候选 ID 时，才携带 `task`、`goal`、`acceptance` 和 `candidates` 补充调用 `jev route`；没有候选就不编造选择。
- Jev 对任务类型、联网、深思、风险和并行的判断仅供参考。调用方依据项目事实、用户授权及工具能力决定并执行；Jev 不生成操作参数，也不替代验证或权限判断。
- 对目标明确、产物和证据可核验的代码、报告等交付，整理实际产物与检查结果后调用 `jev review`；同一版交付不重复复核，普通问答不复核。证据不足先补证据，关键决策交用户处理。
- 遵守共用总开关：`on` 时使用建议，`shadow` 时只观察、不采用建议，`off`、超时或失败时继续原流程。已有的路由或复核结果不重复请求。

本项目 Jev 候选来源：暂无已确认的候选 Skill 清单；验证命令以 Commands 节为准；交付物为代码与文档时按 Validation requirements 执行。
