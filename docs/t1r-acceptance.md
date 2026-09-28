# T1-R 实时验收记录（真实模型链路）

## 2026-09-28 空转写修复后的链 B 复测

- 用户已授权真实 API 费用。命令：`node dist/src/t1r/run-t1r.js chain-b`；进程退出 0，`evidence/t1r/chain-b/summary.json` 的 `ok=true`。
- 本轮有效配置：`qwen3.8-omni-flash-realtime`、`Maia`、`input_audio_transcription.model=qwen3-asr-flash-realtime`。握手 185 ms；输入 802978 字节／25.093 秒合成中文语音，转写完整命中原文，提交至转写完成 323 ms。提问／追问逐字朗读 2/2；3 段输出音频共 691200 字节；取消至停止 73 ms（在途分片 1 个、15360 字节）。
- 本次链 B 证据已覆盖原路径，下方 2026-09-26 的数字为历史结论，不代表此次复测；链 A、延迟 20 轮抽样等未在此次重跑。
- 额外诊断对照：同一合成音频配合前次误用的 SDK 顶层字段时，服务实际回显默认转写模型 `gummy-realtime-v1`，但仍返回 109 字有效转写（252 ms）；再复现上一版提交时清空缓存的行为，提交前预览 102 字、完成事件 109 字，仍成功（260 ms）。因此恢复嵌套参数确实纠正了模型配置，但不能据此断言这些缺陷就是用户实际空转写的根因。
- **真人麦克风仍未验证**：本轮使用既有合成音频；不能将服务端 ASR 成功等同于浏览器从真人麦克风采集成功。

---

- 验收包：MYW-84 / PM 方案 §4「T1-R（需百炼凭证）」四项通过条件 ＋ T1-S 复核的三条修复项
- 执行：developer，2026-09-26 23:2x–次日 00:1x（Asia/Shanghai）
- 代码版本：见本次交付的 Git 提交（本文件与 `evidence/t1r/` 同批入库）
- 运行命令：`npm run build && node dist/src/t1r/run-t1r.js all`（可拆成 `models` / `chain-a` / `chain-b` / `latency`）

> **口径**：T1-S 仍只能是「静态通过」。本文件里写「实时通过」的，只有**本次真跑过**的那些条目；
> 没跑的一律写「未验证 / 未核定」。mock 与静态检查不能替代真实调用，反之真实调用也不能替代
> 真人对着麦克风说话的验收（那属 T3）。

---

## 0. 一句话结论

| 项 | 结论 |
| --- | --- |
| 模型／地域／音色／格式核定 | ✅ 实时通过（`evidence/t1r/models/catalog.json`、`chain-b/summary.json`） |
| 链 A（真实 QuestionPlan → 真实 Feedback） | ✅ 实时通过：5/5 反馈过 Schema，引用 **23/23 可定位**，0 降级，5/5 一次通过 |
| 链 B（真实语音会话：提问→回答→转写→追问→打断） | ✅ 实时通过（服务端链路；真人麦克风采集未做） |
| 技术前提 ① 服务端注入问题／追问文本（D2/A3） | ✅ 成立：链 B 2/2 ＋ 延迟抽样 **20/20 逐字朗读，0 次模型自造问题** |
| 技术前提 ② 面试官音频服务端持久化（A6） | ✅ 成立：3 段面试官音频落盘（610,560 B），可回放 |
| 延迟「答完→首段回应音频」 | ✅ **达标**：P50 909 ms / P95 **1,979 ms**（目标 P95 ≤3 s） |
| 延迟「提交评审→完整点评」 | ❌ **未达标**：P50 13,497 ms / P95 **30,417 ms**，20 轮中 **1 轮降级**（目标 P95 ≤15 s，见 §7.2） |
| 提示词标定 / 24 案例模型侧全量校验 / 反抢话 A10 / 真人麦克风 | ⚠️ **未验证**（见 §8） |

---

## 1. 环境与凭证

