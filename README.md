# AI 面试官

基于目标岗位 JD 与本人经历的**中文经历面试训练工具**。目标是让用户（应届生／社招互联网求职者）更准确地回答问题、讲清个人贡献、识别证据缺口并通过重答改进；不声称复刻招聘方 AI 面试评分或预测录用结果。

完整需求与验收标准见 [MULTICA_EXECUTION_PLAN.md](MULTICA_EXECUTION_PLAN.md)（Multica 任务 MYW-84）。

## 当前状态（如实标注）

- **T0 基线：已完成**——工程初始化、可复现环境记录（`docs/environment-baseline.md`）、参考源码审计（`docs/reference-audit.md`）。
- **尚无产品代码**。T1（两条最小技术链）及之后的开发未开始。
- **已知缺口**：本机当前未发现阿里百炼凭证（环境变量与 shell 配置均无，只做了存在性检查）。T1 涉及真实模型调用的部分在此之前只能标记“未验证”。DashScope 端点直连可达（无凭证探测返回 HTTP 401，属预期）。

## 计划技术栈（未实施，T1+ 再落地）

TypeScript 单仓：React＋Vite 前端、Node.js 本地服务（仅绑定 127.0.0.1）、SQLite 记录、独立本地录音文件；实时听说走阿里 Qwen-Omni-Realtime，文本评审走独立文本模型（默认百炼）。当前仓库刻意未引入任何 npm 依赖。

## 可用命令（当前真实存在的）

```bash
npm test                 # 基线静态测试（node --test，无外部依赖）
npm run check:env        # 环境基线核对（打印到 stdout）
bash scripts/env-check.sh --write          # 重新生成 docs/environment-baseline.md
bash scripts/checkout-references.sh        # 按固定 commit 检出两个 MIT 参考仓库到 reference/
```

`checkout-references.sh` 需要可访问 GitHub（本机经 Clash 代理 127.0.0.1:7890，可用 `GIT_PROXY` 覆盖）。`reference/` 已被 gitignore：参考源码只读借鉴，绝不进入产品仓库（见 `docs/reference-audit.md`）。

## 目录结构

```
├── MULTICA_EXECUTION_PLAN.md   # 需求与验收计划（2026-09-23 交接稿）
├── docs/
│   ├── reference-audit.md      # 参考源码审计（固定 commit、行级证据、采用/改写/舍弃）
│   └── environment-baseline.md # T0 环境基线记录（脚本生成，含失败项）
├── scripts/
│   ├── env-check.sh            # 环境核对（凭证只查存在性，不读值）
│   └── checkout-references.sh  # 参考仓库固定 commit 检出
├── test/baseline.test.mjs      # 基线静态断言
└── reference/                  # 第三方参考仓库（gitignore，不入库）
```

## 已知限制

1. 无产品代码、无启动入口——这是 T0 基线的预期状态，不是可运行产品。
2. 阿里百炼凭证缺失，一切云模型能力未验证。
3. 仅在 Apple M1 / macOS / Node 26 环境核对过基线；网页实时语音的验收环境（M1＋Chrome）在 T3 才涉及。
