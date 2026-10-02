# 生产前端恢复复核

最新结论：**Spec compliance 通过（限 8 文件生产基线恢复）；当前工作源码中的音频生命周期窄修复通过只读复核，原 P1 已关闭，定向音频测试 20/20 通过。** 原样生产来源快照仍保留该历史 P1，下面初评记录予以保留；新增复核仅涉及 `web-client/src/audio.ts` 与 `test/web-client-audio.test.ts`，不评价其他正在实施的 0.3 代码，也不意味着线上已经部署修复。

## 审查边界与证据

- 简报：`/private/tmp/ai-interviewer-v03/production-brief.md`；差异：`production.diff`。
- 固定生产快照：`evidence/upgrade-v0.3/production/source/`；元数据：`evidence/upgrade-v0.3/production/baseline.json`。来源记录为 2026-10-02T03:35:03.879135+00:00、生产 bundle `/assets/index-8TxZNIpd.js`、本地基点 `50e8055e3bb198b32bdb612c4077b5d56ccaa1c7`。
- 独立以 `node` + `node:crypto` 核对：8 个存档源文件的 SHA256、字节数全部匹配 baseline，审查时对应 8 个工作区文件也全部匹配。未重新访问线上。
- 已读取项目执行计划、参考审计、契约说明及现有音频测试；未改源码、未重复全量测试、未调模型。
- 核对已有日志 `/private/tmp/ai-interviewer-production-baseline-20261002.log`：`tests 198 / pass 198 / fail 0 / skipped 0`。这是已有生产恢复验证日志，不是本复核再次运行的结果。

## Spec compliance：通过

| 简报要求 | 审查结果 |
| --- | --- |
| 恢复生产 8 文件且不审 0.3 核心 | 8/8 内容与快照摘要一致，差异限定于指定文件 |
| 统一匿名埋点及网站 ID | `index.html:10` 保留 `4897cfc4-d00f-47b5-b150-07db3748db54`；`ouba-analytics.js:9-19` 限制事件和属性 |
| `data-proxy=same-origin` | HTML 标签保留；脚本 `:47-48` 分别走同源 `/ouba-tracker.js`、`/ouba-metrics` |
| 不发送正文、身份、令牌 | 实际页面调用只发事件名及题目数量；脚本过滤正文/身份/令牌属性，清除普通查询与 hash，session/report 的 sid 脱敏，referrer 仅留 origin，title 固定 |
| 保持 CSP | 音频不再使用 Blob worklet，改为同源 `/pcm16-worklet.js`；这 8 文件没有放宽 CSP 的修改。线上响应头及代理配置未在本次复核重新验证 |
| 系统 default 麦克风与有限回退 | `audio.ts:159-168` 先 exact default，仅 NotFoundError/OverconstrainedError 回退，不对权限拒绝换设备重试 |
| 启动失败释放资源 | `audio.ts:201-225` 捕获失败后释放已持有 track/context；增加 microphone 非空检查，覆盖 AudioContext 创建失败情况 |
| 输入名称可见 | `audio.ts:199,225` 发布/清除标签，`SessionPage.tsx:103,380` 收取并展示；标签没有传给 analytics |

独立离线验证命令：`node` heredoc，以 `node:vm` 执行存档匿名脚本，以 `typescript.transpileModule` 执行存档 observer。结果 `/private/tmp/ai-interviewer-v03/production-offline-checks.json`：**9 项通过、0 项失败**。覆盖同源代理、网站 ID、URL/referrer/title/data 脱敏、未知事件拒绝，以及 synthetic/已结束历史忽略和事件去重。

“启动失败释放”在常规 throw/reject 路径成立；下面的取消竞态属于原生产已有缺陷，不能用本次基线恢复的 Spec 通过替代音频生命周期验收。

## 原始生产基线 Code quality 初评：有条件不通过（历史记录）

### [P1] 待授权采集没有取消标识，关闭后可重新开启热麦

位置：存档 `web-client/src/audio.ts:171-200`；关闭路径 `:124-133`；页面卸载调用位于存档 `SessionPage.tsx:149-154`。

当 `startAnswer()` 正等待 `getUserMedia()`，用户离开会话触发 `close()`。此时 `microphone`、`captureContext` 仍为 null，`stopCapture()` 立即返回；`close()` 也未撤销正在执行的启动。随后权限 Promise 返回，旧 `startCapture()` 继续创建 context/worklet、置 `capturing=true`、报告 listening。已卸载页面的 runtime 没有后续 owner 清理，麦克风 track 可保持存活。此问题对断线期间未完成的初始化也有同类风险；本次只对关闭场景做了独立 mock 复现。

独立离线复现命令：`node` heredoc，以 `typescript.transpileModule` 编译存档 `audio.ts`、`node:vm` 加载；注入延迟 `getUserMedia`、假 AudioContext/worklet/socket，按 `startAnswer → close → 权限返回` 执行。记录见 `/private/tmp/ai-interviewer-v03/production-lifecycle-repro.json`：

