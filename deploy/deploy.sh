#!/usr/bin/env bash
#
# 一键部署到云服务器
# 用法：
#   ./deploy.sh user@主机IP:/目标路径
# 示例：
#   ./deploy.sh root@1.2.3.4:/opt/class-meal-system
#
# 行为：
#   1) 本地把项目打包（排除 node_modules / .shots / 调试脚本等）
#   2) scp 上传到服务器
#   3) ssh 解压并重启服务（优先 pm2，否则 nohup）
#
set -euo pipefail

REMOTE="${1:-}"
if [ -z "$REMOTE" ]; then
  echo "用法: $0 user@主机IP:/目标路径"
  echo "示例: $0 root@1.2.3.4:/opt/class-meal-system"
  exit 1
fi

HOST_SSH="${REMOTE%%:*}"
DEST="${REMOTE#*:}"
if [ -z "$DEST" ] || [ "$DEST" = "$REMOTE" ]; then
  echo "错误：目标路径格式应为 user@host:/path"
  exit 1
fi

# 项目根（deploy/ 的上一级）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
ARCHIVE="/tmp/meal-deploy-$(date +%s).tar.gz"

echo "==> 项目目录: $ROOT"
echo "==> 目标服务器: $HOST_SSH:$DEST"

# 1) 打包（排除部署无关文件）
echo "==> [1/4] 打包项目..."
tar --exclude='./node_modules' \
    --exclude='./.shots' \
    --exclude='./.git' \
    --exclude='./deploy' \
    --exclude='./gen-xlsx.py' \
    --exclude='./shot-mobile.js' \
    --exclude='./test-smoke.js' \
    --exclude='*.log' \
    --exclude='./data/*.tmp' \
    -czf "$ARCHIVE" -C "$ROOT" .

# 2) 上传
echo "==> [2/4] 上传到 $HOST_SSH ..."
ssh "$HOST_SSH" "mkdir -p $DEST"
scp "$ARCHIVE" "$HOST_SSH:/tmp/meal-deploy.tar.gz"

# 3) 解压（保留原 data/ 数据：先备份再合并不覆盖）
echo "==> [3/4] 解压并保留已有数据..."
ssh "$HOST_SSH" bash -s "$DEST" <<'EOF'
set -e
DEST="$1"
TMP="/tmp/meal-deploy-extract"
rm -rf "$TMP"; mkdir -p "$TMP"
tar -xzf /tmp/meal-deploy.tar.gz -C "$TMP"

# 若目标已存在 data/data.json，先备份，避免覆盖线上数据
if [ -f "$DEST/data/data.json" ]; then
  cp "$DEST/data/data.json" "$DEST/data/data.json.pre-deploy-$(date +%s)" 2>/dev/null || true
fi

# 合并：用 tar 解压覆盖代码，但保留线上 data 目录
rsync -a --exclude='/data' "$TMP/" "$DEST/"
# 若线上没有 data，则从包里带一份（含 27 班种子）
if [ ! -f "$DEST/data/data.json" ]; then
  mkdir -p "$DEST/data"
  [ -f "$TMP/data/data.json" ] && cp "$TMP/data/data.json" "$DEST/data/data.json"
fi
rm -rf "$TMP"
echo "解压完成: $DEST"
EOF

# 4) 重启
echo "==> [4/4] 重启服务..."
ssh "$HOST_SSH" "bash $DEST/deploy/start.sh"

echo "==> 部署完成。若已配置 Nginx + 域名，请访问对应地址；否则直接用 http://服务器IP:3000"
