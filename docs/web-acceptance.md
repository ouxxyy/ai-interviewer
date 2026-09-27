# 网页入口（本地 Chrome 实时语音）服务端与数据层验收记录

- 运行时间：2026-09-26T19:24:09.462Z；总耗时 479.8s
- 运行方式：`npm run web:evidence`（真实 Chrome ＋ 真实百炼调用；端口 8919，数据目录 `data/web-evidence`）
- Chrome：`Chrome/153.0.8010.54`（darwin arm64，headless=new）；Node v26.7.0
- 实时模型：`qwen3.8-omni-flash-realtime`；音色固定 `Serena`（音色前置断言，生效值取自 `session.updated`）
- 音频来源：作答语音＝macOS `say` 合成语音的 PCM16@16k，由页面按 100ms 分片推给本地服务（与产品页面上行同一条 WS 协议）；真实麦克风采集链路由 Chrome 假设备单独覆盖（提示音，用于空转写状态）。**真人对着麦克风说话、环境噪声、真实语速仍未验证**。Chrome 153 的 `--use-file-for-fake-audio-capture` 在本机预检为静音（RMS 0.0，默认假设备 0.72），因此未采用。
- 断言总数 **64**，失败 **0**

## 2026-09-27 后端增量验证说明

- 本次增量补充同源静态托管、详情／快照的 `reportSource`、`reviewMeta`、`reviewBasis`，以及迁移 002。
- 已执行 `npm run build`、`npm test`（139/139）和真实本地进程 HTTP smoke；新增回归覆盖同源资源、SPA 回退、无 CORS、迁移保留旧数据、跨重启来源字段与评审基准文本。
- **未重跑 `npm run web:evidence`**：该命令会调用真实百炼并产生费用，本轮没有新增费用授权。所以下方 64/64 仍是 2026-09-26 的既有真实模型证据，不把它冒充为本次增量的实时复测结果。

