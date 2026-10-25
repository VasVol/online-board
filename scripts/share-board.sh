#!/bin/bash
# Manage the temporary public link without starting a second board backend.
set -euo pipefail
umask 077
state="$HOME/.local/state/online-board/public-url"
action="${1:-start}"
case "$action" in
  stop)
    systemctl --user stop pole-tunnel.service
    echo 'Внешний доступ выключен. Локальная доска продолжает работать.'
    exit 0
    ;;
  start|open)
    systemctl --user start pole.service pole-tunnel.service
    ;;
  status) ;;
  *) echo 'Использование: online-board-public [start|open|status|stop]' >&2; exit 2 ;;
esac
for ((i=0; i<40; i++)); do
  if ! systemctl --user is-active --quiet pole-tunnel.service; then
    echo 'Туннель не запущен. Для запуска: online-board-public start' >&2
    exit 1
  fi
  url=''
  if [[ -f "$state" ]]; then read -r url < "$state" || true; fi
  if [[ "$url" =~ ^https://[a-z0-9-]+\.run\.pinggy-free\.link$ ]] &&
     curl --noproxy '*' -fsS --connect-timeout 3 --max-time 5 "$url/api/health" >/dev/null 2>&1; then
    echo "$url"
    if [[ "$action" == open ]]; then xdg-open "$url" >/dev/null 2>&1; fi
    exit 0
  fi
  [[ "$action" == status ]] && break
  sleep 1
done
echo 'Публичный адрес пока не отвечает. Диагностика: journalctl --user -u pole-tunnel -n 30' >&2
exit 1
