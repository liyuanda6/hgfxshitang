#!/usr/bin/env bash
#
# 在服务器上启动/重启 班级就餐统计系统
# 优先使用 pm2（推荐，自带开机自启与日志）；无 pm2 时退回 nohup。
#
# 用法：
#   bash /opt/class-meal-system/deploy/start.sh
#
# 环境变量（可选）：
#   HOST   监听地址  默认 0.0.0.0（裸跑可公网访问）
#                   若前置 Nginx 反代，建议设 127.0.0.1
#   PORT   监听端口  默认 3000
#
set -e

# 项目根 = deploy/ 的上一级
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"

export HOST PORT NODE_ENV=production

echo "==> 工作目录: $ROOT"
echo "==> 监听: $HOST:$PORT"

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe meal >/dev/null 2>&1; then
    pm2 restart meal
  else
    pm2 start server.js --name meal --update-env
  fi
  pm2 save
  echo "==> 已通过 pm2 启动/重启（名称: meal）。日志: pm2 logs meal"
else
  echo "==> 未检测到 pm2，使用 nohup 方式启动"
  pkill -f "node $ROOT/server.js" 2>/dev/null || true
  sleep 1
  LOG="/var/log/meal.log"
  nohup node server.js > "$LOG" 2>&1 &
  echo "==> 已启动，PID $!，日志: $LOG"
  echo "==> 停止命令: pkill -f 'node $ROOT/server.js'"
fi

# 简单探活
sleep 2
if curl -fsS "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
  echo "==> 健康检查通过 ✅"
else
  echo "==> 警告：健康检查未通过，请查看日志排查"
fi
