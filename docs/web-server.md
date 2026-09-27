# 网页入口：正式产品前端、本地服务与数据层

当前交付包含 `web-client/` 的 React + Vite 正式产品端，以及仅绑 `127.0.0.1` 的本地 Node 服务、实时语音代理、状态机、材料解析、SQLite 历史与录音、显式删除、两个保存开关和首次告知。`/harness` 仍保留为真实 Chrome + 真实模型证据驱动器，不是产品界面。

---

## 1. 启动（M1 Mac）

```bash
# 1) 依赖：Node ≥ 20（本机实测 v26.7.0）；无需数据库服务，SQLite 用 Node 内置 node:sqlite
node --version

# 2) 配置：只放本机，绝不进仓库
cp .env.example .env
# 填入 DASHSCOPE_API_KEY=...（阿里百炼；文本模型与实时语音共用）
# 国内端点不要走全局代理：NO_PROXY=dashscope.aliyuncs.com,localhost,127.0.0.1

# 3) 构建并启动（默认 127.0.0.1:8918）
npm install
npm run web:serve

# 4) 打开正式产品界面
open http://127.0.0.1:8918/

# 可选：只做真实链路验收时打开最小客户端
open http://127.0.0.1:8918/harness
```

产品构建产物默认从 `dist/web-client/` 同源托管；可用 `AI_INTERVIEWER_WEB_DIST` 覆盖目录。
开发期由 Vite 把 `/api` 与 `/realtime` 代理到 `127.0.0.1:8918`，**不要添加 CORS**。
构建目录存在 `index.html` 时，`/` 返回产品页、静态资源按原路径返回、无扩展名路由回退到 `index.html`；
构建目录不存在时，`/` 仍返回服务说明 JSON，`/harness` 始终保留。

启动时会打印四件事：数据落在哪、什么内容发给云模型、两个开关的当前状态、怎么停与怎么删。
**首次麦克风权限**：页面上第一次点「开始回答」时，Chrome 会弹权限框，选「允许」；
若误点拒绝，在地址栏左侧的站点设置里改回「允许」，或点页面上的「重试」。

其他命令：

```bash
npm run web:info                     # 打印数据目录、迁移版本、凭证存在性（不打印值）、当前设置
node dist/src/web/cli.js serve --port 8919 --data-dir data/web-other   # 换端口／换数据目录
```

停止：`Ctrl+C`。删除数据：见 §5。

## 2. 数据放在哪

| 内容 | 位置 |
| --- | --- |
| SQLite 历史库 | `data/web/interview.sqlite`（WAL 模式；迁移见 §6） |
| 录音 | `data/web/audio/<会话 id>/turn-<轮次>-user.wav`、`turn-<轮次>-interviewer.wav` |
| 上传解析的临时文件 | `data/web/tmp/uploads/<会话 id>-<时间戳>-<文件名>`（解析结束即删；删除会话时一并清理） |

`data/` 已被 `.gitignore` 排除。所有入库路径都是**相对数据目录**的相对路径，不含本机绝对路径。

## 3. 对外接口契约

统一错误响应（任何非 2xx 都是这个形状）：

```json
{ "error": { "code": "E_VALIDATION", "message": "字段 jd 至少 10 个字符", "hint": "…", "detail": "…", "halt": true } }
```