| # | 步骤 | 耗时 | 断言 |
| --- | --- | --- | --- |
| 1 | 生成作答音频（macOS say 合成，16k 单声道 WAV） | 10132ms | ✅ 生成 6 段作答语音（WAV + PCM16@16k） |
| 2 | 实时模型核定（冻结模型优先，逐个真连并验证逐字朗读） | 4330ms | ✅ 冻结模型 qwen3.8-omni-flash-realtime 可用<br>✅ 选定一个「可用且逐字朗读」的实时模型 |
| 3 | 首次使用告知与建会话 | 11ms | ✅ 告知版本与四类信息齐备<br>✅ 创建会话成功且默认开启两个保存开关 |
| 4 | 材料确认（虚构演示）→ 真实问题计划 → 第 1 题真实语音 | 16300ms | ✅ 问题计划为 3 题且状态进入作答<br>✅ 浏览器收到面试官真实语音分片并实际播放 |
| 5 | 第 1 题作答：浏览器采集 → 服务端代理 → 真实 ASR | 116687ms | ✅ 浏览器真实采集链路可用（getUserMedia + AudioWorklet → 16k PCM，非静音）<br>✅ 作答语音经页面按 100ms 分片推给服务端（与产品页面上行同一协议）<br>✅ 真实 ASR 产出非空转写（每轮 ≥20 字）<br>✅ 每轮转写都确实来自该轮注入语音（4 字片段命中 ≥5）<br>✅ 用户轮与面试官轮都按轮落盘（含音频引用）<br>✅ 回答后进入评审并产出第 1 题反馈 |
| 6 | 第 1 题评审：真实模型五维反馈 + 引用区间独立复算 | 25ms | ✅ 第 1 题反馈通过 feedback 契约<br>✅ 三档维度的引用区间与独立复算逐位一致<br>✅ 状态机停在重答选择点（未被模型带着走） |
| 7 | 重答一次 → 对比评审（只比较两版已确认回答） | 34115ms | ✅ 重答轮回答已进入评审<br>✅ 重答对比产出 added/corrected/stillMissing<br>✅ 重答轮单独成轮（初审与重答可分别回放） |
| 8 | 第 2 题：提问中途打断（取消旧回应 + 清空待播音频） | 3869ms | ✅ 打断后浏览器停止播放且待播队列清空<br>✅ 服务端确认取消旧回应（clearedPending）<br>✅ 打断前确实已经在播音频（不是空打断） |
| 9 | 第 2 题作答（浏览器麦克风链路 → 真实 ASR → 真实评审） | 93298ms | ✅ 第 2 题进入评审并产出反馈<br>✅ 第 2 题反馈过契约 |
| 10 | 第 3 题：真实麦克风链路（Chrome 假设备提示音）→ 空转写落到明确状态 | 30296ms | ✅ 浏览器真实采集链路启动（getUserMedia + AudioWorklet，16k）<br>✅ 麦克风音频真的上行到服务端（分片数 > 0）<br>✅ 空转写状态明确（E_EMPTY_TRANSCRIPT）<br>✅ 空转写不产生用户轮、不进入评审<br>✅ 可重读本题继续（不消耗追问次数） |
| 11 | 第 3 题：作答中暂停 → 停止上行（客户端扣住 + 服务端拒收）→ 恢复后完成作答 | 114404ms | ✅ 作答开始（页面推流通道打开）<br>✅ 暂停期间客户端一个字节都没发出去（扣住不发）<br>✅ 暂停期间服务端明确拒收上行音频（E_UPLINK_PAUSED）<br>✅ 恢复后整段音频都推完（推流字节数 = 音频字节数）<br>✅ 恢复后完成第 3 题并进入评审 |
| 12 | 生成全场报告（真实模型练习点 + 已校验反馈回填） | 8055ms | ✅ 三题完成、状态归档为 ended<br>✅ 报告过 session-report 契约<br>✅ 每题 feedback 原样来自已校验反馈<br>✅ 优先练习点来源已标注（模型 or 反馈派生） |
| 13 | 回放：用户轨与面试官轨按轮下载并在页面里真正播放 | 13200ms | ✅ 两轨都至少有一轮可回放并真正出声<br>✅ 回放来源是磁盘文件（不是内存兜底） |
| 14 | 重启服务后：历史、反馈、报告与音频仍可用 | 272ms | ✅ 重启后会话仍可读（轮次/反馈/报告俱在）<br>✅ 重启后录音文件仍可下载<br>✅ 重启后的会话是历史态（不能继续作答）<br>✅ 对历史会话继续作答被明确拒绝（409） |
| 15 | 两开关：关历史不产生持久记录；关录音不产生音频文件 | 31665ms | ✅ 关历史后不产生新的持久会话记录<br>✅ 关历史后不产生音频文件<br>✅ 关历史的会话在接口里如实标注 persisted=false<br>✅ 关历史的会话仍完成了真实 ASR（不是空跑）<br>✅ 会话列表里查不到关历史的会话<br>✅ 关录音后文本记录照常入库<br>✅ 关录音后磁盘音频文件数不变<br>✅ 关录音后该轮 audioFile 为 null（不伪造路径）<br>✅ 关录音后本场回放只来自内存、磁盘上没有音频文件 |
| 16 | 删除主会话：数据库记录 + 音频文件 + 临时文件的前后对照 | 26ms | ✅ 删除前确有数据库记录与音频文件<br>✅ 删除后数据库无关联记录（独立查询 sqlite 复核）<br>✅ 删除后音频目录不存在<br>✅ 删除后临时文件被一并清理<br>✅ 删除接口返回删除前后对照且自检通过<br>✅ 删除后查询该会话返回 404<br>✅ 删除没有波及其它会话的文件 |
| 17 | 凭证与日志纪律：浏览器侧无密钥、日志无简历全文与完整转写 | 1ms | ✅ 服务日志里没有凭证值<br>✅ 服务日志里没有 sk-* 模式<br>✅ 服务日志里没有作答原文（30 字连续片段）<br>✅ 健康检查只报凭证存在性、不返回值 |

## 断言明细（含实测数字）

### 生成作答音频（macOS say 合成，16k 单声道 WAV）
- PASS 生成 6 段作答语音（WAV + PCM16@16k）｜证据：files=6, dir=data/web-evidence-harness/answer-audio

