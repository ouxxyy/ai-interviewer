# AI 面试官 T0 环境基线记录
生成时间：2026-09-26 22:50:21 +0800
生成方式：bash scripts/env-check.sh --write
说明：工具链版本为生成时 shell PATH 解析结果的快照（@ 后为解析路径）。本机存在双套工具链时，不同 PATH 顺序的复跑会得到不同版本号，属 PATH 解析差异，非记录失真。

## 1. 主机与工具链
INFO  OS: macOS 27.0 (26A428)
INFO  架构: arm64 / CPU: Apple M1
INFO  RAM: 16 GB
INFO  node: v26.7.0 @ /opt/homebrew/bin/node
INFO  npm: 11.19.0
INFO  git: git version 2.50.1 (Apple Git-155)
INFO  python3: Python 3.9.6 @ /usr/bin/python3

## 2. 项目目录与 Git 状态
INFO  Git 仓库: . (仓库根，相对路径；本机绝对路径不入文档) @ 56ef42c (branch: main)
INFO  产品代码状态: 尚无产品代码（T0 基线阶段，预期如此）

## 3. 参考源码（固定 commit，MIT，只读设计参考）
PASS  liftoff @ 550e4bf74eab1b329dcb64830ed6172063f34d27
PASS  GPTInterviewer @ 048419cf9b124e566c0423cbfbe9efa14e6fbe36
PASS  liftoff LICENSE.md 存在（MIT）
PASS  GPTInterviewer LICENSE 存在（MIT）

## 4. 阿里百炼凭证（只验证存在性，不读取值）
INFO  环境变量 DASHSCOPE_API_KEY 未设置
INFO  环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID 未设置
INFO  环境变量 ALIBABA_CLOUD_ACCESS_KEY_SECRET 未设置
INFO  环境变量 ALIYUN_API_KEY 未设置
FAIL  阿里百炼凭证在本机不可用：环境变量与 shell 配置均未发现（T1+ 前置条件缺失）

## 5. DashScope 端点连通性（无凭证探测，预期 401）
PASS  dashscope.aliyuncs.com 直连可达，未认证请求被正确拒绝（HTTP 401）

## 6. 网络代理（GitHub 访问前置条件）
PASS  Clash 代理 127.0.0.1:7890 可用（checkout-references.sh 依赖）

## 7. Multica 小队
PASS  multica squad list 可用，开发小队（2057796f-1693-4c1d-96ec-97d2d8472238）在列

## 汇总：PASS=7 FAIL=1
（存在 FAIL 项，详见上方标注；失败项不代表 T0 文档工作受阻，但按事实记录）
