#!/usr/bin/env python3
"""Root-owned pull deployer. Never executes repository code as root.

Only tested push runs of a pinned workflow/repository can reach production.
Infrastructure updates are installed separately after review, never by this poller.
"""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.request

SHA = re.compile(r"[a-f0-9]{40}")
API = "https://api.github.com"
ROOT = Path("/opt/pole")
STATE = Path("/var/lib/pole-deploy")
CACHE = Path("/var/cache/pole-build")
DATA = Path("/var/lib/pole/board.sqlite")
BACKUPS = Path("/var/backups/pole")
CONTROL = "/run/pole/control.sock"


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def api(path):
    request = urllib.request.Request(API + path, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "pole-deployer",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def tested_run(runs, sha, config):
    """Require the latest attempt; a previous green run must not hide a new failure."""
    matching = [r for r in runs if r.get("head_sha") == sha]
    if not matching:
        return None
    run = max(matching, key=lambda r: (r["id"], r.get("run_attempt", 1)))
    expected = {
        "head_sha": sha, "head_branch": config["branch"], "event": "push",
        "path": ".github/workflows/ci.yml", "workflow_id": config["workflow_id"],
        "status": "completed", "conclusion": "success",
    }
    if any(run.get(k) != v for k, v in expected.items()):
        return None
    if run.get("head_repository", {}).get("id") != config["repository_id"]:
        return None
    return run


def tested_job(jobs, sha):
    return any(j.get("name") == "test" and j.get("head_sha") == sha
               and j.get("status") == "completed" and j.get("conclusion") == "success"
               and any(s.get("name") == "Run full check" and s.get("status") == "completed"
                       and s.get("conclusion") == "success" for s in j.get("steps", []))
               for j in jobs)


def command(args, **kwargs):
    print("Running:", " ".join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), check=True, timeout=900, **kwargs)


def builder(args, cwd):
    return command(["runuser", "-u", "pole-build", "--", "env", "CI=1",
                    "HOME=/var/cache/pole-build", "npm_config_cache=/var/cache/pole-build/npm",
                    *args], cwd=cwd)


def fingerprint(path):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        version = db.execute("PRAGMA user_version").fetchone()[0]
        rows = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master "
                          "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    return version, hashlib.sha256(json.dumps(rows).encode()).hexdigest()


def control(method, path):
    class UnixHTTP(http.client.HTTPConnection):
        def connect(self):
            import socket
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(10)
            self.sock.connect(CONTROL)
    with contextlib.closing(UnixHTTP("localhost")) as connection:
        connection.request(method, path)
        response = connection.getresponse()
        return response.status, json.loads(response.read())


def health(base, sha, wait=30):
    until = time.monotonic() + wait
    while True:
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=10) as response:
                data = json.load(response)
            if data.get("ok") is True and (sha is None or data.get("revision") == sha) and data.get("schema") == 1:
                return
        except (OSError, ValueError):
            pass
        if time.monotonic() >= until:
            raise RuntimeError("Health check failed for expected revision")
        time.sleep(1)