```json
{
  "afterClose": { "capturing": false, "stopped": 0, "statuses": ["closed"] },
  "afterGrant": {
    "capturing": true,
    "stopped": 0,
    "statuses": ["closed", "listening"],
    "contextState": "running",
    "startResult": true
  }
}
```

复现完成后再次调用 close 清理 mock。全程没有打开本机麦克风、连接网络或真实模型。

归属：**原生产既有 bug，不是这次 8 文件恢复缺失**。`production.diff` 没有新增异步取消机制；不要在恢复阶段悄悄改掉快照，应纳入 0.3 生命周期修复。建议启动 generation/cancellation 标识，在每个 await 后检查，过期返回的 stream 立即 stop，关闭/断线使初始化失效，并保证并发启动只有一个所有者。最小验收需覆盖授权返回前关闭、addModule/resume 等待时关闭、断线与重复点击，不可仅断言常规 reject 释放。

除此之外，没有在本次 8 文件差异中发现新的阻断性质量问题。埋点失败不影响训练主流程，输入标签由 React 文本渲染。埋点是尽力发送，去重发生在发送前，因此结果不等同于服务端收到次数；本次不把它解读为完整业务审计。

## 未验证与交付建议

本次未验证真人麦克风、真实 ASR、线上 CSP 响应头、Nginx 同源代理或 Umami 后台收数。允许将这 8 文件作为生产基线恢复；原 P1 的当前工作源码修复和定向验证见下节，线上仍不能声称已修复。

## 追加：当前工作源码生命周期窄修复复核

**结论：通过，无新增阻断性缺陷。** 原 P1 在当前源码已解决，生产来源 snapshot 未被改写。

审查对象固定摘要：

- `web-client/src/audio.ts`：`ef90f5bbf2b074303eae902df0859c02ee6559da5273e6ba507da55b396d8953`。
- `test/web-client-audio.test.ts`：`baa32b4dd9141f7eef72f895c69e7331503b145c287e69aa22a1f27230433230`。
- 摘要记录 `/private/tmp/ai-interviewer-v03/production-audio-rereview/reviewed-hashes.json`；后续实现继续变动时应按对应版本再判断。

### 源码判断

- `audio.ts:195-197` 校验 owner 身份、generation、socket 身份/OPEN 和暂停状态；授权、worklet、resume 各 await 后分别在 `:204,208,226` 重查。
- `:250-258` 在等待 context 关闭之前同步递增 generation、撤销 owner/pending start、清除 capturing，并同步释放 track；未返回的授权 Promise 不阻塞取消。
- close、断线、暂停、提交、重连均触发上述撤销。迟到的 stream 进入 finally 清理自己，不再重新置 listening，也不把正常取消误报为权限拒绝。
- `:261-274` 释放的是 owner 私有 stream/context/worklet/gain，track stop 有幂等标志；旧请求晚到不会覆盖或释放新请求资源。catch 在异步清理后也重查 owner，避免旧错误影响新采集。
- `:86-97` 并发 start 共用 pending Promise，已经采集时直接成功，避免重复授权、占用和重复 answer.start；`finally:245` 仅能清掉自己的 pending start。
- 同源 worklet、default 设备选择/有限回退、启动失败释放和输入名称回调仍保留。

### 定向验证与覆盖

先以 `rg --files /private/tmp/ai-interviewer-v03 -g '*.log'` 定位实现者音频日志，核对 `frontend-audio-red.log`：修复前 **20 tests / 11 pass / 9 fail**，包括取消/并发失败，具备真实红阶段记录。该目录当时未找到对应 audio green 日志，因此本复核对当前源文件独立运行了该定向测试，没有重跑全量。

验证命令：用 `node` + `typescript.transpileModule` 将当前 audio、其 playback-queue 依赖和该测试文件编译到独立临时目录（不写项目源码），随后执行：

```bash
node --test /private/tmp/ai-interviewer-v03/production-audio-rereview/test/web-client-audio.test.js
```

实际输出已留 `/private/tmp/ai-interviewer-v03/production-audio-rereview.log`：

```text
1..20
# tests 20
# pass 20
# fail 0
# cancelled 0
# skipped 0
```

新增 11 项覆盖设备语义、worklet/constructor 启动失败、延迟授权下 close/drop/pause/commit/reconnect 五种取消、延迟 worklet/resume 下 close 两种取消、过期授权不影响新采集、并发 start 一次授权一次 start。其余 9 项保留既有断线/主动关闭/重连/发送失败/context resume 检查。

证据边界：这是当前源文件的独立 mock 运行验证；不等同于 TypeScript 类型检查、全量回归、真人麦克风或真实模型验收。UI 实现者仍在继续其他界面工作，暂停现在会真正停止采集，页面需与新的 `isCapturing` 语义保持同步；本次没有审查其正在修改的 UI。