`code` 是稳定枚举（见 `src/web/errors.ts`）；`halt: true` 表示**本次会话已按止损停下，不要重试**
（额度不足 1310／bigmodel 等）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 版本（contract/rules/rulesDigest/disclosure）、凭证存在性、活跃会话数 |
| GET | `/api/disclosure` | 首次使用告知全文（结构化：留本机／发云模型／保存位置／删除方式／费用）＋是否已确认 |
| GET/PATCH/POST | `/api/settings` | 两个开关与告知确认；`{"saveHistory":bool,"saveAudio":bool,"disclosureAck":true}` |
| GET | `/api/stats` | 真实会话／虚构演示会话分开计数、轮次数、音频文件数 |
| GET | `/api/sessions?limit&offset&includeSynthetic` | 历史列表，**带分页**（limit 1–100） |
| POST | `/api/sessions` | 建会话：`{synthetic?, saveHistory?, saveAudio?, disclosureAck?}`；未确认告知 → 428 |
| GET | `/api/sessions/:sid` | 会话详情：材料、问题计划、轮次（含音频可用性）、逐题反馈、重答对比、报告，以及 `reportSource`、`reviewMeta`、`reviewBasis`。**这是「详情形状」，不是 live 快照**：不含 `machine`／`currentQuestion`／`pending`／`lastError`／`halted`（回归见 `test/web-api.test.ts`） |
| DELETE | `/api/sessions/:sid` | 显式删除，返回**删除前后对照**（`before`/`after`/`removed`/`verified`） |
| POST | `/api/sessions/:sid/materials` | 确认材料：`{jd, experience, stage, targetRole}` → 真出题 + 朗读第一题 |
| POST | `/api/sessions/:sid/materials/upload?filename=` | 上传 PDF／DOCX（原始字节，≤12MB）→ 提取文本；失败 422 并给退路 |
| POST | `/api/sessions/:sid/materials/retry-plan` | 出题失败后重试（仍失败就不进流程，不造假计划） |
| POST | `/api/sessions/:sid/answer/start` | 开始回答（追问轮会自动先 `FOLLOWUP_DONE` 回到答题） |
| POST | `/api/sessions/:sid/answer/done` | 回答完毕：提交音频 → 真实 ASR → 追问判定／进入评审 |
| POST | `/api/sessions/:sid/answer/repeat-question` | 空转写后重读本题（不消耗追问次数） |
| POST | `/api/sessions/:sid/turns/:tid/revise` | 修订某轮：`{text}`；评审阶段修订 → 作废旧点评并重评审 |
| POST | `/api/sessions/:sid/review` | 对已结束的回答提交评审 |
| POST | `/api/sessions/:sid/rewrite/start` · `/next` | 重答一次；下一题（第 3 题后直接出报告） |
| POST | `/api/sessions/:sid/end` · `/report` | 提前结束（零完成也出报告）；报告生成 |
| POST | `/api/sessions/:sid/pause` · `/resume` · `/interrupt` | 暂停（停止上行）／继续；打断（取消旧回应 + 清空待播） |
| POST | `/api/sessions/:sid/mic-denied` | 浏览器麦克风被拒时上报，落到明确状态 |
| GET | `/api/sessions/:sid/turns/:tid/audio/user\|interviewer` | 按轮下载该轨 WAV（`X-Audio-Source: file\|memory`） |

### WebSocket `/realtime?sid=<会话 id>`

浏览器 → 服务端：

| type | 负载 | 说明 |
| --- | --- | --- |
| `answer.start` | — | 开始回答（等价 HTTP 同名接口） |
| `audio.append` | `audio`（base64 PCM16@16k 单声道） | 上行音频；**暂停期间被拒收**（`E_UPLINK_PAUSED`） |
| `answer.commit` | — | 回答完毕 |
| `repeat.question` / `pause` / `resume` / `interrupt` / `mic.denied` / `ping` | — | 同 HTTP |

服务端 → 浏览器：`state`（状态机快照，含 `reviewBasis`）、`interviewer.audio`（base64 PCM16@24k，边生成边下发）、
`transcript.partial` / `transcript.final`、`audio.ack`、`paused` / `resumed` / `interrupted`、`error`。

**凭证纪律**：浏览器只连本地服务；密钥只存在于服务进程环境里，服务端 → 浏览器的任何消息都不含密钥
（测试逐条断言：`/api/*` 与 WS 消息里不得出现凭证值或 `sk-*` 模式）。

### 详情里的评审来源字段

- `reportSource`：`model_priority_practice | derived_from_validated_feedback | fixed_zero_completion | null`。
- `reviewMeta[]`：每次评审的题号、正常／降级、尝试次数、引用定位数与首次是否通过；迁移 002 后随会话持久化。
- `reviewBasis[questionId]`：`{questionId,text,turnIds,textVersion}`。`text` 严格按 Feedback 中权威
  `turnIds` 顺序，用每轮 `revisedText ?? rawTranscript` 和换行符重建；若任一轮缺失则不返回该题，避免给前端错误偏移。

## 4. 状态机与「出错不生成伪报告」

