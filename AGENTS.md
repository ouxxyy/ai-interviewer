# AGENTS.md

## Project overview

中文经历面试训练工具（三入口 MVP：本地网页／Skill／简版 Prompt），基于 Multica 任务 MYW-84。需求与验收红线以 `MULTICA_EXECUTION_PLAN.md` 为准。

- 当前处于 **T0 基线阶段**：只有工程基线、文档与静态测试，无产品代码，无 npm 依赖。
- 计划栈（T1+ 落地）：TypeScript 单仓（React＋Vite 前端、Node.js 本地服务仅绑定 127.0.0.1、SQLite、本地录音文件）；实时听说走阿里 Qwen-Omni-Realtime，评审走独立文本模型。
- 关键目录：`docs/`（审计与环境记录）、`scripts/`（基线脚本）、`test/`（静态断言）、`reference/`（第三方参考仓库，gitignore，绝不入库）。

## Working rules

- 动手前先读 `MULTICA_EXECUTION_PLAN.md` 与 `docs/reference-audit.md`：参考仓库只借鉴思路，不复制代码或整段提示词；若确需复制，保留 MIT 版权与许可文本并更新审计文件。
- 阶段纪律：T1 两条最小技术链通过前不进入页面全面开发（MYW-84 §6）。
- 密钥只走环境变量／本地服务配置；不得出现在浏览器存储、日志、报告、录屏或 Git 历史。检查凭证只做存在性判断，不读取值。
- 不为形式完整引入生产依赖；服务仅绑定 `127.0.0.1`；不做 push、发布或修改远程资源。
- 不顺手重构无关代码；失败项如实标注，不用“应该能跑”交付。

## Commands（当前真实可用）

```bash
npm test                              # node --test test/，基线静态断言
npm run check:env                     # 环境基线核对（stdout）
bash scripts/env-check.sh --write     # 重新生成 docs/environment-baseline.md
bash scripts/checkout-references.sh   # 固定 commit 检出参考仓库（需 GitHub 代理）
```

尚无启动／构建／Lint 命令——产品代码不存在，不编造。T1+ 引入真实命令后更新本节。

## Validation requirements

- T0 范围的改动：跑 `npm test`，贴实际输出；环境相关结论以 `bash scripts/env-check.sh --write` 的生成记录为准。
- 参考源码相关改动：`docs/reference-audit.md` 的固定 commit 断言必须仍通过。
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
