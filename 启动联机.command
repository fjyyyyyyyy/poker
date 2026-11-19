#!/bin/sh
# River Room 一键联机启动器
# 双击后：启动游戏服务 -> 申请 Cloudflare 公网地址 -> 自动用浏览器打开
cd "$(dirname "$0")" || exit 1

# 双击启动时 PATH 可能不含 nvm / Homebrew，补一下
if ! command -v node >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      PATH="$(dirname "$candidate"):$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "没有找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/"
  echo "安装完成后重新双击本文件即可。"
  printf "按回车键关闭窗口…"
  read _
  exit 1
fi

# 如果项目目录里放了 cloudflared 可执行文件，优先使用它
if [ -x "./cloudflared" ]; then
  CLOUDFLARED="$PWD/cloudflared"
  export CLOUDFLARED
fi

node share.mjs --open
status=$?
echo ""
printf "联机服务已停止（退出码 %s）。按回车键关闭窗口…" "$status"
read _
