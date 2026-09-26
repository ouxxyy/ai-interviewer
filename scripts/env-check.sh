#!/usr/bin/env bash
# T0 可复现环境记录：逐项核对基线环境并输出结果。
# 凭证只检查「是否存在」，不读取、不打印任何密钥值。
# 用法：bash scripts/env-check.sh            # 输出到 stdout
#       bash scripts/env-check.sh --write    # 同时写入 docs/environment-baseline.md
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIFTOFF_SHA="550e4bf74eab1b329dcb64830ed6172063f34d27"
GPTI_SHA="048419cf9b124e566c0423cbfbe9efa14e6fbe36"
SQUAD_ID="2057796f-1693-4c1d-96ec-97d2d8472238"
OUT_FILE="$ROOT/docs/environment-baseline.md"

if [ "${1:-}" = "--write" ]; then
  mkdir -p "$ROOT/docs"
  : > "$OUT_FILE"
  exec > >(tee "$OUT_FILE") 2>&1
fi

PASS=0; FAIL=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
info() { echo "INFO  $1"; }

echo "# AI 面试官 T0 环境基线记录"
echo "生成时间：$(date '+%Y-%m-%d %H:%M:%S %z')"
echo "生成方式：bash scripts/env-check.sh --write"
echo "说明：工具链版本为生成时 shell PATH 解析结果的快照（@ 后为解析路径）。本机存在双套工具链时，不同 PATH 顺序的复跑会得到不同版本号，属 PATH 解析差异，非记录失真。"
echo

echo "## 1. 主机与工具链"
info "OS: $(sw_vers -productName) $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
info "架构: $(uname -m) / CPU: $(/usr/sbin/sysctl -n machdep.cpu.brand_string)"
info "RAM: $(echo "scale=0; $(/usr/sbin/sysctl -n hw.memsize)/1073741824" | bc) GB"
info "node: $(node --version 2>&1) @ $(command -v node 2>/dev/null || echo '未解析')"
info "npm: $(npm --version 2>&1)"
info "git: $(git --version 2>&1)"
info "python3: $(python3 --version 2>&1) @ $(command -v python3 2>/dev/null || echo '未解析')"
echo

echo "## 2. 项目目录与 Git 状态"
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SHORT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '尚无提交')"
  info "Git 仓库: $ROOT @ ${SHORT} (branch: $(git -C "$ROOT" branch --show-current))"
else
  bad "Git 仓库未初始化"
fi
info "产品代码状态: $( [ -d "$ROOT/src" ] && echo 'src/ 已存在' || echo '尚无产品代码（T0 基线阶段，预期如此）')"
echo

echo "## 3. 参考源码（固定 commit，MIT，只读设计参考）"
if [ -d "$ROOT/reference/liftoff/.git" ]; then
  sha="$(git -C "$ROOT/reference/liftoff" rev-parse HEAD)"
  [ "$sha" = "$LIFTOFF_SHA" ] && ok "liftoff @ $sha" || bad "liftoff HEAD $sha != $LIFTOFF_SHA"
else
  bad "liftoff 未检出（运行 bash scripts/checkout-references.sh）"
fi
if [ -d "$ROOT/reference/GPTInterviewer/.git" ]; then
  sha="$(git -C "$ROOT/reference/GPTInterviewer" rev-parse HEAD)"
  [ "$sha" = "$GPTI_SHA" ] && ok "GPTInterviewer @ $sha" || bad "GPTInterviewer HEAD $sha != $GPTI_SHA"
else
  bad "GPTInterviewer 未检出（运行 bash scripts/checkout-references.sh）"
fi
[ -f "$ROOT/reference/liftoff/LICENSE.md" ] && ok "liftoff LICENSE.md 存在（MIT）" || bad "liftoff 许可证文件缺失"
[ -f "$ROOT/reference/GPTInterviewer/LICENSE" ] && ok "GPTInterviewer LICENSE 存在（MIT）" || bad "GPTInterviewer 许可证文件缺失"
echo

echo "## 4. 阿里百炼凭证（只验证存在性，不读取值）"
CRED_FOUND=0
for v in DASHSCOPE_API_KEY ALIBABA_CLOUD_ACCESS_KEY_ID ALIBABA_CLOUD_ACCESS_KEY_SECRET ALIYUN_API_KEY; do
  if [ -n "${!v:-}" ]; then ok "环境变量 $v 已设置"; CRED_FOUND=1; else info "环境变量 $v 未设置"; fi
done
CRED_PROFILE_COUNT=$(cat ~/.zshrc ~/.zprofile ~/.zshenv ~/.bash_profile ~/.profile 2>/dev/null | grep -c -E "DASHSCOPE|ALIBABA_CLOUD|ALIYUN" || true)
if [ "$CRED_FOUND" = "1" ]; then
  :
elif [ "${CRED_PROFILE_COUNT:-0}" -gt 0 ]; then
  info "shell 配置文件中出现凭证变量名 ${CRED_PROFILE_COUNT} 处，但当前会话未加载（值未读取）"
else
  bad "阿里百炼凭证在本机不可用：环境变量与 shell 配置均未发现（T1+ 前置条件缺失）"
fi
echo

echo "## 5. DashScope 端点连通性（无凭证探测，预期 401）"
HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 8 https://dashscope.aliyuncs.com/compatible-mode/v1/models 2>/dev/null || echo "ERR")"
if [ "$HTTP_CODE" = "401" ]; then
  ok "dashscope.aliyuncs.com 直连可达，未认证请求被正确拒绝（HTTP 401）"
else
  bad "DashScope 端点探测异常：HTTP ${HTTP_CODE}"
fi
echo

echo "## 6. 网络代理（GitHub 访问前置条件）"
if nc -z -w 2 127.0.0.1 7890 2>/dev/null; then
  ok "Clash 代理 127.0.0.1:7890 可用（checkout-references.sh 依赖）"
else
  bad "代理端口 7890 不可达，参考仓库克隆可能失败"
fi
echo

echo "## 7. Multica 小队"
if command -v multica >/dev/null 2>&1; then
  if multica squad list --output json 2>/dev/null | grep -q "$SQUAD_ID"; then
    ok "multica squad list 可用，开发小队（${SQUAD_ID}）在列"
  else
    bad "multica squad list 执行成功但未找到开发小队 $SQUAD_ID"
  fi
else
  bad "multica CLI 不在 PATH 中"
fi
echo

echo "## 汇总：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || echo "（存在 FAIL 项，详见上方标注；失败项不代表 T0 文档工作受阻，但按事实记录）"
exit 0
