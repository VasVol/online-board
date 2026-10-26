#!/bin/bash
# Manage the selected public link without starting a second board backend.
set -euo pipefail
umask 077
state="$HOME/.local/state/online-board/public-url"
config="$HOME/.config/online-board"
provider=pinggy
if [[ -f "$config/public-provider" ]]; then read -r provider < "$config/public-provider"; fi
if [[ "$provider" == server ]]; then
  read -r url < "$config/server-url"
  [[ "$url" =~ ^https://[a-zA-Z0-9.-]+$ ]] || { echo 'Некорректный адрес сервера.' >&2; exit 1; }
  case "${1:-start}" in
    stop)
      echo 'Доска работает постоянно на VPS. Для остановки: ssh ovh-vps sudo systemctl stop pole' >&2
      exit 2
      ;;
    start|status|open) ;;
    *) echo 'Использование: online-board-public [start|open|status|stop]' >&2; exit 2 ;;
  esac
  curl --connect-timeout 5 --max-time 15 -fsS "$url/api/health" >/dev/null || { echo 'Серверная доска пока не отвечает.' >&2; exit 1; }
  echo "$url"
  if [[ "${1:-start}" == open ]]; then xdg-open "$url" >/dev/null 2>&1; fi
  exit 0
fi
case "$provider" in
  pinggy) service=pole-tunnel; fixed_url='' ;;
  cloudflare)
    service=pole-cloudflare
    read -r fixed_url < "$config/cloudflare-public-url"
    if [[ ! "$fixed_url" =~ ^https://[a-zA-Z0-9.-]+$ ]]; then
      echo 'Некорректный внешний адрес Cloudflare.' >&2; exit 1
    fi
    ;;
  *) echo 'Неизвестный провайдер публичного доступа.' >&2; exit 1 ;;
esac
action="${1:-start}"
case "$action" in
  stop)
    systemctl --user stop "$service.service"
    echo 'Внешний доступ выключен. Локальная доска продолжает работать.'
    exit 0
    ;;
  start|open)
    systemctl --user start pole.service "$service.service"
    ;;
  status) ;;
  *) echo 'Использование: online-board-public [start|open|status|stop]' >&2; exit 2 ;;
esac
for ((i=0; i<40; i++)); do
  if ! systemctl --user is-active --quiet "$service.service"; then
    echo 'Туннель не запущен. Для запуска: online-board-public start' >&2
    exit 1
  fi
  url="$fixed_url"
  if [[ "$provider" == pinggy && -f "$state" ]]; then read -r url < "$state" || true; fi
  if { [[ "$provider" == cloudflare ]] || [[ "$url" =~ ^https://[a-z0-9-]+\.run\.pinggy-free\.link$ ]]; } &&
     curl --noproxy '*' -fsS --connect-timeout 3 --max-time 5 "$url/api/health" >/dev/null 2>&1; then
    echo "$url"
    if [[ "$action" == open ]]; then xdg-open "$url" >/dev/null 2>&1; fi
    exit 0
  fi
  [[ "$action" == status ]] && break
  sleep 1
done
echo "Публичный адрес пока не отвечает. Диагностика: journalctl --user -u $service -n 30" >&2
exit 1
