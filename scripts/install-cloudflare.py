#!/usr/bin/env python3
"""Install controls for an already configured Cloudflare published application.

Does not create DNS records, obtain credentials, or start/enable services.
The tunnel token must be saved privately before running this script.
"""
import os
from pathlib import Path
import shutil
import subprocess

os.umask(0o077)
project = Path(__file__).resolve().parent.parent
home_dir = Path.home()
config = home_dir / '.config/online-board'
binary = home_dir / '.local/bin/cloudflared'
token = config / 'cloudflare-token'
if not binary.is_file() or not os.access(binary, os.X_OK):
    raise SystemExit('Сначала установите официальный cloudflared в ~/.local/bin/.')
if not token.is_file() or not token.read_text().strip():
    raise SystemExit('Сначала сохраните токен нужного туннеля в ~/.config/online-board/cloudflare-token.')
token.chmod(0o600)

def install(source, destination, mode):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(project / source, destination)
    destination.chmod(mode)

unit = home_dir / '.config/systemd/user/pole-cloudflare.service'
install('deploy/pole-cloudflare.service', unit, 0o600)
install('scripts/share-board.sh', home_dir / '.local/bin/online-board-public', 0o700)
dropin = home_dir / '.config/systemd/user/pole.service.d/https-tunnel.conf'
dropin.parent.mkdir(parents=True, exist_ok=True)
dropin.write_text('[Service]\nEnvironment=TRUST_LOCAL_PROXY=1\n')
subprocess.run(['systemd-analyze', '--user', 'verify', str(unit)], check=True)
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
(config / 'cloudflare-public-url').write_text('https://board.vasilyvolovich.com\n')
(config / 'public-provider').write_text('cloudflare\n')
print('Установлено. Запуск: online-board-public start; автозапуск при входе: systemctl --user enable pole-cloudflare.')
