#!/usr/bin/env python3
"""Install the launcher and an on-demand user service on GNOME Flashback."""
import ast
import datetime
import os
from pathlib import Path
import shutil
import subprocess

os.umask(0o077)
project = Path(__file__).resolve().parent.parent
user_dir = Path.home()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'


def put(path, value, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(value)
    temp.chmod(mode)
    temp.replace(path)


if not (project / 'dist-server/server/index.js').is_file():
    raise SystemExit('Сначала выполните npm run build.')
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js не найден.')
for command in ['gsettings', 'dconf', 'systemctl', 'curl', 'flock', 'xdg-open', 'desktop-file-validate', 'systemd-analyze']:
    if not shutil.which(command):
        raise SystemExit(f'Не найдена команда: {command}')

schema = 'org.gnome.gnome-panel.layout'
objects = ast.literal_eval(run('gsettings', 'get', schema, 'object-id-list'))
if 'top-panel' not in ast.literal_eval(run('gsettings', 'get', schema, 'toplevel-id-list')):
    raise SystemExit('В GNOME Panel не найдена верхняя панель top-panel.')
backup = user_dir / '.local/state/online-board' / (datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '-panel.dconf')
put(backup, run('dconf', 'dump', '/org/gnome/gnome-panel/') + '\n', 0o600)

launcher = user_dir / '.local/bin/online-board'
icon = user_dir / '.local/share/icons/hicolor/scalable/apps/pole.svg'
desktop = user_dir / '.local/share/applications/online-board.desktop'
service = user_dir / '.config/systemd/user/pole.service'
put(launcher, (project / 'scripts/launch-board.sh').read_text(), 0o755)
put(icon, (project / 'deploy/pole.svg').read_text())
put(desktop, f'''[Desktop Entry]
Type=Application
Name=Поле — доска для математики
Comment=Запустить свою доску и открыть её в браузере
Exec={quote(launcher)}
Icon={icon}
Terminal=false
StartupNotify=false
Categories=Education;Math;
Keywords=доска;математика;поле;whiteboard;
''', 0o755)
run('desktop-file-validate', str(desktop))
unit = (project / 'deploy/pole.service').read_text()
unit_directory = str(project).replace('%', '%%')
unit = unit.replace('WorkingDirectory=%h/Courses/online-board', f'WorkingDirectory={unit_directory}')
unit = unit.replace('ExecStart=/usr/bin/node dist-server/server/index.js', f'ExecStart={quote(node)} {quote(project / "dist-server/server/index.js")}')
put(service, unit)
run('systemd-analyze', '--user', 'verify', str(service))
# Retire the transient service used for the first preview; preserve its database.
if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'online-board.service']).returncode == 0:
    run('systemctl', '--user', 'stop', 'online-board.service')
run('systemctl', '--user', 'daemon-reload')
print(run(str(launcher), '--check'))

object_id = 'launcher-online-board'
base = '/org/gnome/gnome-panel/layout/objects/'
if object_id not in objects:
    indices = []
    for obj in objects:
        path = base + obj + '/'
        if run('dconf', 'read', path + 'toplevel-id') == "'top-panel'" and run('dconf', 'read', path + 'pack-type') in ["'start'", '']:
            value = run('dconf', 'read', path + 'pack-index')
            if value:
                indices.append(int(value))
    path = base + object_id + '/'
    for key, value in {
        'applet-id': "'launcher'", 'module-id': "'org.gnome.gnome-panel.launcher'",
        'toplevel-id': "'top-panel'", 'pack-type': "'start'",
        'pack-index': str(max(indices, default=-1) + 1),
        'instance-config/location': repr(str(desktop)),
    }.items():
        run('dconf', 'write', path + key, value)
    # Append only our object, preserving all existing applets and their order.
    objects.append(object_id)
    run('gsettings', 'set', schema, 'object-id-list', repr(objects))
if shutil.which('update-desktop-database'):
    run('update-desktop-database', str(desktop.parent))
print(f'Ярлык установлен: {desktop}\nРезервная копия панели: {backup}')