class Deployer:
    def __init__(self, config):
        self.config = config
        self.state = read_json(STATE / "status.json", {})
        self.legacy_stopped = False

    def status(self, phase, **details):
        self.state.update(phase=phase, checked_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **details)
        atomic_json(STATE / "status.json", self.state)
        print(json.dumps({"phase": phase, **details}), flush=True)

    def current(self):
        return (ROOT / "current").resolve(strict=True)

    def revision(self, release):
        return read_json(release / "release.json", {}).get("sha")

    def switch(self, release):
        temporary = ROOT / "current.next"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(release)
        temporary.replace(ROOT / "current")
        command(["systemctl", "restart", "pole.service"])

    def backup(self, sha):
        target = BACKUPS / f"pre-deploy-{time.time_ns()}-{sha[:12]}.sqlite"
        # Exclusive target creation; online SQLite backup handles the live WAL safely.
        with target.open("xb"):
            pass
        os.chmod(target, 0o600)
        try:
            with sqlite3.connect(f"file:{DATA}?mode=ro", uri=True) as source, sqlite3.connect(target) as dest:
                source.backup(dest)
                if dest.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise RuntimeError("Backup integrity check failed")
            owner = pwd.getpwnam("pole")
            os.chown(target, owner.pw_uid, owner.pw_gid)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return str(target)

    def smoke(self, release, base, sha):
        builder(["node", "scripts/deploy-smoke.mjs", base, sha], release)

    def prepare(self, sha):
        release = ROOT / "releases" / sha
        if release.exists():
            if read_json(release / "release.json", {}).get("sha") != sha:
                raise RuntimeError("Unexpected existing release directory")
            return release
        if shutil.disk_usage(ROOT).free < 2 * 1024**3:
            raise RuntimeError("Less than 2 GiB free: clean old releases/backups before deploying")
        stage = CACHE / ("build-" + sha)
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir()
        try:
            with tempfile.TemporaryFile() as archive:
                url = f"https://codeload.github.com/{self.config['repository']}/tar.gz/{sha}"
                with urllib.request.urlopen(url, timeout=60) as response:
                    shutil.copyfileobj(response, archive)
                archive.seek(0)
                with tarfile.open(fileobj=archive, mode="r:gz") as tar:
                    for entry in tar.getmembers():
                        # Source does not need symlinks, devices, or executable metadata.
                        if not (entry.isfile() or entry.isdir()):
                            raise RuntimeError("Unsupported source archive entry")
                        parts = Path(entry.name).parts
                        if not parts or parts[0] != "online-board-" + sha:
                            raise RuntimeError("Unexpected archive root")
                        entry.name = str(Path(*parts[1:])) if len(parts) > 1 else "."
                        tar.extract(entry, stage, filter="data")
            builder_user = pwd.getpwnam("pole-build")
            for directory, dirs, files in os.walk(stage):
                for path in [Path(directory), *(Path(directory) / name for name in dirs + files)]:
                    os.chown(path, builder_user.pw_uid, builder_user.pw_gid)
            atomic_json(stage / "release.json", {"sha": sha})
            builder(["npm", "ci", "--no-audit", "--no-fund"], stage)
            builder(["npm", "run", "build"], stage)
            # Native SQLite is installed/built for THIS server, not copied from CI's OS.
            preview = stage / ".preview-data"
            process = subprocess.Popen([
                "runuser", "-u", "pole-build", "--", "env", "NODE_ENV=production",
                "HOST=127.0.0.1", "PORT=4312", f"DATA_DIR={preview}",
                "DEPLOY_CONTROL_SOCKET=", "PUBLIC_ORIGIN=http://127.0.0.1:4312",
                "node", "dist-server/server/index.js",
            ], cwd=stage, start_new_session=True)
            try:
                health("http://127.0.0.1:4312", sha)
                self.smoke(stage, "http://127.0.0.1:4312", sha)
                if fingerprint(preview / "board.sqlite") != fingerprint(DATA):
                    raise RuntimeError("Database schema change requires a separate migration plan")
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            shutil.rmtree(preview)
            # Only root may change a ready release. The builder cannot edit active code.
            command(["chown", "-R", "--no-dereference", "root:root", stage])
            command(["chmod", "-R", "a+rX,go-w", stage])
            stage.replace(release)
            return release
        finally:
            if stage.exists():
                shutil.rmtree(stage)

    def acquire(self):
        if not Path(CONTROL).exists() and self.config.get("bootstrap_legacy") and not self.revision(self.current()):
            # One-time installation only: the old release predates the control socket.
            # Refuse any established backend connection for a full minute, then stop
            # BEFORE backup/switch. Remove bootstrap_legacy after the first deployment.
            for _ in range(21):
                connections = subprocess.check_output([
                    "ss", "-Htn", "state", "established", "( sport = :3001 )"], text=True)
                if connections.strip():
                    return False
                time.sleep(3)
            command(["systemctl", "stop", "pole.service"])
            self.legacy_stopped = True
            return True
        code, _ = control("POST", "/acquire")
        return code == 200

    def release(self):
        if self.legacy_stopped:
            command(["systemctl", "start", "pole.service"])
            self.legacy_stopped = False
        try:
            control("POST", "/release")
        except OSError:
            pass

    def activate(self, candidate, sha):
        if not self.acquire():
            self.status("waiting_for_idle", desired=sha)
            return False
        previous = self.current()
        try:
            schema = fingerprint(DATA)
            backup = self.backup(sha)
            transaction = {"previous": str(previous), "candidate": str(candidate), "sha": sha,
                           "schema": list(schema), "backup": backup}
            atomic_json(STATE / "pending.json", transaction)
            self.status("activating", desired=sha, backup=backup)
            try:
                self.switch(candidate)
                health("http://127.0.0.1:3001", sha)
                self.smoke(candidate, self.config["origin"], sha)
            except BaseException:
                self.recover()
                raise
            self.status("deployed", active=sha, desired=sha, previous=str(previous), failed=None,
                        run_id=self.state.get("run_id"), error=None)
            (STATE / "pending.json").unlink()
            self.prune()
            return True
        finally:
            self.release()

    def recover(self):
        pending = read_json(STATE / "pending.json")
        if not pending:
            return
        # Never roll a database back: later user writes must survive a code rollback.
        if list(fingerprint(DATA)) != pending["schema"]:
            (STATE / "paused").touch()
            self.status("manual_intervention", failed=pending["sha"],
                        error="Schema changed; automatic code rollback refused")
            raise RuntimeError("Schema changed; inspect backup and migration before recovery")
        previous = Path(pending["previous"])
        if previous.parent != ROOT / "releases" or not previous.is_dir():
            raise RuntimeError("Invalid rollback target")
        self.switch(previous)
        old_sha = self.revision(previous)
        # Only the initial worktree snapshot predates revision-aware health.
        health("http://127.0.0.1:3001", old_sha)
        self.status("rolled_back", active=old_sha, failed=pending["sha"], previous=None)
        (STATE / "pending.json").unlink()

    def prune(self):
        protected = {self.current(), Path(self.state["previous"])}
        releases = sorted((p for p in (ROOT / "releases").iterdir() if SHA.fullmatch(p.name)),
                          key=lambda p: p.stat().st_mtime, reverse=True)
        for old in releases[3:]:
            if old not in protected:
                shutil.rmtree(old)

    def poll(self):
        self.recover()
        if (STATE / "paused").exists():
            self.status("paused")
            return
        repo = self.config["repository"]
        head = api(f"/repos/{repo}/commits/{self.config['branch']}")["sha"]
        if not SHA.fullmatch(head):
            raise RuntimeError("Invalid commit SHA")
        if self.revision(self.current()) == head:
            self.status("up_to_date", active=head, error=None)
            return
        if self.state.get("failed") == head:
            self.status("blocked_failed_release", desired=head)
            return
        runs = api(f"/repos/{repo}/actions/workflows/{self.config['workflow_id']}/runs"
                   f"?branch={self.config['branch']}&event=push&head_sha={head}&per_page=5")
        run = tested_run(runs["workflow_runs"], head, self.config)
        if not run:
            self.status("waiting_for_ci", desired=head)
            return
        jobs = api(f"/repos/{repo}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100")
        if not tested_job(jobs["jobs"], head):
            self.status("waiting_for_required_test", desired=head)
            return
        self.status("preparing", desired=head, run_id=run["id"],
                    run_url=run["html_url"], error=None)
        try:
            candidate = self.prepare(head)
        except (RuntimeError, subprocess.SubprocessError):
            self.status("preparation_failed", failed=head)
            raise
        # Building may take minutes. Do not deploy an obsolete main head.
        if api(f"/repos/{repo}/commits/{self.config['branch']}")["sha"] != head:
            self.status("superseded", desired=head)
            return
        self.activate(candidate, head)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="poll",
                        choices=["poll", "status", "pause", "resume", "retry"])
    args = parser.parse_args()
    if args.action == "status":
        print(json.dumps(read_json(STATE / "status.json", {}), indent=2))
        return
    if os.geteuid() != 0:
        parser.error("Deployment control requires root")
    STATE.mkdir(exist_ok=True, mode=0o755)
    with (STATE / "lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another deployment is running")
            return
        deployer = Deployer(read_json(Path("/etc/pole/deploy.json")))
        if args.action == "pause":
            (STATE / "paused").touch()
            deployer.status("paused")
            return
        if args.action == "resume":
            (STATE / "paused").unlink(missing_ok=True)
        if args.action == "retry":
            deployer.status("retry_requested", failed=None)
        try:
            deployer.poll()
        except Exception as error:
            # API failure, rate limit, build failure => keep current version. No unchecked fallback.
            deployer.status("error", error=str(error))
            raise SystemExit(1)


if __name__ == "__main__":
    main()
