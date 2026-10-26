#!/bin/bash
# Run from the reviewed repository root on the VPS. Does not restart the board.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo from the repository root'; exit 1; }
id pole >/dev/null
if ! id pole-build >/dev/null 2>&1; then
  useradd --system --home-dir /var/cache/pole-build --shell /usr/sbin/nologin pole-build
fi
install -d -m 0755 /usr/local/lib/pole-deploy /var/lib/pole-deploy /opt/pole/releases
install -d -m 0755 -o pole-build -g pole-build /var/cache/pole-build
install -d -m 0700 /etc/pole
install -m 0644 deploy/automation/pole_deploy.py /usr/local/lib/pole-deploy/pole_deploy.py
if [[ ! -f /etc/pole/deploy.json ]]; then
  install -m 0600 deploy/automation/config.example.json /etc/pole/deploy.json
fi
for unit in pole.service pole-deploy.service pole-deploy.timer; do
  install -m 0644 "deploy/server/$unit" "/etc/systemd/system/$unit"
done
systemd-analyze verify /etc/systemd/system/pole.service /etc/systemd/system/pole-deploy.service /etc/systemd/system/pole-deploy.timer
systemctl daemon-reload
systemctl enable --now pole-deploy.timer
