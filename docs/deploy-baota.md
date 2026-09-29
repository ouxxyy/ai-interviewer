# 宝塔公网部署（BYOK）

适用于已备案域名和同机 Nginx 反代。Node 使用 **22.12+**（内置 SQLite 与当前 Vite 构建要求），建议项目独立安装，不替换其它项目运行时。服务始终监听 `127.0.0.1:8918`，禁止向公网开放 8918。

## 隔离设计

启用 `AI_INTERVIEWER_PUBLIC=on` 才进入公网模式，本地默认行为保持。与初步方案相比：

- 浏览器使用 `HttpOnly; Secure; SameSite=Strict; Path=/` 的 `__Host-interview-visitor` Cookie，身份不进入 localStorage、URL 或 WS query。这样 `<audio>` 回放和 WS 可复用同一鉴权。`GET /api/bootstrap` 仅返回模式/是否配置，不把身份交给前端 JS。
- 访客身份由随机 UUID 生成；服务器只存 SHA-256 摘要。所有 API（除 bootstrap）和 WS 先查身份，再选择独立的 Store/Manager/Settings/上传及录音目录，跨访客 sid 一律 404。
- 每访客独立 SQLite 延用现有 schema v2，不改写原本地库，不需要给旧数据追加属主。注册库 `public/visitors.sqlite` 单独管理身份和凭证。
- Key 用 AES-256-GCM 加密（AAD 绑定访客），主密钥 `public/credential-master.key` 权限 0600。数据目录需在源码目录外，仅服务账号可读。加密不是对服务器管理员保密；拥有主密钥和数据库的管理员能解密。
- 公网不读取全局 DASHSCOPE_API_KEY。文本与实时 Key 在新建场次时快照绑定，替换 Key 对之后的场次生效。Cookie 丢失无法恢复旧身份；清 Cookie 不删除服务器数据。
- 精确 Origin/Host 校验防跨站请求；公网关闭 harness。配置提交令牌按访客生成/轮换，5 次/分钟限制。

## 部署

建议源码 `/www/ai-interviewer/app`，持久数据 `/www/ai-interviewer/data`。代码可由 GitHub 拉取或在宝塔文件管理上传经过检查的发布包；禁止上传 `.env`、本地 data、真实录音、Git 凭据及无关素材。

```sh
cd /www/ai-interviewer/app
npm ci
npm run build
```

服务器 `.env`（不放全局 API Key）：

```dotenv
AI_INTERVIEWER_PUBLIC=on
AI_INTERVIEWER_PUBLIC_ORIGIN=https://interview.redboook.cn
AI_INTERVIEWER_DATA_DIR=/www/ai-interviewer/data
AI_INTERVIEWER_PORT=8918
NODE_ENV=production
```

如最终域名不同，同步替换 Origin，必须无尾斜杠。按服务器已有 Node 22.12+ 绝对路径启动 `node dist/src/web/cli.js serve`，工作目录为 app。PM2 只启动一个实例；SQLite 和内存会话不支持 cluster。建议非 root 专用账号，数据目录权限 0700；确保自动拉起和开机启动。可采用宝塔 Node 项目自定义启动，或专用 systemd 服务。项目运行时无需 npm run build。

## Nginx

在独立站点启用 HTTPS，申请 Let's Encrypt 证书；HTTP 仅保留 ACME 验证，其余重定向 HTTPS。保留宝塔管理的证书/续期段。HTTPS server 内反代示例：

```nginx
client_max_body_size 16m;
# 专用日志格式建议仅记录 $uri，不记录 query、Cookie 或 Authorization。
location / {
    proxy_pass http://127.0.0.1:8918;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_read_timeout 180s;
}
location /realtime {
    proxy_pass http://127.0.0.1:8918;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
    proxy_buffering off;
}
```

不要给反代添加 Access-Control-Allow-Origin 通配符。Nginx 外层可加每 IP 限流和连接数限制（`limit_req_zone`/`limit_conn_zone` 必须放 http 块，避免修改其它站点行为）。安全组仅开放站点需要的 80/443；现有 SSH/宝塔管理端口按现有管理员策略保留，不擅自修改。

## 备份与回滚

- 初次切换前保留旧站点配置与发布版本；独立目录部署，不覆盖其它站点。
- SQLite WAL 不能只复制主 `.sqlite` 文件。简化方案：短暂停本服务后将整个数据目录备份（含 master key、所有 SQLite、WAV），再启动；在线方案用 SQLite backup API 逐库快照并配套复制录音/主密钥。备份应加密、仅管理员可访问，建议每日一次、保留 7 天；备份实际执行状态应写入验收记录。
- 回滚代码不删除 data；不得生成新 master key 覆盖旧 key。主密钥缺失时启动会拒绝，需从备份恢复。
- PM2/systemd 日志设置轮转和容量限制；不可记录请求体、Cookie、API Key、JD 或完整转写。

## 容量与已知限制

- 当前小规模试用：每访客每分钟 240 个请求、5 场在线会话；服务每分钟签发最多 20 个新身份，总计最多 5000 个；最多 64 个驻留访客，30 分钟无请求后释放内存，历史可重新加载，但无法续接已释放的实时会话。
- 带宽需按 PCM 格式、base64 开销和上下行同时传输实测；不可用“5 Mbps 一定支持 N 人”作承诺。输入 PCM16@16k 约 256 kbps，输出 PCM16@24k 约 384 kbps，JSON/base64 约另加三分之一，代理两端流量均须计入。
- 录音大小取决于有效音频时长：连续双轨 15 分钟原始 PCM 可达约 72 MB，不能按固定 8 MB/场估算。
- 没有登录、身份恢复、跨设备同步或管理后台；仅持有浏览器 Cookie 者可访问该访客数据，管理员仍有服务器管理权限。
- 官方单价未标定；质量标定、真人麦克风、反抢话及公网整场验证，只有实际跑过才标通过。

## 上线检查

1. HTTPS 证书、HTTP 重定向、安全上下文、首页/模型说明/隐私告知可见。
2. 未携带访客身份的 API 为 401；harness 为 404；跨源写入和 WS 被拒。
3. 两个独立浏览器身份配置各自 Key/设置，列表、详情、录音、删除及 WS 互不可访问；不要在测试报告里记录 Cookie 或 Key。
4. 重启进程后历史与 Key 仍可读取，各访客互相隔离。
5. 麦克风授权、wss、简历上传、问答/追问/评审/报告/录音回放，在用户授权 API 费用后实测。
6. 备份、开机拉起和失败日志检查；从备份恢复的演练另记，不能以“配置了计划任务”冒充恢复验证。

百炼申请说明以 [阿里云官方文档](https://help.aliyun.com/zh/model-studio/get-api-key/) 为来源，2026-09-30 核对。需华北2（北京）Key，与应用端点同地域。