| 项 | 值 |
| --- | --- |
| 主机 | Apple M1 / macOS / Node v26.7.0 / darwin arm64 |
| 地域 | `cn-beijing`（`https://dashscope.aliyuncs.com`，中国大陆） |
| 出口 | 本机直连；`.env` 内 `NO_PROXY=dashscope.aliyuncs.com,localhost,127.0.0.1`。Node 的 `fetch`(undici) 与 `ws` 默认不读系统代理，实测全部请求 200，无代理干扰 |
| 凭证 | 显式从项目根 `.env` 加载（`src/t1r/env.ts`），**不依赖 shell 是否加载 `~/.zshrc`**；存在性检查结果：`{"key":"DASHSCOPE_API_KEY","present":true,"length":116}` |
| 密钥边界 | 证据落盘统一过 `assertNoSecret()`：命中密钥值或 `sk-*` 模式即拒绝写入。复核：`evidence/`、`docs/`、`README.md`、`AGENTS.md` 全文扫描无凭证值；`evidence/` 内无本机绝对路径；`.env`、`data/` 均被 gitignore |

网络带宽未做测量（本机家用／办公宽带），列在 §8 未核定项。

---

## 2. 核定并写死的参数（回填 D3／D7）

### 2.1 模型

| 用途 | 模型 ID | 依据 |
| --- | --- | --- |
| 实时语音（听说） | `qwen3.8-omni-flash-realtime` | 账号模型列表 261 项、其中 realtime 系列 29 项；本会话真实跑通（`chain-b/summary.json`） |
| 输入音频 | `pcm16`（16 kHz 单声道），`input_audio_buffer.append` 分片上行 | 实测 |
| 输出音频 | `pcm24`（24 kHz 单声道），`response.audio.delta` base64 | 实测 |
| 用户语音转写（服务端 ASR） | `qwen3-asr-flash-realtime`（会话内显式指定；服务端默认 `gummy-realtime-v1`） | `session.updated` 生效回显 |
| 文本（问题计划／评审／报告） | `qwen3.8-flash`，OpenAI 兼容端点 `/compatible-mode/v1`，`response_format: {"type":"json_object"}`，`enable_thinking: false` | HTTP 200，实测 |

握手：`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<id>`，请求头 `Authorization: Bearer <key>` 与 `OpenAI-Beta: realtime=v1`。实测握手到 `session.created`：链 B **207 ms**（同日多次运行区间 207–249 ms）。

### 2.2 默认音色（D3 回填）—— **必须显式指定，不能依赖服务端默认**

服务端在 `session.created` 里把默认音色报告为 `Chelsie`，但**该音色在实际生成时被拒绝**：

```
<400> InternalError.Algo.InvalidParameter: Voice 'Chelsie' is not supported.
```

逐个探针实测 17 个候选音色（白名单落在 `SUPPORTED_VOICES`，`src/clients/realtime-dashscope.ts`）：

- **可用（15）**：`Serena`、`Katerina`、`Kiki`、`Mia`、`Chloe`、`Sunny`、`Jennifer`、`Dylan`、`Ryan`、`Marcus`、`Peter`、`Rocky`、`Eric`、`Li`、`Aiden`
- **被拒（14）**：`Chelsie`（服务端自报默认）、`Cherry`、`Ethan`、`Jada`、`Elias`、`Roy`、`Sophie`、`Luna`、`Ava`、`Bella`、`Grace`、`Emily`、`Nofish`、`Neil`

**D3 定稿值：`Serena`**（女声、中文、语速适中，符合「温和专业」定位）。`session.updated` 回显确认生效：
`{"voice":"Serena","input_audio_format":"pcm16","output_audio_format":"pcm24","input_audio_transcription":{"model":"qwen3-asr-flash-realtime"}}`。
实现里已把 `REALTIME_DEFAULTS.defaultVoice` 固定为 `Serena`，并保留白名单供 T3 做配置校验。

**T3 必踩的坑（T1-R 复核补充，单次观察）**：在**同一个连接**里撞了 `Chelsie` 的 400 之后再 `session.update` 到
`Serena`，服务端既不回 `session.updated` 也不出音频——**连接不会自愈，必须新开连接**。所以音色不能等撞墙再补救。
T2 已把这条落成代码约束：`DashscopeRealtimeClient.assertVoice()` 在 `session.updated` 后核对生效音色，
不符即抛错；`injectText()`（也就是任何 `response.create` 之前）在断言未通过时**直接拒绝**。
生效配置的脱敏载荷存在 `evidence/t1r/chain-b/session-config.json`（见 §5）。

