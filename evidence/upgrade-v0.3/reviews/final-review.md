# 0.3 最终独立只读审查

最终复核结论：**Spec compliance = PASS（本地实现及免费证据范围）；Code quality = PASS（本次三项 P2 已关闭，无剩余重要发现）。** 真实模型与宿主终验仍未验证；当前最后全量集成由主代理集中执行，不用之前 256/256 代替修改后的结果。下面保留首次发现及关闭证据。没有改产品源码，没有付费模型、线上请求、全量重跑或用户数据读写。

## 修复关闭复核

已读 `[任务文件：final-fixes-report.md]`、当前 Runner/run-evidence/evidence-preflight 源码和新测试，核对 final-fixes-red.log 为 **9 项，3 pass / 6 fail**、green.log 为 **34/34，0 fail**；隔离编译 exit 0。没有重复这些测试或主代理全量。

1. **暂停录音 P2 CLOSED**：Runner 以 `answerStartedAt === null` 判定新回答，同一未提交回答的重复 start 保留 A+B 与首次时间；正常提交、空转写和提交异常清理本地缓存，重答明确新边界。已检查新增新题/追问/重答、空转写和提交失败后重试测试，避免修复导致串音。
2. **7/6 音频池 P2 CLOSED**：七份声明原文迁入无凭证/无自执行的预检模块；实际生成调用 `assertAnswerAudioPool`，数量和日志使用 `ANSWER_TEXTS.length`。七份通过、缺一份/重复文件/缺失文件拒绝均有定向运行证据；预检发生在模型核定之前。
3. **旧验收数据隔离 P2 CLOSED**：data/harness 变为 `v0.3.0/run-UUID` 新叶目录，已有叶目录显式拒绝覆盖，不再存在删除旧根/Profile 的 rmSync；实际服务 CLI `--data-dir` 确实传本轮 DATA_DIR。summary/fatal记录实际目录，doc-only使用既有summary.dataDir，模块级路径计算不创建目录。保留旧数据库/WAV/PCM和前次run、拒绝覆盖的夹具测试均通过。

**独立重放原暂停反例**：执行 `node /private/tmp/ai-interviewer-v03/final-review-closure-probe.mjs`，使用隔离编译 `final-fixes-green`，exit 0。结果 `receivedBytes=6400`、`savedPcmBytes=6400`、首段字节1、后段字节2、`wholeAudioMatches=true`。归档 `final-review-closure-probe.json`；首次3200字节失败记录未覆盖。探针只写新的 `/private/tmp/ai-interviewer-v03/final-review-closure-pause-data`，没有真实调用。当前 `git diff --check` exit 0。

此次关闭只证明本地逻辑与离线数据完整性，不把 mock ASR 转写称为真实模型验证。最终全量、prototype/正式浏览器如因最终修改需更新，由主代理收口并更新验收文档。

## 首次重要发现（现均已关闭）

### [P2] 暂停后重新开始会丢掉暂停前的本地录音

位置：`web-client/src/pages/SessionPage.tsx:438`、`web-client/src/audio.ts:86–89`（新交互触发点）；`src/web/runner.ts:416–417`（清空点）。

真实触发条件：正在作答并已上传部分音频，点击暂停，再恢复，按页面新提示点击「开始作答」，继续说话并提交。暂停现在确实停止麦克风，所以再次开始必走 `startAnswer()`，发送第二次 `answer.start`。服务端无条件清空 `answerChunks` 并重置开始时间，暂停前已收到的音频不再进入最终 WAV；`RealtimeBridge.pause/resume` 只切换标志，没有同步清空实时提供方缓冲。

最小离线探针严格重放上述协议：开始 → 3200 字节 A → 暂停 → 恢复 → 再开始 → 3200 字节 B → 提交。实际 `usage.inputAudioBytes=6400`，最终 WAV 去头后只有 **3200 字节**，第一字节为 B 的 `2`；A 的录音完全丢失。本次 mock 转写保留 A+B，证明当前客户端/服务端协议可以产出完整转写与残缺录音；真实 ASR是否返回全部内容未实调，丢失本地已上传音频则是直接实证。

建议保持“当前未提交回答”身份：恢复采集只继续该回答，或服务端使已有未提交回答的 start 幂等。不要以暂停时提交新轮次来改变回答/追问计数；继续保留迟到授权取消和暂停停麦防线。增加跨前端协议/Runner 的暂停前后音频拼接验证，不能仅验证恢复后 inputAudioBytes 继续增加。

### [P2] 新实调验收的音频池必定被旧数量断言判失败

位置：`src/web/run-evidence.ts:544`，对应 `ANSWER_TEXTS` 为 `:46–54`。

