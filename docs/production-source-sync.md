# 2026-10-02 生产前端差异同步

本地基线及当时 GitHub 主分支均为 `50e8055e3bb198b32bdb612c4077b5d56ccaa1c7`。线上前端含主分支没有的埋点和麦克风修复，因此本轮先恢复这些生产差异，再实施四环节训练。没有执行 Git 拉取、push、生产发布或修改用户数据。

## 来源与范围

- 公开入口：<https://interview.redboook.cn/>。
- 当前入口引用资源：`/assets/index-8TxZNIpd.js`；同名 `.map` 的 `sourcesContent` 恢复五个自有前端源码。
- 另取公开 `ouba-analytics.js?v=2` 与 `pcm16-worklet.js`，保存到 `web-client/public/`；在源码 HTML 保留生产统计标签。
- 来源时间、原本地摘要、生产摘要、文件大小与 Website ID 记录在 `evidence/upgrade-v0.3/production/baseline.json`；原样源码保存于同目录 `source/`，线上 HTML 也已保存。
- 此证据只覆盖公开前端资源，不能据此断言服务器后端源码或 Git 工作区完全同步。

## 恢复的行为

统计沿用站点 ID `4897cfc4-d00f-47b5-b150-07db3748db54`，`data-proxy="same-origin"` 加载同源 tracker 与采集路径。生产统计标签只加载一次；原 CSP 保持 `script-src 'self'`、`connect-src 'self'`。公开 tracker 和 worklet 检查均为 HTTP 200；只读取资源，没有发送采集事件，也没有验证统计后台入库。

麦克风采用同源 worklet，优先选择系统默认输入，只在设备 ID 不支持时回退；页面显示实际输入名称。权限拒绝不改换输入重试，启动失败释放已获得的麦克风。异步采集取消和设备生命周期的新增检查列入本轮回归。

## 基线验证

恢复后 `npm test`：198 tests / 198 pass / 0 fail。原沙箱运行 18 项 `listen EPERM 127.0.0.1`，获准本地监听后全部通过；没有将权限失败当作代码失败或模型验证。

## 构建与发布边界

统计与 worklet 已纳入公开源码，后续 Vite 构建会复制到 `dist/web-client/`。线上 Nginx 的 `/ouba-tracker.js` 与 `/ouba-metrics/api/send` 精确同源代理仍需在部署时保留；本轮不修改站点配置。四环节功能改变后的文件摘要与生产原样快照不同是预期结果，不用新实现覆盖生产来源证据。
