#!/bin/bash
# Installed as ~/.local/bin/online-board; no second server, rebuild, or port killing.
set -eu
umask 077
url='http://127.0.0.1:3001/'
fail() {
  printf '%s\n' "$1" >&2
  if command -v notify-send >/dev/null; then
    notify-send --urgency=critical 'Поле — доска не запустилась' "$1" || true
  fi
  exit 1
}
if [ "${1:-}" != '' ] && [ "${1:-}" != '--check' ]; then
  fail 'Допустим только параметр --check (проверка без открытия браузера).'
fi
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/online-board-launch-$(id -u).lock"
flock -w 20 9 || fail 'Предыдущий запуск ещё не завершён.'
systemctl --user start pole.service || fail 'Не удалось запустить pole.service. Подробности: journalctl --user -u pole -n 30'
healthy=false
for attempt in {1..40}; do
  if curl --noproxy '*' --connect-timeout 1 --max-time 1 --silent --fail "${url}api/health" |
    python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r.get("ok") is True and r.get("schema")==1 else 1)' 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 0.25
done
[ "$healthy" = true ] || fail 'Сервер не ответил. Подробности: journalctl --user -u pole -n 30'
flock -u 9
if [ "${1:-}" = '--check' ]; then
  printf 'Поле работает: %s\n' "$url"
else
  xdg-open "$url" || fail "Откройте $url в браузере."
fi