### 2.3 配额与会话时长

- **配额**：API 未返回任何 `x-ratelimit-*` / quota 响应头（只有 `x-request-id`），**具体配额数值未核定**，需在百炼控制台查看。可核实的事实：账号下 261 个模型可用；本次验收期间（含协议探测、5 次链 A、3 次延迟抽样）**未出现任何 429／限流**。
- **会话时长**：单 WebSocket 连接在 20 轮连续会话（latency 运行）中保持稳定，未触发任何服务端时长限制或被动断连。**官方会话时长上限未能从本沙箱核实 → 未核定**。

### 2.4 成本（D7）

**单价未核定**：本轮所在沙箱无法访问百炼官方定价页（`help.aliyun.com`、`www.alibabacloud.com`、`developer.aliyun.com` 在本环境解析为非公网地址，`web_fetch` 被拒）。按「不拍脑袋写数字」的红线，这里只给**实测用量**与换算公式，不给金额。

**单场（3 题、15–25 分钟）用量模型**（token 数为百炼响应里的真实 `usage`）：

| 组成 | 实测单位用量 | 单场用量 |
| --- | --- | --- |
| 问题计划 ×1 | 1,119 tokens（prompt 769 + completion 350） | ≈1,119 |
| 逐题评审 ×3 | 2,363 tokens/次（prompt 1,552 + completion 811，链 A 5 次调用均值） | ≈7,089（无重试） |
| — 含重试 | 延迟抽样 20 轮实测 2,959 tokens/次（59,171 tokens / 20，该批首次通过率 15/20） | ≈8,877 |
| 全场报告 ×1 | **未实测** | — |
| 用户语音上行 | 实测单轮回答音频 8.4 s（20 轮共 168.7 s） | 按 5–8 轮回答估 42–67 s |
| 面试官音频下行 | 实测单轮 2.7 s（20 轮共 54.7 s PCM24） | 按 8–12 轮估 22–32 s |

> ⚠️ 音频口径说明：本轮的「用户回答」是 macOS `say` 合成语音（见 §6 边界），单轮 8.4 s 短于真人面试回答，
> 因此上表音频用量是**下限估算**，不足以直接判定 A7「单场 ≤¥3」的停止线。
>
> **A7 收敛方法**：拿到官方单价后，`单场成本 = 10,000×P_text_in + 8,000×P_text_out + 60×P_audio_in + 30×P_audio_out`
> （单位：tokens 与秒，价格取百炼定价页同地域档位）。这一条仍标 **未核定**。

---

## 3. 链 A：真实 QuestionPlan → 真实 Feedback

命令：`node dist/src/t1r/run-t1r.js chain-a`；证据：`evidence/t1r/chain-a/`。

**材料**：`cases/cases.json#C01`（合成材料，`synthetic: true`，不得当作真实用户数据）。
**QuestionPlan**：`qwen3.8-flash` 一次调用 5,060 ms / 1,119 tokens，3 道主问题，全部带 `sourceExcerpt`＋`intent`＋`topics`，
过 `question-plan@0.1.0` Schema；**3/3** `sourceExcerpt` 都能在材料原文里真实定位（`planExcerptLocatable`）。

**Feedback**（5 个案例，覆盖「常规良好／空泛长答／团队冒充个人贡献／社招团队冒充／社招研发常规」）：

| 案例 | 结果 | 尝试 | 首次通过 | 引用可定位 | Schema | 单次延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | ok | 1 | ✅ | 5/5 | ✅ | 15,198 ms |
| C02 | ok | 1 | ✅ | 4/4 | ✅ | 13,265 ms |
| C03 | ok | 1 | ✅ | 5/5 | ✅ | 12,763 ms |
| C15 | ok | 1 | ✅ | 4/4 | ✅ | 12,512 ms |
| C19 | ok | 1 | ✅ | 5/5 | ✅ | 8,468 ms |
| **合计** | **5/5 ok，0 降级** | 5 次调用 | **5/5** | **23/23 = 100%** | **5/5** | 均值 12,441 ms |