### 实时模型核定（冻结模型优先，逐个真连并验证逐字朗读）
- PASS 冻结模型 qwen3.8-omni-flash-realtime 可用｜证据：{"model":"qwen3.8-omni-flash-realtime","ok":true,"verbatim":true,"audioBytes":284160,"firstAudioMs":591}
- PASS 选定一个「可用且逐字朗读」的实时模型｜证据：[{"model":"qwen3.8-omni-flash-realtime","ok":true,"verbatim":true,"audioBytes":284160,"firstAudioMs":591},{"model":"qwen3.5-omni-flash-realtime","ok":true,"verbatim":true,"audioBytes":276480,"firstAudioMs":465},{"model":"qwen3-omni-flash-realtime","ok":true,"verbatim":false,"audioBytes":34560,"firstAudioMs":407}]

### 首次使用告知与建会话
- PASS 告知版本与四类信息齐备｜证据：version=disclosure@0.1.0
- PASS 创建会话成功且默认开启两个保存开关｜证据：sid=s-muirt851-b0bafd6d

### 材料确认（虚构演示）→ 真实问题计划 → 第 1 题真实语音
- PASS 问题计划为 3 题且状态进入作答｜证据：state=answer questions=3
- PASS 浏览器收到面试官真实语音分片并实际播放｜证据：events=24 bytes=360960

### 第 1 题作答：浏览器采集 → 服务端代理 → 真实 ASR
- PASS 浏览器真实采集链路可用（getUserMedia + AudioWorklet → 16k PCM，非静音）｜证据：{"ok":true,"seconds":1.5,"transmit":false,"bytesSent":0,"chunksSent":0,"peak":1,"trackLabel":"Fake Default Audio Input"}
- PASS 作答语音经页面按 100ms 分片推给服务端（与产品页面上行同一协议）｜证据：轮数=3
- PASS 真实 ASR 产出非空转写（每轮 ≥20 字）｜证据：[105,94,99]
- PASS 每轮转写都确实来自该轮注入语音（4 字片段命中 ≥5）｜证据：[{"hits":95,"chars":105},{"hits":85,"chars":94},{"hits":90,"chars":99}]
- PASS 用户轮与面试官轮都按轮落盘（含音频引用）｜证据：[["t1","interviewer",{"user":true,"interviewer":true}],["t2","user",{"user":true,"interviewer":true}],["t3","interviewer",{"user":true,"interviewer":true}],["t4","user",{"user":true,"interviewer":true}],["t5","interviewer",{"user":true,"interviewer":true}],["t6","user",{"user":true,"interviewer":true}]]
- PASS 回答后进入评审并产出第 1 题反馈｜证据：state=rewrite 答完轮数=3

### 第 1 题评审：真实模型五维反馈 + 引用区间独立复算
- PASS 第 1 题反馈通过 feedback 契约｜证据：levels={"relevance":"充分清楚","specificity":"部分清楚","contribution":"充分清楚","resultsReflection":"充分清楚","structure":"充分清楚"}
- PASS 三档维度的引用区间与独立复算逐位一致｜证据：located=5/5
- PASS 状态机停在重答选择点（未被模型带着走）｜证据：state=rewrite

### 重答一次 → 对比评审（只比较两版已确认回答）
- PASS 重答轮回答已进入评审｜证据：state=rewrite lastError=null
- PASS 重答对比产出 added/corrected/stillMissing｜证据：{"added":["定义有效投稿标准","统计口径曾修改两次","将规则写入活动文档"],"corrected":[],"stillMissing":["未说明具体量化结果","缺乏对策划落地成效的补充"]}
- PASS 重答轮单独成轮（初审与重答可分别回放）｜证据：userTurns=t2,t4,t6,t7

### 第 2 题：提问中途打断（取消旧回应 + 清空待播音频）
- PASS 打断后浏览器停止播放且待播队列清空｜证据：{"playing":false,"queueLength":0,"clearedQueue":18}
- PASS 服务端确认取消旧回应（clearedPending）｜证据：{"clearedQueue":18,"at":1790450354824,"type":"interrupted","clearedPending":true,"deltasBeforeCancel":26,"deltasAfterCancel":0}
- PASS 打断前确实已经在播音频（不是空打断）｜证据：playing=true playedMs=2287

