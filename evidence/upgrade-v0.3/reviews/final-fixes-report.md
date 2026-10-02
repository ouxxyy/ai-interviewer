# 最终三项 P2 修复报告

状态：DONE。最终针对性编译 exit 0，相关离线测试 **34/34 pass，0 fail**。没有执行全量 build/npm test、真实模型/ASR、发布、commit；没有读取 `.env` 值，没有写旧 evidence/summary/manifest、用户素材或旧工作数据。

## 修改内容及范围

仅修改 `src/web/runner.ts`、`src/web/run-evidence.ts`、`test/web-runner.test.ts`；新增 `src/web/evidence-preflight.ts` 与 `test/web-evidence-preflight.test.ts`。未改 frontend、rules、T3、契约或历史目录。

1. 同一未提交回答的重复 `answer.start` 幂等：保留首次开始时间与已收到音频，不提交额外轮次、不增加追问。成功提交、空转写与提交转写异常均结束当前缓存边界；新题、追问、重答、空转写/超时重试仍独立。
2. 原有七段 `ANSWER_TEXTS` 原文移到可独立导入的预检模块；首条仍为应届生内容运营自我介绍。实际生成断言和预检都按数组长度，当前为七份。预检拒绝数量不符、重复路径、缺失文件、空文本或无效 PCM16；不会导入或自执行付费验收入口。
3. 工作目录变为 `data/web-evidence/v0.3.0/run-<UUID>/` 与 `data/web-evidence-harness/v0.3.0/run-<UUID>/`。本次运行只创建新叶目录，已有目标明确拒绝覆盖，删除旧根和 Chrome profile 的 `rmSync` 全部去掉。相关 CLI `--data-dir` 也改为实际本轮 `DATA_DIR`，避免常量隔离而服务仍误用旧目录。成功/中断 summary 都记录本轮 dataDir/harnessDir；`--doc-only` 保持只用既有 summary 的实测 dataDir，路径计算本身不创建目录。

该策略会保留前次验收工作数据，不自动清理；这是保留原始证据的明确选择。本轮未执行真实 web:evidence，正式 0.3 模型/真人麦克风仍未验证。

## TDD 红阶段（免费、隔离目录）

先将旧音频声明/6份断言/旧目录计算与 rmSync 行为原样抽到辅助模块，增加行为测试，再实现新行为。旧目录删除的红测试仅在 mkdtemp 临时夹具内执行，不操作真实旧目录。

命令：

```bash
./node_modules/.bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --esModuleInterop --skipLibCheck --resolveJsonModule --types node --rootDir . --outDir /private/tmp/ai-interviewer-v03/final-fixes-red test/web-runner.test.ts test/web-evidence-preflight.test.ts
node --test --test-name-pattern='暂停恢复重复|新回答边界|空转写后的重试|音频池|新版验收工作|重复使用本轮|验收驱动实际|doc-only' /private/tmp/ai-interviewer-v03/final-fixes-red/test/web-runner.test.js /private/tmp/ai-interviewer-v03/final-fixes-red/test/web-evidence-preflight.test.js
```

编译 exit 0；测试 exit 1，**9 tests，3 pass / 6 fail**。实际失败：七份正确音频被旧断言拒绝；缺一份六份错误接受；旧库/音频哨兵被删除；重复运行目录未拒绝覆盖；服务 CLI 仍旧 data-dir；暂停恢复 WAV 仅 3200 字节而收到 6400。新题/追问/重答不串音、空转写重试与 doc-only 原始路径三个基线通过。

日志：`final-fixes-red-build.log`、`final-fixes-red.log`。

幂等 start 实现后另外补提交转写异常边界红测试：

```bash
./node_modules/.bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --esModuleInterop --skipLibCheck --resolveJsonModule --types node --rootDir . --outDir /private/tmp/ai-interviewer-v03/final-fixes-error-red test/web-runner.test.ts
node --test --test-name-pattern='提交转写失败后重试' /private/tmp/ai-interviewer-v03/final-fixes-error-red/test/web-runner.test.js
```

编译 exit 0，测试 **1 test，0 pass / 1 fail**：重试 WAV 6400 vs 3200。补清理失败提交缓存后最终绿阶段通过。日志：`final-fixes-error-red-build.log`、`final-fixes-error-red.log`。

## 最终绿阶段

```bash
./node_modules/.bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --esModuleInterop --skipLibCheck --resolveJsonModule --types node --rootDir . --outDir /private/tmp/ai-interviewer-v03/final-fixes-green test/web-runner.test.ts test/web-evidence-preflight.test.ts src/web/run-evidence.ts
node --test /private/tmp/ai-interviewer-v03/final-fixes-green/test/web-runner.test.js /private/tmp/ai-interviewer-v03/final-fixes-green/test/web-evidence-preflight.test.js
git diff --check
```

实际输出：编译 **exit 0**；测试 **34 tests，34 pass / 0 fail / 0 skipped**；diff check **exit 0**。日志：`final-fixes-green-build.log`、`final-fixes-green.log`。

关键动态证据来自实际 MockRealtimeClient + InterviewRunner + SQLite/Store/WAV：开始→3200字节 A→暂停（拒绝新上行）→恢复→再开始→3200字节 B→一次提交。WAV PCM=6400且逐字节为 A+B，usage.inputAudioBytes=6400，上游 appendedBytes=6400、commitCount=1，只有一个用户轮次，原始首次开始时间保留，Store回放 WAV与落盘文件一致。另测新追问/重答/题目各自音频独立，以及空转写/超时重试不带失败音频。

音频池七份通过、缺一拒绝、重复/缺失真实文件拒绝；工作目录夹具保留旧数据库、WAV、PCM全部原字节，重复目标拒绝覆盖，再跑使用新run目录且前次哨兵仍在。doc-only 测试只抽取实际纯渲染函数编译执行，未加载验收入口；保留既有summary目录且不改summary，docOnly函数无创建工作目录或调用main。

临时 outDir使用既有只读src/docs/node_modules symlink供REPO_ROOT定位；Runner测试数据写到 `/private/tmp/ai-interviewer-v03/data` 后清理，预检夹具仅在系统临时目录建立并清理。当前生产/历史目录未受这些测试影响。