「引用可定位」是**独立复核**出来的，不是采信流水线自报：脚本对每份 Feedback 重跑 `locateQuote`，
并要求复算区间与流水线写入的 `start/end` 逐位一致、`end` 为整数（`src/t1r/chain-a.ts`）。

> ⚠️ **首次通过率的样本要一起看**：本次链 A 是 5/5 一次通过，但同一提示词在同一批 24 案例上的
> **20 轮延迟抽样只有 15/20 一次通过**（§7.2）。5 个案例的正例样本太小，不足以说「稳定」。
> 失败集中在 `structure`（表达结构）维度：模型倾向用省略号把多个位置串成「前期…然后…做完之后…」来代表整体结构，
> 这种引用**不是连续片段**，定位器按契约**明确拒绝**（不是含糊通过），流水线带针对性整改重试后拿到合规输出。
> 也就是说「100% 可定位」成立于**交付物**层面（降级对象不含任何等级/引用），首次命中率约 **75%**。

---

## 4. 链 B：真实语音会话

命令：`node dist/src/t1r/run-t1r.js chain-b`；证据：`evidence/t1r/chain-b/summary.json` ＋ `events.jsonl`（457 条真实事件）。

会话：`qwen3.8-omni-flash-realtime`，`voice=Serena`，握手 207 ms，`turn_detection: null`（应用层手动控制轮次，符合 D2）。

| 轮 | 动作 | 真实观察 |
| --- | --- | --- |
| 1 | **提问**（服务端注入问题文本） | 模型**逐字**朗读；面试官音频 **6.08 s / 291,840 B PCM**（WAV 291,884 B）落盘；首段音频 **577 ms** |
| 2 | **回答**（真实音频上行 → 服务端 ASR） | 用户音频 25.093 s（802,978 B PCM16）分片推流；`conversation.item.input_audio_transcription.completed` 返回中文转写，**commit→转写 250 ms** |
| 3 | **追问**（服务端注入追问文本） | 逐字朗读；面试官音频 **4.72 s / 226,560 B PCM**（WAV 226,604 B）落盘；首段音频 **592 ms** |
| 4 | **打断**（`response.cancel` 于朗读中途） | 取消前 5 个音频分片 → 取消后**仅 1 个残留分片（15,360 B ≈ 27 ms）**，服务端 `response.done.status = "cancelled"`，**69 ms 内静默**；已落盘片段 1.92 s |

### 技术前提 ①：服务端能否注入下一问题／追问文本？（D2 可行性 / A3）

**能，且逐字生效。** 做法：`conversation.item.create`（`role=user`，`content=[{type:"input_text"}]`）→ `response.create`。
会话层 `instructions` 明确要求「逐字朗读、不得改写增删、不得自行提问」。

- 链 B：2/2 轮逐字（问题 + 追问）
- 延迟抽样：**20/20 轮逐字，0 次模型自造问题**（口径：去标点空白后完全相等）——满足 A3 通过线「注入文本逐字生效，10 轮内 0 次模型自造问题」

样本（去标点后完全相等）：
- 注入 `请介绍你在毕业季征稿活动中承担的具体工作，以及最后的投稿结果。` → 朗读逐字一致
- 注入 `你刚才提到联系了院系宣传委员，具体是怎么分工的？` → 朗读逐字一致

### 技术前提 ②：面试官音频能否在服务端持久化？（A6 / §5 回放范围）

**能。** 面试官音频以 `response.audio.delta`（base64 PCM24）逐片到达服务端，按轮拼接即可落盘：
3 段共 **610,560 B**，峰值幅度 0.40–0.48（非静音），时长 1.92–6.08 s。

→ **回放范围结论：双端音频都可按轮次回放**，不需要降级成「用户音频＋面试官转写文本」，
也不需要用 TTS 合成冒充原始录音（§5 的禁止项因此不触发）。

---

## 5. 证据清单与可复核性