### 第 2 题作答（浏览器麦克风链路 → 真实 ASR → 真实评审）
- PASS 第 2 题进入评审并产出反馈｜证据：state=rewrite lastError=null
- PASS 第 2 题反馈过契约｜证据：{"relevance":"充分清楚","specificity":"部分清楚","contribution":"充分清楚","resultsReflection":"充分清楚","structure":"充分清楚"}

### 第 3 题：真实麦克风链路（Chrome 假设备提示音）→ 空转写落到明确状态
- PASS 浏览器真实采集链路启动（getUserMedia + AudioWorklet，16k）｜证据：{"ok":true,"sampleRate":16000,"trackLabel":"Fake Default Audio Input"}
- PASS 麦克风音频真的上行到服务端（分片数 > 0）｜证据：{"sid":"s-muirt851-b0bafd6d","state":"answer","paused":false,"capturing":true,"playing":false,"queueLength":0,"playedMs":12844,"bytesSent":128000,"chunksSent":40,"bytesSentWhilePaused":0,"bytesAttemptedWhilePaused":0,"streamSentBytes":0,"streamPending":0,"appendWhilePausedRejected":0,"audioEvents":40,"audioEventBytes":614400,"lastInterrupt":null,"errors":[],"lastError":null,"transcript":"复盘时你发现不同院系参与度存在差异，针对这一困难，你进行了怎样的归因分析，并如何将反思转化为可复用的流程优化？","review":{"contractVersion":"0.2.0","questionId":"q2","reviewBasis":{"turnIds":["t9","t11","t13"],"textVersion":"raw"},"dimensions":{"relevance":{"level":"充分清楚","quote":{"text":"再讲我个人的三个动作：问卷调研定主题，谈下五个院系渠道，写范文做冷启动","start":33,"end":68,"turnId":"t9","textVersion":"raw","matchType":"exact"},"reason":"明确列举了确保投稿量增长的具体执行动作。"},"specificity":{"level":"部分清楚","quote":{"text":"问卷调研定主题，谈下五个院系渠道，写范文做冷启动","start":44,"end":68,"turnId":"t9","textVersion":"raw","matchType":"exact"},"reason":"有具体手段和数量，但缺乏执行细节描述。"},"contribution":{"level":"充分清楚","quote":{"text":"再讲我个人的三个动作","start":33,"end":43,"turnId":"t9","textVersion":"raw","matchType":"exact"},"reason":"使用“我个人的”明确界定个人职责范围。"},"resultsReflection":{"level":"充分清楚","quote":{"text":"最后给出投稿一百四十三篇，增长约八成，参与院系从三个增加到七个的结果","start":69,"end":103,"turnId":"t9","textVersion":"raw","matchType":"exact"},"reason":"提供了详细的数据结果及后续沉淀反思。"},"structure":{"level":"充分清楚","quote":{"text":"如果重答一次，我会先说明活动目标","start":0,"end":16,"turnId":"t9","textVersion":"raw","matchType":"exact"},"reason":"采用总分结构，逻辑顺序清晰连贯。"}},"factGaps":["缺少各具体动作对最终数据贡献的归因分析","未说明在遇到阻碍时如何调整策略"],"topImprovement":"补充具体动作与数据增长之间的因果关联或过程细节","nextFacts":["哪个动作对投稿量提升贡献最大及其依据","执行过程中遇到的主要困难及解决方式"],"reviewVersion":"prompts@0.2.0"},"report":null,"micProbe":null,"peak":0.999969482421875,"deleted":null}
- PASS 空转写状态明确（E_EMPTY_TRANSCRIPT）｜证据：{"code":"E_EMPTY_TRANSCRIPT","message":"这一轮没有识别到说话内容","hint":"按「重读本题」再说一次；不消耗追问次数","at":"2026-09-26T19:21:08.007Z"}
- PASS 空转写不产生用户轮、不进入评审｜证据：turns 7→7 reviews=q1,q2
- PASS 可重读本题继续（不消耗追问次数）｜证据：state=answer lastError=null

