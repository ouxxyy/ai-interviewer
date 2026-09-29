# 公网部署验收 — 2026-09-30

入口：https://interview.redboook.cn/ 。状态：**公网部署可访问，隔离与传输冒烟通过；付费模型/真人麦克风整场未验证**。

## 实际部署

- 通过 Tabbit computer use 操作阿里云 DNS 和宝塔页面/终端；未使用面板私有 API。
- DNS 新增 `interview.redboook.cn → 8.138.87.44`；其余 7 条记录不修改。
- 宝塔新增独立站点 `/www/wwwroot/interview.redboook.cn`；原有 albertou/horse/主域网站保留。
- Let's Encrypt 证书已部署，到期日 2026-12-28；HTTP→HTTPS 301。保留 `/.well-known/acme-challenge/` 文件验证路径。自动续期是面板配置能力，未来续签结果尚未发生。
- Node `v22.23.3` 并行安装，保留原命令行默认 Node20。服务器架构 x86_64；本地开发/测试为 macOS arm64。
- GitHub `ouxxyy/ai-interviewer`：功能提交 `b6a1902`，部署模板提交 `f050a72`。服务器从 GitHub 克隆，源码 `/www/ai-interviewer/app`；`npm ci --no-audit --no-fund && npm run build` 成功。
- systemd `ai-interviewer.service`，专用无登录用户，`127.0.0.1:8918`，失败自动重启、开机启动、600MB 上限。源码只读，持久目录 `/www/ai-interviewer/data` 可写，默认 umask 0077。
- 公网模式不使用部署者全局 API Key；用户自行在设置页提交北京地域百炼 Key。服务器保存加密凭证及按访客隔离的数据；管理员仍有服务器管理权。
- 新站点配置备份：`/www/ai-interviewer/nginx-site-before-proxy.conf` 与 `proxy-before-tuning/`。

## 已完成验证

| 验证 | 实际结果 |
| --- | --- |
| `npm test` | 198 tests / 198 pass / 0 fail |
| `npm run prototype:run` | `PASS：全部断言通过`，Chrome + mock音频链路，非真实模型 |
| 本地真实浏览器设置页 | 百炼申请步骤、官方链接、地域提示与公网存储文案可见，无真实Key输入 |
| 公网浏览器 | 首页与设置页可见，`window.isSecureContext === true`，新访客 Key 未配置 |
| 外部 HTTPS 检查 | `HTTPS 200`，TLS 验证未禁用 |
| 外部 HTTP 检查 | `301 Moved Permanently`，Location 为同域 HTTPS |
| 双访客 HTTP/WSS 冒烟 | 28 个断言通过，见 `evidence/public/https-wss-smoke.json` |
| 备份导致的真实进程重启后 | 6 项持久性检查通过，见 `evidence/public/restart-check.json` |

公网冒烟使用两个新建测试访客及无效合成 Key，没有模型调用（`paidCalls: 0`）。覆盖：匿名 API 401、harness 404、安全 Cookie、初始化不回传身份、配置令牌隔离、Key 不回显、设置隔离、跨源写拒绝、跨访客详情/快照/删除/材料/录音 404、WS 无身份 401/非属主404/本人101并收到 state，以及合成场次删除。真实上游鉴权不在这组测试范围。

第一次测试尝试因 Node22 DNS lookup 适配格式错误，在建立连接前失败；修正测试驱动后重跑通过。首次本地 npm test 在沙箱内因 listen EPERM 失败，获准本地监听后完成回归；另修复新接口文档覆盖、测试重启连接复用及浏览器环境判断后通过。未以失败运行冒充通过。

## 备份

- 已执行一次 `systemctl start ai-interviewer-backup.service`，并恢复主服务。
- `ai-interviewer-backup.timer` 已启用，下一次 2026-09-30 04:30 CST；以后每日 04:30。
- 备份完整 data（含 SQLite/WAL、加密凭证主密钥与录音），root 私有目录/文件，约 7 天保留。
- 备份会短暂停本服务，中断当时在线场次；已有历史保留。仅本服务器备份，**异地备份与从归档完整恢复演练未验证**。

## 遗留与边界

1. `web:evidence` 与对应真实上游复验会产生费用，已单独询问，尚未获本轮答复，**未执行**。历史 `docs/web-acceptance.md` / `docs/t1r-acceptance.md` 不代表本轮公网验收。
2. 公网真人麦克风、真实材料上传后的模型出题、完整三题面试/评审/报告、实时延迟与费用：**未验证**。已验证的是 HTTPS/WSS 与身份/数据边界。
3. 访客 Cookie 是唯一身份，清除后无法恢复访问；清 Cookie 不删除服务器记录。没有登录、跨设备同步或身份找回。
4. 小规模试用容量限制见 `docs/deploy-baota.md`。未进行压力测试，不能宣称生产规模并发能力。
5. 未更改安全组；服务监听只在回环。服务器 `ss -lnt` 确认仅 `127.0.0.1:8918`；外部 curl 返回连接重置/HTTP 000。本机TCP握手探针曾显示连接成功，受透明代理影响不能独立代表上游可达，因此以服务器绑定与HTTP探测一起记录。
6. Jev review 尝试因 `api.typesafe.ai ENOTFOUND` 进入 fallback；本次以实际自动测试和公网验证为依据，不称已通过 Jev 复核。

## 收尾实证

- `systemctl show ai-interviewer-backup.service -p Result -p ExecMainStatus` → `Result=success`, `ExecMainStatus=0`。
- `systemctl show ai-interviewer -p User -p ActiveState` → `User=ai-interviewer`, `ActiveState=active`。
- 首份备份 `data-20260930-013028.tar.gz`，7324 bytes，mode 600；归档目录 mode 700。当时仅测试数据，大小不代表实际用户备份用量。
- `nginx -t` → `syntax is ok`, `test is successful`。
- 合成测试会话已删除，两个测试访客的无效凭证已清空（仅按本轮确定的两个访客摘要更新）；未删除任何真实用户记录。测试身份的空历史/设置仍保留，备份中含合成测试数据，按保留期清理。
- 最后一次 `npm test`：198 tests / 198 pass / 0 fail，7567 ms。