入库（`evidence/t1r/`，**30 个产物；`manifest.json` 的 30/30 条都带 sha256**，可逐条重算比对）：

| 文件 | 内容 |
| --- | --- |
| `models/catalog.json` | 261 模型、29 个 realtime ID、文本模型 200 探针、响应头 |
| `chain-a/question-plan.json` | 真实 QuestionPlan（3 题，含来源片段与意图） |
| `chain-a/feedback-C01/02/03/15/19.json` | 5 份真实 Feedback ＋ 独立复核结果 ＋ 每次调用延迟/用量 |
| `chain-a/summary.json` | 链 A 汇总（含每次尝试的失败原因） |
| `chain-b/summary.json` | 会话生效配置、4 轮明细、两个技术前提结论 |
| `chain-b/events.jsonl` | 457 条真实 WebSocket 事件（**注意：这是 `{t,dir,type}` 投影，不含事件载荷**） |
| `chain-b/session-config.json` | F2-4 补充：`session.created`（服务端默认）与 `session.updated`（本次生效）的**脱敏载荷**＋音色前置断言结果。事件载荷无法从 events.jsonl 复核，看这一份 |
| `latency/summary.json` | 20 轮语音 + 20 轮评审的逐轮样本与 P50/P95 |
| `latency/realtime-turns.jsonl` | 20 轮的转写、音频字节数、首包偏移 |
| `audio/clip-interviewer-question.wav` | 面试官提问片段，**6.08 s / 291,884 B** / sha256（全文件）`13cf299919953d8e…` |
| `audio/clip-interviewer-followup.wav` | 面试官追问片段，**4.72 s / 226,604 B** / sha256（全文件）`e0c8f770ac762ed6…` |
| `run-summary.json` / `manifest.json` | 全量运行汇总与产物清单（含 sha256、逐项用量） |

两个入库片段就是链 B 对应轮次音频的整文件副本：`clip-interviewer-question.wav` 与轮 1 的 WAV 同为 291,884 B，
`clip-interviewer-followup.wav` 与轮 3 的 WAV 同为 226,604 B；已按 `manifest.json` 的 sha256 逐字节重算校验一致。

未入库的大体积原始音频在 `data/t1r/`（已 gitignore，18 MB / 64 个文件）：

| 文件 | 时长 | PCM 字节（WAV 文件） | peak | sha256（PCM 载荷，前 16 位） |
| --- | --- | --- | --- | --- |
| `data/t1r/chain-b-audio/turn1-interviewer-question.wav` | 6.08 s | 291,840（291,884） | 0.4824 | `89b344974408b15a` |
| `data/t1r/chain-b-audio/turn2-user-answer.wav` | 25.093 s | 802,978（803,022） | 0.6682 | `12a445fb9a2f7314` |
| `data/t1r/chain-b-audio/turn3-interviewer-followup.wav` | 4.72 s | 226,560（226,604） | 0.4179 | `72a26a61f1791e79` |
| `data/t1r/chain-b-audio/turn4-interviewer-interrupted.wav` | 1.92 s | 92,160（92,204） | 0.3965 | `77031a46ec59aaca` |

**sha256 口径**（两处记的不是同一样东西，复核时别弄混）：
`manifest.json` 的 `sha256`/`bytes` 是 **WAV 文件整体**（含 44 字节头）；`chain-b/summary.json` 里
`interviewerAudio.sha256`/`bytes` 是 **PCM 载荷**。两者字节数恒差 44（实测：291,884 − 291,840 = 44；226,604 − 226,560 = 44）。

复核方式：`node dist/src/t1r/run-t1r.js all`（会重新产生一组带时间戳的证据；API 费用由用户账户承担）。

---

## 6. 边界：本文件证明了什么、没证明什么

**证明了**（真实链路，非 mock）：

1. 百炼 `qwen3.8-flash` 与 `qwen3.8-omni-flash-realtime` 在本账号可用，参数、格式、音色均已实测核定。
2. 文本链：材料→3 题计划→结构化五维反馈，全部真调模型、真过 Schema、引用真可定位。
3. 语音链：真 WebSocket、真音频上行、真服务端 ASR、真服务端音频落盘、真打断取消。
4. D2 可控性：应用层注入文本被逐字朗读，20 轮零自造问题。
5. A6：双端音频都能落盘。

