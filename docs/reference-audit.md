# 参考源码审计（reference-audit）

审计日期：2026-09-26。审计人：developer（Multica 开发小队，MYW-84 T0）。
审计对象：两个 MIT 参考仓库，按固定 commit 浅克隆到 `reference/`（该目录被 `.gitignore` 排除，只读设计参考）。
复现命令：`bash scripts/checkout-references.sh`（经本机 Clash 代理 127.0.0.1:7890 克隆并 checkout 到固定 commit）。

本次为对 2026-09-23 首次检查的**重新独立验证**：原浅克隆已不在本机，本次重新克隆后所有结论均基于本地文件逐行核对，非仅附 GitHub 链接。

## 1. Tameyer41/liftoff @ `550e4bf74eab1b329dcb64830ed6172063f34d27`

- 固定 commit 日期：2023-06-07（`git log -1 --date=short` 实测）
- 许可证：`LICENSE.md`，MIT License，Copyright (c) 2023 Tyler Meyer（已读取文件头确认）

### 已核对的文件与证据

| 文件 | 行级证据（本次实测） | 判断 |
| --- | --- | --- |
| `pages/demo.tsx` | `:7` `import { createFFmpeg, fetchFile } from "@ffmpeg/ffmpeg"`；`:45-48` `corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/..."`；`:64` `MediaRecorder`；`:207` 提交后 `fetch(\`/api/transcribe?...\`)`；`:244` `fetch("/api/generate")` | 录视频 → 浏览器 FFmpeg（CDN）转 MP3 → 提交转写 → 生成反馈的前端主链路属实 |
| `pages/api/transcribe.ts` | `:17` Vercel tmp 目录暂存音频；`:40` 模型名 `"whisper-1"` | 转写走 OpenAI Whisper，非实时 |
| `pages/api/generate.ts` | 生成反馈的服务端入口 | 与 `demo.tsx:244` 对应 |
| `utils/OpenAIStream.ts` | 流式响应工具 | 反馈以自由文本流式展示 |

### 采用 / 改写 / 舍弃决定

| 决定 | 内容 |
| --- | --- |
| 采用（仅思路） | 录制状态管理；转写后反馈的展示节奏；流式反馈的前端消费方式 |
| 改写 | 录视频→改实时音频（阿里 Qwen-Omni-Realtime）；固定问题→问题随 JD／经历动态生成；GPT-3.5 自由文本反馈→五维等级＋可程序校验引用的结构化反馈 |
| 舍弃 | 浏览器端 FFmpeg 及 `unpkg` CDN 分发；Whisper 转写链路；录像形态；一切旧 API 依赖 |
| 复制代码 | **无**。未复制任何代码或较完整提示词，仅借鉴产品思路，故在参考说明中署名即可，无文件级许可保留义务 |

## 2. jiatastic/GPTInterviewer @ `048419cf9b124e566c0423cbfbe9efa14e6fbe36`

- 固定 commit 日期：2024-01-31（`git log -1 --date=short` 实测）
- 许可证：`LICENSE`，MIT License，Copyright (c) 2023 Haoxiang Jia（已读取文件头确认）

### 已核对的文件与证据

| 文件 | 行级证据（本次实测） | 判断 |
| --- | --- | --- |
| `initialization.py` | `:6` `from langchain.chains import RetrievalQA, ConversationChain`；`:56` `RetrievalQA.from_chain_type(...)` 生成 guideline；`:86` `ConversationChain`（对话）；`:92` `ConversationChain`（反馈） | “材料→面试提纲→逐题对话→反馈”链路属实 |
| `prompts/prompts.py` | `:119` Pros；`:121` Cons；`:123` `Score: ... out of 100`；`:125` `Sample Answers` | 反馈模板确含 100 分制与示范答案，与本项目反馈契约冲突，须舍弃 |
| `pages/Resume Screen.py`、`pages/Behavioral Screen.py`、`pages/Professional Screen.py` | 三个 Streamlit 页面：输入、历史、语音入口 | 分段式旧栈的 UI 组织方式 |

### 采用 / 改写 / 舍弃决定

| 决定 | 内容 |
| --- | --- |
| 采用（仅思路） | 从材料生成面试提纲；每轮只问一题；针对事实缺口追问、不重复提问 |
| 改写 | 英文提示词→自写中文提示词；其反馈模板→本项目“证据不足／部分清楚／充分清楚”三档五维契约，显式不采用分数与示范答案 |
| 舍弃 | Streamlit、LangChain、FAISS、Whisper、AWS TTS 整套旧栈；100 分制；Sample Answers（避免诱导编造） |
| 复制代码 | **无**。不直接调用其整段 prompt |

## 3. 产品仓库第三方源码确认

- `reference/` 整目录列入 `.gitignore`（含 `reference/` 规则，`test/baseline.test.mjs` 有断言）；两个参考仓库的源码不会进入产品 Git 历史。
- 截至 T0 完成时，产品仓库内仅含：项目计划（`MULTICA_EXECUTION_PLAN.md`）、基线脚本、文档与测试，**不含任何第三方源码或第三方提示词文本**。
- 若后续任何阶段需复制参考仓库代码或较完整提示词：必须保留原 MIT 版权与许可文本、记录文件级来源，并更新本文件。

## 4. 相关测试

- `test/baseline.test.mjs`（`npm test`）：
  - 断言本审计文件存在且记录两个固定 commit；
  - 断言 `reference/` 两仓库本地 HEAD 与固定 commit 一致；
  - 断言 `.gitignore` 排除 `.env` 与 `reference/`；
  - 断言环境基线记录含失败项标注（当前为阿里凭证缺失）。

## 5. 结论

两个参考仓库的固定 commit、MIT 许可证、关键文件行为均与项目计划（MYW-84 §2）的描述一致，本次以本地检出文件逐行复核确认。复用约束为“只借鉴产品思路，不移植旧栈、不复制代码”，当前产品仓库不含第三方源码。
