# 首页联系入口与发布（2026-10-03）

已按用户明确授权发布 GitHub main，并通过 Tabbit computer use 操作已登录宝塔页面终端部署到 https://interview.redboook.cn/。功能提交为 `68dbc224e57907ab066e3c5f1cea15716660c5e2`，本次付费模型调用为 0。

## 改动

首页导航新增“联系我”，点击后以新标签页打开 https://albertou.redboook.cn/，使用 `target="_blank"` 与 `rel="noopener noreferrer"`。仅首页启用；390px 小屏保留文字，导航换行避免横向溢出。改动限于 `BrandHeader.tsx`、`HomePage.tsx` 与样式，没有修改契约、规则、模型、埋点或音频代码。

## 验证

- `npm test`：294 tests / 294 pass / 0 fail / 0 skipped。第一次沙箱内运行有 18 项回环监听 EPERM；获得本地监听权限后完整重跑通过。
- `node scripts/.contact-browser-smoke.tmp.mjs --review-recovery`：`PASS: 28 browser checks; real Chrome + mock models; paidCalls=0`。临时副本基于当前 `scripts/introduction-browser-smoke.mjs`，仅将证据输出转到本次目录并增加一项联系链接属性检查；运行后删除副本，历史证据未覆盖。原有 27 项检查与断言保持。
- 服务器沿用 Node `v22.23.3`，在独立 Git worktree 执行 `npm run build:web`，构建后检查入口包含主页链接。
- 宝塔可见终端返回 `CONTACT_DEPLOY_OK`；生产 HEAD 从 `bec191741464654499bba7bd679e3def744a880d` 快进至功能提交。服务进程发布前后均为 `3693732`，`ai-interviewer.service` 保持 active，没有重启。
- 公网 HTTPS：HTML、JS `/assets/index-iG9b-LNv.js`、CSS `/assets/index-B50kyzIk.css` 均 HTTP200，SHA-256 与本地构建完全一致。
- Tabbit 线上实点：目标新标签页网址正确，标题为“欧八同学｜AI 转型与跳槽涨薪咨询”，`window.opener === null`，原首页网址保留。页面运行时异常 0。
- Tabbit 390×844 视口：联系文字字号 13px、链接位于视口内，页面宽度 390px，没有横向溢出。这是桌面浏览器小屏检查，不作为真机验收。

原始免费替身记录、摘要和线上截图见 `evidence/contact-entry-2026-10-03/`。线上验收页未提交材料或开启练习；统计采集请求被阻止。

## 部署与回滚

用户原生产工作区干净，依赖、服务端和 public 目录与新提交无差异。先在 `/www/ai-interviewer/releases/20261003-contact-68dbc22` 从精确提交构建，仅复用现有 node_modules，没有安装新依赖。然后备份旧前端，将新哈希资源复制到现有资源目录，保留旧资源，最后原子替换 index.html；后端逐请求读取静态文件，因此无需重启服务。

备份目录：`/www/ai-interviewer/backups/contact-20261003-68dbc22/`（权限0700），包含完整旧 `web-client` 构建、旧源码3文件和原提交号。配置、凭证与数据没有部署写入。部署脚本和日志保存在 `/www/ai-interviewer/contact-deploy-20261003.sh` 与同名 `.log`，构建日志为 `/www/ai-interviewer/contact-build-20261003.log`。

运行页面回滚只需将备份的 `web-client/index.html` 复制为 app 静态目录下的临时文件，再原子移到 `index.html`；旧资源仍在，无需删数据或重启后台。如要源码一并回退，应另作逆向提交，不重置用户工作区。本次没有执行回滚演练。

## 未验证

本次仅验收联系入口及既有免费替身流程。真实模型、真人麦克风、质量标定和统计后台入库未验证，历史限制不因本次静态发布而变为通过。