新数组插入介绍后为 **7** 段，生成循环逐段追加，但断言仍为 `answerPcmFiles.length === 6`。在凭证与语音工具可用、开始正式验收时该断言必失败，即使后续流程全部成功也会最终 exit 1，阻断新版实调验收。本次 AST 离线提取确认 `actual=7, asserted=6, passes=false`，未生成付费调用。

建议按实际素材数量更新数量与说明，最好以明确统一常量或数组长度校验，保留介绍素材与三经历题。

### [P2] 新 web 验收仍递归删除旧版原始数据目录

位置：`src/web/run-evidence.ts:38–40` 和 `:530–531`。

本次把 `evidence/web` 与验收 Markdown 隔离到 v0.3.0，却保留 `data/web-evidence`、`data/web-evidence-harness` 固定工作目录；每次 main 在运行前递归删除这两个目录。旧 `evidence/web/summary.json:34,54,936` 明确引用这些旧目录的数据库/音频/合成输入证据。只要首次执行新版 web:evidence，旧原始工作数据就会被删除/覆盖，历史 summary 文件虽未改，其支撑数据不再对应。没有执行删除探针；固定路径与无条件 rmSync 的可达性是直接源码证据。

建议 web 的 data 与 harness 也按版本隔离（当前 T1-R/T2/T3 已这样处理）；不能把当前“历史 evidence Git diff 为空”解释为未来运行保护完整。

## 已核实符合项

- 现行 0.3 计划固定四项、q1 introduction/q2–q4 experience、来源在 JD 或经历单份文本中定位；重复题号归一修复已接入 web/T3。同源介绍五维按题型渲染，网页继续引用 ENTRY_HINTS。
- 状态机按有效 REVIEW_DONE 计数，重答/修订旧反馈失效，降级不能完成；Runner 报告按正式且当前仍存在的反馈回填并和机器计数对账。最后一题点评后立即结束正确计四项。
- Web/T3 的追问/评审正常路径传 kind/JD/stage/targetRole/intent；Skill 默认四项、Prompt 验收明确覆盖介绍与经历；三入口报告来源统一逐字段使用 hasFeedbackSource，不再信任 JSON key/版本/ID/引文。
- 旧 0.1/0.2 Schema 与自动历史校验保持独立；新反馈仅当前契约，Prompt 另查 reviewVersion。旧轮次版本从会话恢复，历史 JSON 不回写。当前历史 evidence/t1r/t2/t3 对 50e8055 的 Git diff 为空。
- 报告介绍/经历单列，经历五维排除介绍、所有重答渲染；新/旧匿名事件使用 schema 2/1，四项有效反馈才 completed，旧报告/synthetic 不补报，白名单与发送异常隔离保留。公开脚本 Website ID、同源 tracker/worklet/CSP保留。
- 麦克风取消 owner/generation/socket 身份校验、授权/worklet/resume await 后复查、同步撤销并停止轨道、并发启动合并机制已核对；上述暂停录音丢失是跨 UI/Runner 新行为，不否定已有迟到授权修复。

## 验证和审查边界

已读取 final-review-brief/shared/final.diff/new-paths、相关执行/契约/来源文档、三个前置独立审查及重点模块当前源码；重点覆盖契约、状态机、Runner/Store、T3、报告、埋点、采集取消、结束行为、真实验收运行器。未重复 256 项全量。已读最后测试日志 **256/256、0 fail**；prototype-final.log 为全部断言 PASS；正式浏览器 summary 为真实 Chrome + fake 设备 + 本地模型/ASR替身、21/21、paidCalls=0、原 CSP 下运行。已有测试均通过，但未覆盖上述新增跨模块场景，不能据其忽略本次反例。

唯一新增离线命令：

`node /private/tmp/ai-interviewer-v03/final-review-probe.mjs`

exit 0；结果在 `/private/tmp/ai-interviewer-v03/final-review-probe.json`；仅写隔离 `/private/tmp/ai-interviewer-v03/final-review-pause-data` SQLite/WAV。未读取 `.env` 内容、未执行远程或真实统计。

验收文档 `docs/upgrade-v0.3-acceptance.md` 仍有最终集成/prototype/browser/旧异步取消「待完成」项，主代理应在修复与最终交付时以实际日志更新；这里作为正在进行的收尾提醒，不另报代码缺陷。真实模型/真人麦克风/质量标定/反抢话/0.3 宿主终验/生产统计入库仍未验证。


归档说明：本机用户路径及临时任务文件标识已脱敏；技术位置、命令与结果保留。原始报告仍保存在本地临时目录。