**没证明**（明确标未验证）：

1. **真人对着麦克风说话**：回答音频由 macOS `say`（Tingting 音色）合成后推流。服务端 ASR、模型、事件链路全部真实，但**不能证明真人麦克风采集质量、环境噪声、口音与真实语速下的表现**——那属 T3 页面链路。
2. **浏览器 ↔ 本地服务的音频链路**：本记录全部在 Node 侧完成。T1-S 的 prototype 证据（`docs/t1s-audio-prototype-evidence.md`）覆盖的是浏览器侧 fake device 链路，两者从未在同一次运行里接起来。
3. **提示词标定**：本轮对提示词做的改动（引用必须连续、禁止省略号、`structure` 维度收紧、顶层字段清单、`<…>` 占位符）都是**结构与契约对齐**，不是标定。24 案例的预期档位仍是人工标注，未经模型侧校验；「代表案例 3 次不跨两档」也没做（属 T2）。
4. **A10 反抢话**：本轮 `turn_detection: null`（应用层手动控制）。服务端确实默认开了 `server_vad`（`threshold 0.5 / silence 800 ms / interrupt_response true`），但没有做「思考停顿被切断 / 抢话 / 丢语句」的对抗测试。**自动模式达标与否未知，不能拿手动模式的结果冒充。**
5. **A5 转写质量**：只覆盖了合成语音的 ASR。「3 段不同语速回答人工比对、关键实体错误 ≤1 处/百字」未做。
6. **A9 反注入**：24 案例里有 3 个注入案例，但本轮只跑了 5 个案例各 1 次 + 延迟抽样的 20 轮，**没有跑「注入类各 3 次、100% 拦截」**。
7. 单人单机单次运行，不是统计意义上的压测；延迟数据受当时网络与账号负载影响。

---

## 7. 延迟（PM §4 目标：≤3 s / ≤15 s）

配置：`qwen3.8-omni-flash-realtime` + `qwen3.8-flash`；地域 `cn-beijing`；本机直连；20 轮/组。
样本与逐轮明细：`evidence/t1r/latency/summary.json`、`latency/realtime-turns.jsonl`。

### 7.1「答完→首段回应音频」—— ✅ 达标

口径：起点＝应用层判定回答结束（`input_audio_buffer.commit`），终点＝面试官回应首个 `response.audio.delta` 到达。

| 指标 | min | **P50** | **P95** | max | mean |
| --- | --- | --- | --- | --- | --- |
| commit→首段回应音频 | 802 ms | **909 ms** | **1,979 ms** | 2,184 ms | 1,044 ms |

拆分（同一批 20 轮）：`commit→ASR 转写完成` P50 258 ms / P95 402 ms；`转写完成→首段音频` P50 ≈650 ms。
20 轮全部成功，0 失败。**P95 1,979 ms ≤ 3,000 ms，达标（余量约 1 s）。**

### 7.2「提交评审→完整点评」—— ❌ 未达标

口径：提交到拿到**完整且过 Schema 的 Feedback**（含必要重试）；统计取**全部 20 个样本**（含重试），
因为用户等的是这次提交的完整结果；只统计成功样本会把重试成本藏起来。

| 口径 | n | min | **P50** | **P95** | max |
| --- | --- | --- | --- | --- | --- |
| 全部样本（含重试与降级） | 20 | 9,144 ms | **13,497 ms** | **30,417 ms** | 34,198 ms |
| 成功样本（含重试成功的 19 轮） | 19 | 9,144 ms | 13,497 ms | **34,198 ms** | 34,198 ms |
| 仅一次通过（15 轮） | 15 | 9,144 ms | 13,239 ms | 15,356 ms | 15,356 ms |

**结论：P50 13.5 s 勉强在 15 s 内，P95 30.4 s 明显超标。列为性能未达标。**
「成功样本 19 轮」这一档的 P95 是 **34,198 ms**，比另外两个 cut 都差——不好看，但如实列出。

