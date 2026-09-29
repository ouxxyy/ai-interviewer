# T1-S 音频 prototype 运行证据（真实 Chrome · mock 实时服务）

- 运行时间：2026-09-29T17:06:29.088Z
- 运行方式：`npm run prototype:run`（自动拉起 mock 服务与 Chrome，CDP 驱动页面 `window.__proto* ` 接口）
- Chrome：`Chrome/154.0.8037.58`（本机 M1，headless=new）
- 关键 flags：`--use-fake-device-for-media-stream`（Chrome 官方假音频输入设备，走真实 getUserMedia/MediaRecorder/WebAudio API）、`--use-fake-ui-for-media-stream`（自动授予麦克风权限）
- 音频来源声明：用户侧＝fake device 采集的真实 MediaRecorder 输出；面试官侧＝本地 mock 服务合成 WAV。**无真实模型参与，本证据只证明浏览器音频链路与文件链路，不涉及模型质量。**

| # | 步骤 | 耗时 | 断言 |
| --- | --- | --- | --- |
| 1 | 创建会话 | 42ms | ✅ 会话 id 生成 |
| 2 | 采集（turn 1，2.0s，fake mic 走真实 getUserMedia/MediaRecorder） | 2399ms | ✅ 麦克风授权成功（fake device）<br>✅ 采集产生非空音频数据 |
| 3 | 注入问题文本并触发 mock 回应（D2：只朗读注入文本） | 6ms | — |
| 4 | 播放（回应音频已入队并开始播放） | 456ms | ✅ 回应音频正在播放或已入队<br>✅ 播放文本逐字来自注入文本（D2） |
| 5 | 打断：停止当前播放并清空待播队列 | 4ms | ✅ 打断后播放停止<br>✅ 打断后待播队列清空 |
| 6 | 手动「回答完毕」：上传用户音频并按轮次落盘（turn 1） | 11ms | ✅ turn 1 用户音频落盘 >0 字节<br>✅ turn 1 面试官音频落盘 >0 字节 |
| 7 | 采集（turn 2，1.5s） | 1535ms | ✅ turn 2 采集成功 |
| 8 | 手动「回答完毕」（turn 2，含触发回应并完整播放） | 13ms | ✅ turn 2 落盘完成 |
| 9 | 等待回应音频完整播放（约 1.5s） | 1605ms | ✅ 回应音频实际播放了（playedMs>0 且队列排空） |
| 10 | 回放 turn 1 用户音频（从服务器取回并解码播放） | 615ms | ✅ 回放文件取回并解码（duration>0）<br>✅ 回放真实出声（playedMs>0） |
| 11 | 删除前文件清单（服务端视角） | 6ms | ✅ 删除前磁盘上有轮次音频文件 |
| 12 | 删除会话（数据库记录+音频+临时文件） | 5ms | ✅ 删除返回的移除文件数 ≥4<br>✅ 数据目录剩余文件为 0（服务端扫描）<br>✅ 会话记录清空（sessionCount=0） |
| 13 | 删除后查询会话列表与磁盘（OS 级独立复核） | 2ms | ✅ API 会话列表为空<br>✅ OS 级 fs 扫描数据目录为空（无残留） |

## 断言明细
- PASS 会话 id 生成｜证据：s-mumxhjva-4tblvg
- PASS 麦克风授权成功（fake device）｜证据：{"ok":true,"sampleRate":null}
- PASS 采集产生非空音频数据｜证据：blob=24519B
- PASS 回应音频正在播放或已入队｜证据：{"sid":"s-mumxhjva-4tblvg","recording":false,"playing":true,"queueLength":0,"playedMs":431,"lastBlobSize":24519,"micDenied":false,"injectedText":"第一题：请介绍你做过的一个最有代表性的项目","lastResponseText":"第一题：请介绍你做过的一个最有代表性的项目","turns":[],"deleted":false,"wsReady":true}
- PASS 播放文本逐字来自注入文本（D2）｜证据：{"injected":"第一题：请介绍你做过的一个最有代表性的项目","response":"第一题：请介绍你做过的一个最有代表性的项目"}
- PASS 打断后播放停止｜证据：{"sid":"s-mumxhjva-4tblvg","recording":false,"playing":false,"queueLength":0,"playedMs":434,"lastBlobSize":24519,"micDenied":false,"injectedText":"第一题：请介绍你做过的一个最有代表性的项目","lastResponseText":"第一题：请介绍你做过的一个最有代表性的项目","turns":[],"deleted":false,"wsReady":true}
- PASS 打断后待播队列清空｜证据：cleared=0, queue=0
- PASS turn 1 用户音频落盘 >0 字节｜证据：{"tid":"1","userBytes":24519,"interviewerBytes":38444}
- PASS turn 1 面试官音频落盘 >0 字节｜证据：{"tid":"1","userBytes":24519,"interviewerBytes":38444}
- PASS turn 2 采集成功｜证据：{"ok":true,"sampleRate":null}
- PASS turn 2 落盘完成｜证据：{"tid":"2","userBytes":15479,"interviewerBytes":38444}
- PASS 回应音频实际播放了（playedMs>0 且队列排空）｜证据：{"sid":"s-mumxhjva-4tblvg","recording":false,"playing":false,"queueLength":0,"playedMs":1649,"lastBlobSize":15479,"micDenied":false,"injectedText":"第二题：这件事里你个人的贡献是什么","lastResponseText":"第二题：这件事里你个人的贡献是什么","turns":[{"tid":"1","userBytes":24519,"interviewerBytes":38444},{"tid":"2","userBytes":15479,"interviewerBytes":38444}],"deleted":false,"wsReady":true}
- PASS 回放文件取回并解码（duration>0）｜证据：{"tid":"1","bytes":24519,"durationSec":1.98,"playedMs":603}
- PASS 回放真实出声（playedMs>0）｜证据：{"tid":"1","bytes":24519,"durationSec":1.98,"playedMs":603}
- PASS 删除前磁盘上有轮次音频文件｜证据：["s-mumxhjva-4tblvg/turn-1-interviewer.wav","s-mumxhjva-4tblvg/turn-1-user.webm","s-mumxhjva-4tblvg/turn-2-interviewer.wav","s-mumxhjva-4tblvg/turn-2-user.webm"]
- PASS 删除返回的移除文件数 ≥4｜证据：["s-mumxhjva-4tblvg/turn-1-interviewer.wav","s-mumxhjva-4tblvg/turn-1-user.webm","s-mumxhjva-4tblvg/turn-2-interviewer.wav","s-mumxhjva-4tblvg/turn-2-user.webm"]
- PASS 数据目录剩余文件为 0（服务端扫描）｜证据：[]
- PASS 会话记录清空（sessionCount=0）｜证据：sessionCount=0
- PASS API 会话列表为空｜证据：{"sessions":[]}
- PASS OS 级 fs 扫描数据目录为空（无残留）｜证据：data/prototype 下残留: []

## 结论：静态通过（浏览器音频链路与文件链路全部断言通过）

总耗时 12020ms。删除后 OS 级扫描 `data/prototype` 为空（见最后两步断言）。