# AI 面试官

基于目标岗位 JD 与本人经历的**中文经历面试训练工具**。目标是让用户（应届生／社招互联网求职者）更准确地回答问题、讲清个人贡献、识别证据缺口并通过重答改进；不声称复刻招聘方 AI 面试评分或预测录用结果。

完整需求与验收标准见 [MULTICA_EXECUTION_PLAN.md](MULTICA_EXECUTION_PLAN.md)（Multica 任务 MYW-84）。

## 当前状态（如实标注）

- **T0 基线：已完成**（reviewer 独立复核 PASS）——工程初始化、可复现环境记录（`docs/environment-baseline.md`）、参考源码审计（`docs/reference-audit.md`）。
- **T1-S 静态验收包：静态通过**——契约冻结（`contract@0.1.0`）、状态机、引用定位器、中文提示词 v1、24 案例起草、评审器 mock、音频 prototype（真跑 M1 Chrome，证据 `docs/t1s-audio-prototype-evidence.md`）、客户端抽象。全部静态验证，`npm test` 50/50。
- **T1-R（真实模型链路）：未开始**——缺阿里百炼凭证；一切与真实模型相关的结论当前只能标「未验证」。mock 只证明契约与链路本身，不证明模型质量。
- **已知缺口**：本机未发现阿里百炼凭证（环境变量与 shell 配置均无，只做存在性检查）。DashScope 端点直连可达（401 预期）。配好密钥后 `scripts/env-check.sh` 会自动转 PASS。

## 技术栈

TypeScript（NodeNext，零框架）。当前依赖仅 `ajv`（Schema 校验）与 `ws`（prototype mock 服务与 CDP）。产品形态（React＋Vite 前端、SQLite、实时语音）在 T1-R 通过后于 T3 落地。

## 可用命令（当前真实存在的）

```bash
npm test                 # 构建并运行全部单测（node --test，当前 50 项）
npm run build            # tsc 编译到 dist/
npm run validate -- <file.json> <contract-name>   # 独立契约校验 CLI
npm run prototype        # 启动音频 prototype mock 服务（127.0.0.1:8917）
npm run prototype:run    # 自动拉起 mock 服务+headless Chrome 跑完整音频链路并生成证据文档
npm run check:env        # 环境基线核对（打印到 stdout）
bash scripts/env-check.sh --write          # 重新生成 docs/environment-baseline.md
bash scripts/checkout-references.sh        # 按固定 commit 检出两个 MIT 参考仓库到 reference/
```

注意：prototype 端口为 8917（8787 曾被本机 ActivityWatch 占用）。`prototype:run` 需要 Chrome（`/Applications/Google Chrome.app`）。

## 目录结构

```
├── MULTICA_EXECUTION_PLAN.md   # 需求与验收计划（2026-09-23 交接稿）
├── docs/
│   ├── reference-audit.md      # 参考源码审计（固定 commit、行级证据、采用/改写/舍弃）
│   ├── environment-baseline.md # T0 环境基线记录（脚本生成，含失败项与 PATH 快照说明）
│   ├── contracts.md            # 契约口径：评审对象、引用定位规则、流程控制
│   └── t1s-audio-prototype-evidence.md  # 音频 prototype 真跑证据（Chrome 153 · M1）
├── src/
│   ├── contracts/              # 五对象 TS 类型 + JSON Schema + 校验器 CLI + 引用定位器
│   ├── state/machine.ts        # 应用层状态机（D2/D5/D6）
│   ├── review/                 # 评审流水线（校验→重试→降级）与 mock fixture
│   ├── prompts/prompts.ts      # 中文提示词 v1（四模板，未标定）
│   ├── clients/                # 百炼/OpenAI 兼容客户端抽象（骨架，未接真实 API）
│   └── prototype/              # 音频 prototype：mock 服务 + 页面 + CDP 证据采集
├── cases/cases.json            # 24 个固定案例（全合成，人工预期标注）
├── scripts/                    # env-check / checkout-references
└── test/                       # 50 项单测（契约/定位器/状态机/mock/提示词/案例/基线）
```

## 已知限制

1. 非可运行产品：无页面入口、无真实模型调用——T1-S 是静态验收包，按 PM 方案「静态通过」口径交付。
2. 阿里百炼凭证缺失：模型 ID/地域/成本核定、真实评审质量、实时语音延迟与可控性、转写质量、提示词标定、案例模型侧校验均「未验证」（属 T1-R）。
3. 提示词 v1 只做了结构与契约字段对齐（静态测试覆盖），未做标定；模型输出质量无任何声明。
4. 客户端抽象为代码就绪的骨架，未经真实 API 调用验证（凭证到位前不可能验证）。
5. 音频 prototype 的音频输入为 Chrome 官方 fake device（真实 getUserMedia/MediaRecorder API，非真人声音）；面试官回应为 mock 服务合成音频。