**T1-R 复核订正（F1-1）**：第 20 轮（C20）两次尝试都失败（`schema_error` → `quote_not_locatable`），
最终以「暂无法评价」**降级**收场，不是一次成功点评；原记录漏报了这一轮。
同时 `latency/summary.json` 里的 `failures` 原先只统计「抛异常／不合规」，把契约内降级漏掉了，
与同一文件的 `successfulOnlyStats.n = 19` **自相矛盾**。现已把该字段拆成
`{"exceptions": 0, "degraded": 1}`（实时腿为 `{"exceptions": 0, "degraded": 0}`）。
重算只动汇总字段：`samples` 段重算前后 sha256 完全一致（见该文件 `recount.samplesUnchanged: true`），
延迟统计与复核者独立重算的数字仍逐位相同。

**这一项不影响功能结论**：按 A4 停止线，引用失败率 1/20 = **5%**，低于 10% 阈值，不触发任何停止线动作。

**根因（有数据支持）**：输出约 800–900 tokens、实测吞吐 ~69 tokens/s，单次调用本身就要 9–16 s；
P95 被**重试**主导——首次通过率 15/20，重试一次即翻倍到 22–34 s。重试原因分布：
`quote_not_locatable` 4 次（全在 `structure` 维度）、`schema_error` 2 次。

**已做过的两轮修复**（均未改契约，只做结构与提示对齐）：

| 轮次 | 改动 | 效果 |
| --- | --- | --- |
| 1 | 引用必须连续逐字、禁止省略号拼接；`structure` 维度单独提示；顶层字段清单 | 交付层引用可定位率 14/24 → **23/23**；降级 2/5 → 0/5 |
| 2 | `contractVersion`/`reviewVersion`/`questionId`/`reviewBasis` 改由应用层权威回填（元数据不该重试） | 首次通过率 13/20 → **15/20** |

**未做的第三轮（需要 lead／PM 决策，我不单方面放宽契约）**：把模型引用里的省略号片段做「取最长可定位连续子串」的**自动修复**。
它能消掉大部分 `quote_not_locatable` 重试，但它改写了模型给出的引用语义，属于放宽「引用必须由模型给出可定位片段」的约束——
与 P0 修复时「选稳的那条」是同一类判断，应由 reviewer／PM 决定是否接受，而不是我在这里默默开一个口子。

**给 T3 的两条建议**（都不改契约）：
1. **流式渲染**：评审改成流式输出、逐维点亮，用户感知延迟≈首个维度到达（约 1–2 s），而不是等完整 JSON。
2. **拆分调用**：五维并行拆成 5 次短调用，单次输出 ~150 tokens（约 3–4 s），代价是 prompt 成本 ×5（prompt 占 ~2/3 总 token）。

---

## 8. 未做到 / 降级 / 未核定项（如实清单）

| # | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 真人麦克风采集 | 未验证 | 回答音频为 macOS `say` 合成；服务端真实。属 T3 |
| 2 | 浏览器端音频链路 | 未验证（本轮） | 与 T1-S prototype 未在同一运行里打通 |
| 3 | 提示词标定 | 未验证 | 属 T1-R 后续 / T2；本轮只做结构与契约对齐 |
| 4 | 24 案例模型侧全量校验 / 代表案例 3 次不跨两档 | 未验证 | 本轮覆盖 5 案例（链 A）＋ 20 轮（延迟） |
| 5 | A5 转写质量（3 段不同语速人工比对） | 未验证 | 仅覆盖合成语音 ASR |
| 6 | A9 反注入（注入类各 3 次 100% 拦截） | 未验证 | 本轮案例集未含注入类各 3 次 |
| 7 | A10 反抢话 / 自动结束判断 | 未验证 | 本轮用手动 `turn_detection:null`；未做对抗测试，不得用手动结果覆盖自动模式 |
| 8 | 评审延迟 P95 ≤15 s | **未达标** | 见 §7.2，P95 30,417 ms；已列根因与两条 T3 建议 |
| 8b | 延迟抽样 20 轮中的降级面 | **1/20 轮降级** | C20 两次尝试均失败后降级「暂无法评价」（F1-1 订正补报）；失败率 5%，低于 A4 的 10% 阈值 |
| 8c | 注入文本多样性 | **覆盖不足** | A3 的「20/20 逐字」实际只覆盖 **2 句短文本各 10 次**（均为 13–14 字纯中文）。含**数字、英文术语、长句**的注入朗读一致性**未验证**——不要把这个 20/20 读成 20 句不同的题 |
| 9 | 单场成本金额（D7） | 未核定 | 官方定价页在本沙箱不可达；只给实测用量与公式 |
| 10 | 账号配额数值、官方会话时长上限 | 未核定 | API 不返回限流头；需控制台确认 |
| 11 | 网络带宽 | 未测量 | 只记录地域与直连方式 |
| 12 | A7「单场 ≤¥3」停止线 | 无法判定 | 依赖第 9、11 项 |