阶段全部由应用层按 `src/state/machine.ts` 的冻结状态机推进，实时语音模型只负责听与说：

```
materials_review → question → answer → followup? → review → rewrite? → next_question | report → ended
```

- 每题追问 ≤2 次、重答 ≤1 次、重答轮 0 追问（D5）；第 3 题点评后只能进报告；任意非终态可提前结束（D6）。
- 评审走 `runReview`：引用定位用 `src/contracts/quote-locator.ts`，**定不到就重试，重试耗尽降级「暂无法评价」**；
  区间由应用层权威回写，不采信模型自报（`docs/contracts.md`）。
- 各错误状态：断网／额度／超时／麦克风拒绝／空转写／解析失败都有独立 `code`（见 `src/web/errors.ts`）。
  空转写停在 `answer` 并允许重读本题；麦克风拒绝停在 `answer` 并允许重试或结束；**都不产生轮次与反馈**。
- 报告只在 `report` 阶段生成；`perQuestion[].feedback` 一律回填**已通过契约校验的** Feedback 对象；
  `priorityPractice` 要么由模型写且通过「与逐题反馈共享 ≥4 字连续片段」的来源校验，要么回退到
  **派生来源**（直接取已校验反馈里的事实缺口／最值得改的点）；零完成时固定为「本次未完成任何题目，无有效反馈」。
  报告来源标注在会话快照的 `reportSource` 里（`model_priority_practice` / `derived_from_validated_feedback` /
  `fixed_zero_completion`），不冒充模型结论。

## 5. 保存与隐私（两个独立开关）

| 开关 | 打开 | 关闭 |
| --- | --- | --- |
| 保存历史 | 会话／轮次／反馈／报告写入 SQLite | **不产生任何新持久记录**；会话只活在内存里（`persisted:false`） |
| 保存录音 | 用户轨与面试官轨各写成 WAV | 不产生音频文件；`audio_file` 为 `null`，仍记录字节数与 sha256 作为用量证据 |

- **关闭历史时不保存录音**：录音依附会话记录，没有记录就没有可归属的录音。这条不变量由**写入口**强制，
  不是靠界面自觉：`SettingsStore.update()` 与 `POST /api/sessions` 都会把「关历史 + 开录音」收敛成两个关，
  因此任何调用方（含旧版本前端、直接打接口的脚本）都写不出矛盾组合。
- 关闭开关**不会删除旧记录**（旧记录不因关开关被暗中删除）；删除只发生在显式删除。
- 关录音时本场仍可在内存里回放（`X-Audio-Source: memory`），内存上限 24MB，超出后如实返回 404。
- 删除：`DELETE /api/sessions/<id>` → 移除数据库记录、录音文件与该会话的临时文件，并返回删除前后对照
  （`before.rows` / `after.rows` / `removed.audioFiles` / `verified`）。整库清除＝停服后删 `data/web/`。
- 日志：结构化 JSON，凭证一律抹掉；长文本（>120 字）只留长度与 20 字预览，**不记录简历全文、完整转写与音频内容**。

## 6. 数据库迁移

- 迁移脚本在 `src/web/db.ts` 的 `MIGRATIONS`（当前 `002`），`schema_migrations` 记录已应用版本；
  已发布的迁移不再修改，后续变更追加新版本。
- `002 session-review-provenance` 只给 `sessions` 追加 `report_source` 与 `review_meta_json`，不改契约或状态机；
  从 001 升级时旧会话保留，两列初始为 `null`。
- 启动时自动迁移；`npm run web:info` 可查看当前版本。回滚＝用 `MIGRATIONS` 重建库（数据即丢失，需自行备份）。

## 7. 材料解析能力与退路

| 输入 | 行为 |
| --- | --- |
| 粘贴 JD／经历 | 始终可用；JD ≥10 字、经历 ≥30 字才允许确认 |
| DOCX | 内置解析器（自写最小 ZIP ＋ `word/document.xml` → 文本）；不足时再试 macOS `textutil` |
| 文本型 PDF | 内置解析器（`Tj/TJ/'/"` 文本算子 ＋ `FlateDecode` ＋ `ToUnicode` CMap） |
| 扫描件／无文本层 PDF | **明确失败**：`scanned_pdf`，提示直接粘贴；绝不返回乱码冒充成功 |
| 其它格式／超大文件 | `unsupported_type` / `too_large`，同样给退路 |
| 虚构演示 | `cases` 之外的独立样例（`DEMO_MATERIALS`），会话标 `synthetic:true`，统计里与真实报告分开计数 |

