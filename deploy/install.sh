#!/usr/bin/env bash
# ============================================================
# AleaBot NG 一键安装脚本（用于服务器 / Linux 服务器）
# 用法：
#   1. 先把整个项目目录（含 node_modules 与 dist）拷到目标机
#   2. sudo bash install.sh
# ============================================================
set -e

APP_DIR="<安装目录>"
SERVICE_NAME="aleabot"
RUN_USER="${SUDO_USER:-aleabot}"

echo "==> 安装 AleaBot NG 到 ${APP_DIR}（运行用户: ${RUN_USER}）"

# 1. 目录准备
sudo mkdir -p "${APP_DIR}"
sudo mkdir -p "${APP_DIR}/logs"
sudo mkdir -p "${APP_DIR}/data/backups"

# 2. 拷贝当前目录内容（排除 data/logs，避免覆盖既有数据）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "${SCRIPT_DIR}")"

echo "==> 拷贝文件: ${SRC_DIR} -> ${APP_DIR}"
sudo rsync -a --exclude 'data' --exclude 'logs' --exclude '.git' \
  "${SRC_DIR}/" "${APP_DIR}/" 2>/dev/null || {
    # 无 rsync 时退回 cp
    sudo cp -r "${SRC_DIR}/dist" "${APP_DIR}/" 2>/dev/null || true
    sudo cp -r "${SRC_DIR}/public" "${APP_DIR}/" 2>/dev/null || true
    sudo cp -r "${SRC_DIR}/node_modules" "${APP_DIR}/" 2>/dev/null || true
    sudo cp "${SRC_DIR}/package.json" "${APP_DIR}/" 2>/dev/null || true
    sudo cp "${SRC_DIR}/.env.example" "${APP_DIR}/" 2>/dev/null || true
  }

# 3. 权限
sudo chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"

# 4. 若没有 .env 则由示例创建
if [ ! -f "${APP_DIR}/.env" ]; then
  sudo -u "${RUN_USER}" cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo "==> 已创建 ${APP_DIR}/.env，请编辑填写平台配置！"
fi

# 5. 安装 systemd 服务
sudo cp "${SCRIPT_DIR}/systemd/aleabot.service" "/etc/systemd/system/${SERVICE_NAME}.service"
# 替换服务里的用户名（若不同）
sudo sed -i "s/^User=.*/User=${RUN_USER}/" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo sed -i "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo sed -i "s#^ExecStart=.*#ExecStart=$(command -v node) ${APP_DIR}/dist/index.js#" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo sed -i "s#^EnvironmentFile=.*#EnvironmentFile=-${APP_DIR}/.env#" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo sed -i "s#<安装目录>/logs#${APP_DIR}/logs#g" "/etc/systemd/system/${SERVICE_NAME}.service"

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"

echo ""
echo "============================================"
echo " 安装完成！"
echo " 1) 编辑配置: vim ${APP_DIR}/.env"
echo " 2) 启动服务: sudo systemctl start ${SERVICE_NAME}"
echo " 3) 查看状态: systemctl status ${SERVICE_NAME}"
echo " 4) 查看日志: tail -f ${APP_DIR}/logs/bot.log"
echo " 5) 管理后台: http://<本地IP>:8787/"
echo "============================================"