---

## 9. T1-S 复核三条修复项的落地与验证

| 项 | 修复 | 验证 |
| --- | --- | --- |
| **P0** 定位器折叠索引错位 | `foldWithMap` 改为按折叠后码元逐个 push 源索引；normalized 反算区间后自检 `fold(区间) === fold(引用)`，不成立即 `not_found` | 新增 4 个回归测试（`İ`＋空白差异断言 `Number.isInteger(end)` 与精确区间、长句不漂移、落在展开字符中间时明确拒绝、跨 unicode 不变量扫描）。真机复现 reviewer 两例：`İstanbul 项目`/`İstanbul项目` → `start 0, end 11`（原为 `NaN`）；`İstanbul 项目复盘由我负责。`/`İstanbul项目复盘` → `end 13` 且 `slice = "İstanbul 项目复盘"`。`npm test` 55/55 |
| **P1** `LEGAL_TRANSITIONS` 注释与内容不符 | 拆成 `NORMAL_FLOW_TRANSITIONS`（18 条正常流）＋ `ALL_ACCEPTED_TRANSITIONS`（35 条，含异常/恢复）；新增 `ALL_STATES`/`ALL_EVENTS` 与 `SessionMachine.restore()`（带校验） | 新增**反向断言**：从初始配置做可达性穷举（配置数有界，断言 ≤600），实现接受的任一 `(状态,事件)` 必在表内，且表内每条都确实可达——双向断言，任一漂移即失败 |
| **P2** 文档＋提示词测试强度 | `docs/contracts.md` 补「normalized 时 `quote.text` 与 `basisText.slice(start,end)` 不逐字相等」与自检不变量；四个提示词模板的 JSON 改为**自身即通过 Schema** 的合法示例（占位符统一 `<…>`），`PROMPT_VERSION` 升 `prompts@0.1.0-t1r` | `test/prompts-align.test.ts` 从子串断言升级为「抽出模板 → `validateContract` 真实过 Schema」（含 revised 分支与报告的零完成/正常完成两个分支） |

`npm test`：**55 / 55 通过，0 失败**（本轮改动后重跑）。

---

## 10. 给下一阶段的结论

- **T1-R 的两条链都实时通过了**；T1-S 维持「静态通过」，未被本记录升格。
- **进入 T2 的门槛**：按 PM §4，T1-S 通过 **且** T1-R 两链均实时通过。两链已通过；§7.2 的评审延迟未达标属**性能项**，按 §7 原文「达不到即如实列为性能未达标，不影响已验证的功能项表述」，是否带此项进 T2 由 lead 判定。
- **需要 reviewer 独立复核的点**（我不自我背书终审）：① 链 A 的 23/23 引用定位是脚本自算的，请独立重算；② 「逐字朗读」的判定口径是去标点后相等，请确认这个口径可接受；③ §7.2 里「要不要开自动修复口子」的判断；④ 链 B 用合成语音作为「用户回答」的边界是否被如实标注。
- **D3 已可定稿**：`Serena`，且必须在 `session.update` 里显式指定（服务端默认 `Chelsie` 实测不可用）。
- **D7 差一步**：拿到官方单价即可回填；本轮已给实测用量与公式。
