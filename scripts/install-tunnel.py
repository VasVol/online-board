#!/usr/bin/env python3
"""Install on-demand tunnel controls; default provider needs only OpenSSH."""
import os
from pathlib import Path
import shutil
import subprocess

os.umask(0o077)
project = Path(__file__).resolve().parent.parent
home_dir = Path.home()
if not shutil.which('ssh'):
    raise SystemExit('Требуется OpenSSH client.')
(home_dir / '.ssh').mkdir(mode=0o700, exist_ok=True)
key = home_dir / '.ssh/id_ed25519_pole_tunnel'
if not key.exists():
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '',
                    '-C', 'pole-temporary-tunnel', '-f', str(key)], check=True)

def install(source, destination, mode):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(project / source, destination)
    destination.chmod(mode)

install('scripts/run-tunnel.py', home_dir / '.local/share/online-board/run-tunnel.py', 0o700)
install('scripts/share-board.sh', home_dir / '.local/bin/online-board-public', 0o700)
unit = home_dir / '.config/systemd/user/pole-tunnel.service'
install('deploy/pole-tunnel.service', unit, 0o600)
dropin = home_dir / '.config/systemd/user/pole.service.d/https-tunnel.conf'
dropin.parent.mkdir(parents=True, exist_ok=True)
dropin.write_text('[Service]\nEnvironment=TRUST_LOCAL_PROXY=1\n')
subprocess.run(['systemd-analyze', '--user', 'verify', str(unit)], check=True)
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
print('Установлено. После сборки перезапустите pole, затем online-board-public start.')
