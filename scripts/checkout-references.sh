#!/usr/bin/env bash
# 按固定 commit 检出两个 MIT 参考仓库到 reference/（只读设计参考，不进入产品仓库）。
# 用法：bash scripts/checkout-references.sh
# 依赖：git、可访问 GitHub（本机经 Clash 代理 127.0.0.1:7890）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF_DIR="$ROOT/reference"
PROXY="${GIT_PROXY:-http://127.0.0.1:7890}"

clone_pinned() {
  local url="$1" sha="$2" dest="$3"
  if [ -d "$dest/.git" ] && [ "$(git -C "$dest" rev-parse HEAD)" = "$sha" ]; then
    echo "[skip] $dest 已在目标 commit"
    return 0
  fi
  rm -rf "$dest"
  git -c http.proxy="$PROXY" clone "$url" "$dest"
  git -C "$dest" -c http.proxy="$PROXY" fetch --depth 1 origin "$sha"
  git -C "$dest" checkout --detach "$sha"
  echo "[ok] $dest @ $(git -C "$dest" rev-parse HEAD)"
}

clone_pinned https://github.com/Tameyer41/liftoff.git \
  550e4bf74eab1b329dcb64830ed6172063f34d27 \
  "$REF_DIR/liftoff"

clone_pinned https://github.com/jiatastic/GPTInterviewer.git \
  048419cf9b124e566c0423cbfbe9efa14e6fbe36 \
  "$REF_DIR/GPTInterviewer"

echo "参考仓库检出完成："
git -C "$REF_DIR/liftoff" log -1 --format="liftoff %H %ad" --date=short
git -C "$REF_DIR/GPTInterviewer" log -1 --format="GPTInterviewer %H %ad" --date=short