### 第 3 题：作答中暂停 → 停止上行（客户端扣住 + 服务端拒收）→ 恢复后完成作答
- PASS 作答开始（页面推流通道打开）｜证据：{"ok":true}
- PASS 暂停期间客户端一个字节都没发出去（扣住不发）｜证据：{"sid":"s-muirt851-b0bafd6d","state":"answer","paused":true,"capturing":false,"playing":false,"queueLength":0,"playedMs":0,"bytesSent":3200,"chunksSent":1,"bytesSentWhilePaused":0,"bytesAttemptedWhilePaused":3200,"streamSentBytes":455978,"streamPending":5,"appendWhilePausedRejected":0,"audioEvents":0,"audioEventBytes":0,"lastInterrupt":null,"errors":[],"lastError":null,"transcript":"","review":null,"report":null,"micProbe":null,"peak":0,"deleted":null}
- PASS 暂停期间服务端明确拒收上行音频（E_UPLINK_PAUSED）｜证据：{"rejectedBefore":0,"rejectedAfter":1,"bytesSentWhilePaused":0}
- PASS 恢复后整段音频都推完（推流字节数 = 音频字节数）｜证据：streamed=455978 计划=455978
- PASS 恢复后完成第 3 题并进入评审｜证据：state=rewrite 答完轮数=4 lastError={"code":"E_EMPTY_TRANSCRIPT","message":"这一轮没有识别到说话内容","hint":"按「重读本题」再说一次；不消耗追问次数","at":"2026-09-26T19:21:39.542Z"}

### 生成全场报告（真实模型练习点 + 已校验反馈回填）
- PASS 三题完成、状态归档为 ended｜证据：completed=3 state=ended
- PASS 报告过 session-report 契约｜证据：["补充关键决策（如选题确定、参与度差异归因）背后的分析逻辑与具体执行动作，避免仅陈述结果或后期复盘","建立具体动作与最终数据/结果之间的因果关联，明确归因过程及策略调整细节"]
- PASS 每题 feedback 原样来自已校验反馈｜证据：reviewed,reviewed,reviewed
- PASS 优先练习点来源已标注（模型 or 反馈派生）｜证据：source=model_priority_practice

### 回放：用户轨与面试官轨按轮下载并在页面里真正播放
- PASS 两轨都至少有一轮可回放并真正出声｜证据：[{"turnId":"t1","track":"user","ok":true,"bytes":361004,"durationSec":7.52,"sampleRate":24000,"source":"file","playedMs":1639},{"turnId":"t1","track":"interviewer","ok":true,"bytes":361004,"durationSec":7.52,"sampleRate":24000,"source":"file","playedMs":3269},{"turnId":"t2","track":"user","ok":true,"bytes":776274,"durationSec":24.257,"sampleRate":24000,"source":"file","playedMs":4997},{"turnId":"t2","track":"interviewer","ok":true,"bytes":776274,"durationSec":24.257,"sampleRate":24000,"source":"file","playedMs":6533},{"turnId":"t3","track":"user","ok":true,"bytes":222764,"durationSec":4.64,"sampleRate":24000,"source":"file","playedMs":8187},{"turnId":"t3","track":"interviewer","ok":true,"bytes":222764,"durationSec":4.64,"sampleRate":24000,"source":"file","playedMs":2187},{"turnId":"t4","track":"user","ok":true,"bytes":687684,"durationSec":21.489,"sampleRate":24000,"source":"file","playedMs":3833},{"turnId":"t4","track":"interviewer","ok":true,"bytes":687684,"durationSec":21.489,"sampleRate":24000,"source":"file","playedMs":5471}]
- PASS 回放来源是磁盘文件（不是内存兜底）｜证据：["t1/user:file","t1/interviewer:file","t2/user:file","t2/interviewer:file","t3/user:file","t3/interviewer:file","t4/user:file","t4/interviewer:file"]

### 重启服务后：历史、反馈、报告与音频仍可用
- PASS 重启后会话仍可读（轮次/反馈/报告俱在）｜证据：turns=20 reviews=3 report=true
- PASS 重启后录音文件仍可下载｜证据：http=200
- PASS 重启后的会话是历史态（不能继续作答）｜证据：live=false
- PASS 对历史会话继续作答被明确拒绝（409）｜证据：http=409 code=E_CONFLICT

