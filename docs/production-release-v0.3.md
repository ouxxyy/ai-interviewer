# 0.3 GitHub 与生产发布（2026-10-02）

已按用户本轮明确授权发布到 GitHub main，并通过 Tabbit computer use 操作宝塔页面终端部署到 https://interview.redboook.cn/。本次模型调用为 0；生产发布通过不代表真实语音、评审质量或宿主终验通过。

## 发布内容与版本

- 功能提交：`32d984115cc3dd6c7791271083ca0753c9a4aa55`（GitHub main）。后续文档提交仅记录此次发布，不改变运行代码。
- 自我介绍＋三道经历题；介绍与经历独立计数、反馈与重答，兼容旧三题历史。
- 出题采用来源编号目录和应用原文回填；评审先回填应用可计算引用坐标再完整校验，失败保留原回答并支持显式重新评审。内容与来源标准保持。
- 生产现有埋点、同源 PCM worklet、默认麦克风和隐私设置保留。
- 后端健康接口实测：`contract@0.3.0`、`rules@0.3.0`、`web-plan@0.3.3`、`disclosure@public-2`。评审提示词源码为 `prompts@0.3.2`，该接口不返回其版本。
- 设置页实测模型名称：文本 `qwen3.8-flash`、实时 `qwen3.8-omni-flash-realtime`、音色 `Maia`。本次未改服务器环境、模型或音色；名称检查不证明上游鉴权与音色可用。

## 验证

| 实际命令或检查 | 输出／结果 |
| --- | --- |
| `npm test` | 294 tests / 294 pass / 0 fail / 0 skipped |
| `node scripts/introduction-browser-smoke.mjs --review-recovery` | `PASS: 27 browser checks; real Chrome + mock models; paidCalls=0` |
| `npm run prototype:run` | `PASS：全部断言通过`；Chrome＋模拟音频，非真实模型 |
| 服务器专用 Node22：`npm ci --no-audit --no-fund`、`npm run build` | 独立发布目录构建成功，`RELEASE_BUILD_OK` |
| `git ls-remote origin refs/heads/main` | 功能发布后返回 `32d984115cc3dd6c7791271083ca0753c9a4aa55` |
| Tabbit 生产浏览器 | 首页显示自我介绍＋3道经历题，开始按钮与设置页可见；安全上下文 true，页面运行时异常 0 |
| HTTPS 与 HTTP | 首页 HTTPS 200；HTTP 301 到同域 HTTPS，未禁用 TLS 校验 |
| 公网 JS／CSS／worklet／analytics | HTTP200，全部字节与本地构建一致；JS 为 `/assets/index-DAa8d26T.js` |
| 原同源统计代理 `/ouba-tracker.js` | GET 200；测试浏览器屏蔽采集，未发送统计事件，后台入库未验证 |
| 匿名 `/api/health` 与 `/harness` | 分别 401／404；已有访客健康接口200并返回新版 |
| 服务与保存配置 | `ActiveState=active`、`User=ai-interviewer`；监听 `127.0.0.1:8918`；既有浏览器设置仍显示已配置 Key，无原值回显 |

第一次沙箱内测试有18项本地监听 EPERM；获得回环监听权限后全量重跑294/294通过。Tabbit 原标签页自动化连接已脱离，读取超时；同一浏览器中新开面板视图恢复原登录状态后完成部署，原用户标签页保留。未用面板私有 API 或 SSH 替代 computer use。音频原型命令重新生成的公开文档包含本机绝对目录，最后一次全量检查据此拒绝1项；将公开文档中的目录按仓库根相对路径呈现后重跑，不改断言或测量值。

免费原始证据见 `evidence/release-v0.3/preflight.json`、`public-http.json`、`deployment.json`、`production-home.png`，以及现有版本目录的浏览器／原型记录。这里不包含访客令牌、真实材料、原始回答或凭证。

## 部署、备份与回滚

切换前服务器 Git HEAD 为 `e1959843f9c6c224d9a50fb36a73849c8b92dc19`，工作区差异限于现有埋点与麦克风文件。先在 `/www/ai-interviewer/releases/20261002-v03-32d9841` 克隆 GitHub main、断言完整提交号并用专用 Node `v22.23.3` 构建；构建期间旧服务继续运行。

切换时取得原备份锁，短暂停止仅 `ai-interviewer.service`，完整归档 data（含 SQLite/WAL、录音和凭证主密钥），再将旧 app 原样移入备份，将新目录移到 `/www/ai-interviewer/app` 并启动。脚本对启动失败配置旧 app 自动恢复；此次未触发自动回滚。数据目录仍在原位置，不删除、不覆盖，不给旧记录改版本。

备份目录：`/www/ai-interviewer/backups/release-20261002-v03-32d9841/`。

- `app/`：旧源码、生产本地修改、构建、node_modules 和 Git 元数据完整保留。
- `data.tar.gz`：1487995 bytes、权限0600；归档目录权限0700；`tar -tzf` 可读检查通过。
- `ai-interviewer.service`、`nginx.conf`：原配置副本。切换前后配置与凭证主密钥的 SHA-256 校验均为 OK，不记录密钥值。
- 服务单实例／专用用户／原定时备份不变，Nginx、TLS、CSP 与统计代理未修改。

如需回滚，仅恢复旧 app，不恢复或删除现有 data：停止本服务，将当前 app 移到一个未占用的 releases 目录，将备份 `app/` 移回 `/www/ai-interviewer/app`，再启动并检查主页与服务状态。短暂重启会中断内存中的练习场次，已保存的历史和录音保留。完整从数据归档恢复演练未执行，不能把归档可读检查称为恢复验证。

## 未验证

整场真实模型语音、真人麦克风、反抢话、评审质量标定、0.3原生文字宿主终验、生产统计后台入库、负载测试与数据恢复演练未验证。历史实调或此次免费替身检查不替代这些结果。没有运行 `web:evidence`、T1-R 或新的付费文本复测。