### live 快照的唯一来源

`machine`／`currentQuestion`／`pending`／`lastError`／`halted` 只出现在**完整快照**里，即：
`POST /api/sessions` 的 `snapshot`、各动作响应的 `{snapshot}`、以及 WS 的 `state` 消息。
前端把这三种之外的响应（尤其是 `GET /api/sessions/:sid`）当快照用，会在 `machine.questionIndex`
上直接抛异常并让页面白屏；会话页因此用运行时守卫 `isSnapshot()` 拦住非快照值，并在收到 WS 首帧前保持 loading。

## 8. 已知限制（如实标注）

1. **正式产品前端已实现，但本轮未重跑付费的真实模型全流程**：构建、同源托管、API smoke 与实现页面截图已覆盖；付费链路的既有证据仍见 `docs/web-acceptance.md`。
2. **真人麦克风未验证**：本机 Chrome 153 的 `--use-file-for-fake-audio-capture` 预检为**静音**（RMS 0.0，默认假设备 0.72），
   因此验收里的「作答语音」由页面按同一 WS 协议推流注入（`say` 合成语音）；真实麦克风链路由 Chrome 假设备
   （提示音）单独覆盖（空转写状态）。**真人对着麦克风说话、环境噪声、真实语速仍未验证**。
3. **自动 VAD 未启用**：沿用 T1-R 的 `turn_detection: null` 手动模式；自动抢话（A10）仍未验证，
   不写「自动模式已通过」。
4. **评审延迟 P95 未达标**（30.4s vs 15s，T1-R 结论）依旧成立；本包未做流式渲染或五维拆分。
5. **冻结的实时模型当前在上游侧故障**：`qwen3.8-omni-flash-realtime` 实测 `COMMON_ERROR`（服务端内部
   `Connect call failed 127.0.0.1:8090`），因此服务支持 `AI_INTERVIEWER_REALTIME_MODEL` 覆盖；
   覆盖情况必须写进验收记录，**默认值不悄悄改**。是否正式改冻结模型由 lead 决定。
6. **历史会话不能续跑**：重启后可以查看、回放、删除，但继续作答返回 409（本包不做跨进程会话恢复）。
7. **未做**：多用户／鉴权（只绑回环地址，本机单用户）、HTTPS、转写手工修订界面、报告页单轮录音回放、Skill 与 Prompt 入口的 A8 一致性独立终验。
8. **成本**：官方单价未核定（D7），界面不写死金额；每场会话在本地记录 token 与音频字节数供核对。
9. **开发预览入口不进生产包，但源码文本仍在 source map 里**：`?preview=` 与错误画廊都改为 DEV 分支内的
   动态 import，生产 JS 与 source map 的 `sources` 里都没有预览模块，fixture 数据也找不到
   （反向断言见 `test/web-client-bundle.test.ts`）；source map 的 `sourcesContent` 仍包含 `App.tsx`
   自身那段被消除的 DEV 分支源码文本，属于死代码痕迹而非数据泄漏。
10. **`/favicon.ico` 仍返回 404**（页面未声明图标），控制台每次加载会有一条 404 噪声；无功能影响，属既有问题。
11. **重连不会自动重放上一动作**：WS 断开后点「重新连接」只恢复链路，操作要用户自己再来一次；
    需要重放失败动作时用「再试一次」，且服务端阶段对不上时只提示、不发注定被拒的请求。

## 9. 验收与证据

- 命令：`npm run web:evidence`（真实 Chrome ＋ 真实百炼调用；数据写 `data/web-evidence/`，证据写
  `evidence/web/summary.json` 与 `docs/web-acceptance.md`，每条带 sha256 的 manifest 同目录）。
- 离线测试：`npm test`（数据层／材料／编排／实时桥／对外接口，全部不花钱）。
- 断言由代码计算，验收记录里逐条给出实测数字；未做到项集中在 §8 与验收记录末尾。
