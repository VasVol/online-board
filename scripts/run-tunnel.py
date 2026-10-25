#!/usr/bin/env python3
"""Run a temporary HTTPS tunnel; keep its current URL outside the repository."""
import os
from pathlib import Path
import re
import subprocess
import sys

os.umask(0o077)
state = Path.home() / '.local/state/online-board'
state.mkdir(parents=True, exist_ok=True, mode=0o700)
url_file = state / 'public-url'
url_file.unlink(missing_ok=True)
command = ['ssh', '-T', '-p', '443', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
           '-o', 'IdentityAgent=none', '-i', str(Path.home() / '.ssh/id_ed25519_pole_tunnel'),
           '-o', 'StrictHostKeyChecking=accept-new',
           '-o', f'UserKnownHostsFile={Path.home()}/.ssh/known_hosts_pole_tunnel',
           '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15',
           '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
           '-R', '0:127.0.0.1:3001', 'free.pinggy.io']
address_pattern = r'https://[a-z0-9-]+\.run\.pinggy-free\.link'
try:
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, bufsize=1) as process:
        for line in process.stdout:
            line = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', line)
            match = re.search(address_pattern, line)
            if match:
                temporary = url_file.with_suffix('.tmp')
                temporary.write_text(match.group(0) + '\n')
                temporary.replace(url_file)
            # Tunnel error messages may include a WebSocket request URL.
            line = re.sub(r'(?i)([?&](?:key|token)=)[^&\s"\\]+', r'\1<redacted>', line)
            print(line, end='', flush=True)
        sys.exit(process.wait())
finally:
    url_file.unlink(missing_ok=True)