### 两开关：关历史不产生持久记录；关录音不产生音频文件
- PASS 关历史后不产生新的持久会话记录｜证据：sessions=1（前 1）
- PASS 关历史后不产生音频文件｜证据：audioFiles=20（前 20）
- PASS 关历史的会话在接口里如实标注 persisted=false｜证据：state=followup transcript=1 轮
- PASS 关历史的会话仍完成了真实 ASR（不是空跑）｜证据：[["interviewer","请结合你策划「毕业故事」"],["user","我遇到的困难是第一次活动"],["interviewer","你提到的“选题建议”具体"]]
- PASS 会话列表里查不到关历史的会话｜证据：total=1
- PASS 关录音后文本记录照常入库｜证据：transcript=复盘时，我最大的反思是前期没有定义清楚什
- PASS 关录音后磁盘音频文件数不变｜证据：audioFiles=20
- PASS 关录音后该轮 audioFile 为 null（不伪造路径）｜证据：audioFile=null
- PASS 关录音后本场回放只来自内存、磁盘上没有音频文件｜证据：http=200 source=memory audioFiles=20

### 删除主会话：数据库记录 + 音频文件 + 临时文件的前后对照
- PASS 删除前确有数据库记录与音频文件｜证据：{"sessions":1,"turns":20,"feedbacks":4} audio=20
- PASS 删除后数据库无关联记录（独立查询 sqlite 复核）｜证据：sessions=0 turns=0 feedbacks=0
- PASS 删除后音频目录不存在｜证据：dir=data/web-evidence/audio/s-muirt851-b0bafd6d
- PASS 删除后临时文件被一并清理｜证据：tmpRemoved=["tmp/uploads/s-muirt851-b0bafd6d-stray-resume.pdf"]
- PASS 删除接口返回删除前后对照且自检通过｜证据：{"rows":{"sessions":0,"turns":0,"feedbacks":0},"audioFiles":[],"tmpFiles":[],"turnsInMemory":0,"memoryAudioKeys":0,"audioDirExists":false}
- PASS 删除后查询该会话返回 404｜证据：http=404
- PASS 删除没有波及其它会话的文件｜证据：before=24 after=4

### 凭证与日志纪律：浏览器侧无密钥、日志无简历全文与完整转写
- PASS 服务日志里没有凭证值｜证据：logBytes=17834
- PASS 服务日志里没有 sk-* 模式｜证据：扫描整份日志
- PASS 服务日志里没有作答原文（30 字连续片段）｜证据：sample=我在毕业季征稿活动里负责…
- PASS 健康检查只报凭证存在性、不返回值｜证据：present=true length=116

## 结论：全部断言通过

## 未做到项与已知限制（如实列出，不计入上表断言）

- **产品界面未实现**：`/harness` 是验收用最小客户端（无设计、无移动端适配）；A／B／C 方案选定后另开前端包。
- **真人麦克风未验证**：本机 Chrome 153 的 `--use-file-for-fake-audio-capture` 预检为静音（RMS 0.0，默认假设备 0.72），所以「带内容的作答」由页面按同一 WS 协议推流注入 `say` 合成语音；真实麦克风链路由 Chrome 假设备（提示音）单独覆盖（空转写状态）。**真人说话、环境噪声、真实语速仍未验证**。
- **自动 VAD 未启用**：沿用 T1-R 的 `turn_detection: null` 手动模式，自动抢话（A10）仍未验证，不写「自动模式已通过」。
- **评审延迟 P95 未达标**：T1-R 的 30.4s（目标 15s）结论依旧成立；本包未做流式渲染或五维拆分。
- **历史会话不能续跑**：重启后可查看／回放／删除，继续作答返回 409（不做跨进程会话恢复）。
- **实时模型上游不稳定**：本机多次观察到 `qwen3.8-omni-flash-realtime` 返回 `COMMON_ERROR`／超时（偶发，随后恢复），服务对瞬时故障换新连接重试一次；如遇持续故障可用 `AI_INTERVIEWER_REALTIME_MODEL` 覆盖，覆盖必须留证。
- **未做**：多用户与鉴权（只绑回环、本机单用户）、HTTPS、流式评审渲染、A8 三入口一致性终验（等网页前端）。

完整结构化数据见 `evidence/web/summary.json`；证据文件 sha256 见 `evidence/web/manifest.json`。
