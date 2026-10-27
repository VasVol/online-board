import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('pole_deploy.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = 'a' * 40
OLD = 'b' * 40
CONFIG = {'branch': 'main', 'repository': 'VasVol/online-board', 'repository_id': 42,
          'workflow_id': 123, 'origin': 'https://board.vasilyvolovich.com'}
RUN = {'id': 7, 'run_attempt': 1, 'head_sha': SHA, 'head_branch': 'main', 'event': 'push',
       'path': '.github/workflows/ci.yml', 'workflow_id': 123, 'head_repository': {'id': 42},
       'status': 'completed', 'conclusion': 'success', 'html_url': 'https://github.com/example'}
JOB = {'name': 'test', 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
       'steps': [{'name': 'Run full check', 'status': 'completed', 'conclusion': 'success'}]}


class PolicyTest(unittest.TestCase):
    def test_only_exact_successful_main_push(self):
        self.assertEqual(m.tested_run([RUN], SHA, CONFIG), RUN)
        for key, value in [('event', 'pull_request'), ('head_sha', OLD), ('head_branch', 'feature'),
                           ('path', 'fake.yml'), ('workflow_id', 999), ('status', 'in_progress'),
                           ('conclusion', 'failure'), ('conclusion', 'cancelled'),
                           ('head_repository', {'id': 666})]:
            with self.subTest(key=key, value=value):
                self.assertIsNone(m.tested_run([{**RUN, key: value}], SHA, CONFIG))
        self.assertIsNone(m.tested_run([], SHA, CONFIG))
        self.assertIsNone(m.tested_run([RUN, {**RUN, 'id': 8, 'conclusion': 'failure'}], SHA, CONFIG))

    def test_skipped_or_missing_test_is_not_a_success(self):
        self.assertTrue(m.tested_job([JOB], SHA))
        self.assertFalse(m.tested_job([], SHA))
        for where, key, value in [('job', 'head_sha', OLD), ('job', 'conclusion', 'failure'),
                                 ('step', 'conclusion', 'skipped'), ('step', 'name', 'echo success')]:
            job = copy.deepcopy(JOB)
            (job if where == 'job' else job['steps'][0])[key] = value
            self.assertFalse(m.tested_job([job], SHA))

    def test_ci_failure_never_builds_or_switches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'old').mkdir()
            (root / 'current').symlink_to(root / 'old')
            with patch.object(m, 'ROOT', root), patch.object(m, 'STATE', root), \
                    patch.object(m, 'api', side_effect=[{'sha': SHA}, {'workflow_runs': [{**RUN, 'conclusion': 'failure'}]}]), \
                    patch.object(m.Deployer, 'prepare') as prepare, patch.object(m.Deployer, 'switch') as switch:
                d = m.Deployer(CONFIG); d.poll()
                prepare.assert_not_called(); switch.assert_not_called()
                self.assertEqual(d.state['phase'], 'waiting_for_ci')


class ActivationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old = self.root / 'releases' / OLD
        self.new = self.root / 'releases' / SHA
        for directory, sha in [(self.old, OLD), (self.new, SHA)]:
            directory.mkdir(parents=True)
            (directory / 'release.json').write_text(json.dumps({'sha': sha}))
        (self.root / 'current').symlink_to(self.old)
        self.patches = [patch.object(m, 'ROOT', self.root), patch.object(m, 'STATE', self.root),
                        patch.object(m, 'fingerprint', return_value=(1, 'same-schema')),
                        patch.object(m, 'command'), patch.object(m, 'health')]
        for p in self.patches: p.start()
        self.d = m.Deployer(CONFIG)
        self.d.acquire = lambda: True
        self.d.release = lambda: None
        self.d.backup = lambda sha: 'verified-backup.sqlite'
        self.d.smoke = lambda *args: None

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def test_active_lesson_does_not_backup_or_switch(self):
        self.d.acquire = lambda: False
        self.d.backup = lambda sha: self.fail('Backup should not start while busy')
        self.assertFalse(self.d.activate(self.new, SHA))
        self.assertEqual(self.d.current(), self.old)

    def test_failure_restores_previous_code_without_restoring_data(self):
        self.d.smoke = lambda *args: (_ for _ in ()).throw(RuntimeError('Synthetic smoke failure'))
        with self.assertRaises(RuntimeError): self.d.activate(self.new, SHA)
        self.assertEqual(self.d.current(), self.old)
        self.assertEqual(self.d.state['failed'], SHA)
        self.assertFalse((self.root / 'pending.json').exists())

    def test_interrupted_switch_is_recovered_next_run(self):
        self.d.switch(self.new)
        m.atomic_json(self.root / 'pending.json', {'previous': str(self.old), 'candidate': str(self.new),
                                                'sha': SHA, 'schema': [1, 'same-schema']})
        self.d.recover()
        self.assertEqual(self.d.current(), self.old)

    def test_schema_change_refuses_unsafe_rollback(self):
        m.atomic_json(self.root / 'pending.json', {'previous': str(self.old), 'sha': SHA, 'schema': [2, 'changed']})
        self.d.switch(self.new)
        with self.assertRaises(RuntimeError): self.d.recover()
        self.assertEqual(self.d.current(), self.new)
        self.assertTrue((self.root / 'paused').exists())

    def test_success_keeps_previous_release_and_verified_backup(self):
        self.assertTrue(self.d.activate(self.new, SHA))
        self.assertEqual(self.d.current(), self.new)
        self.assertEqual(self.d.state['previous'], str(self.old))
        self.assertEqual(self.d.state['backup'], 'verified-backup.sqlite')
        self.assertFalse((self.root / 'pending.json').exists())


class DatabaseTest(unittest.TestCase):
    def test_backup_closed_and_live_wal_database_preserves_latest_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'board.sqlite'
            writer = sqlite3.connect(source)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE example(value)')
            writer.execute('INSERT INTO example VALUES (1)')
            writer.commit(); writer.close()
            self.assertFalse(Path(str(source) + '-wal').exists())
            owner = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            with patch.object(m, 'DATA', source), patch.object(m, 'BACKUPS', root), \
                    patch.object(m, 'STATE', root), patch.object(m.pwd, 'getpwnam', return_value=owner):
                d = m.Deployer(CONFIG)
                schema = m.fingerprint(source)
                closed_backup = Path(d.backup(SHA))
                writer = sqlite3.connect(source)
                try:
                    writer.execute('INSERT INTO example VALUES (2)'); writer.commit()
                    live_backup = Path(d.backup(SHA))
                    self.assertEqual(m.fingerprint(source), schema)
                finally:
                    writer.close()
                for backup, expected in [(closed_backup, [(1,)]), (live_backup, [(1,), (2,)])]:
                    db = sqlite3.connect(backup)
                    try:
                        self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(), ('ok',))
                        self.assertEqual(db.execute('SELECT value FROM example ORDER BY value').fetchall(), expected)
                        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
                    finally:
                        db.close()


class PublishTest(unittest.TestCase):
    def test_separate_mounts_publish_complete_tree_and_preserve_module_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root / 'cache' / SHA
            stage.mkdir(parents=True)
            (stage / 'file').write_text('verified build')
            (stage / 'link').symlink_to('file')
            release = root / 'releases' / SHA
            release.parent.mkdir()
            replace = Path.replace
            def same_mount_only(source, target):
                self.assertEqual(source.parent, target.parent, 'cross-mount rename is forbidden')
                return replace(source, target)
            with patch.object(Path, 'replace', same_mount_only):
                m.publish_release(stage, release)
            self.assertEqual((release / 'file').read_text(), 'verified build')
            self.assertTrue((release / 'link').is_symlink())
            self.assertEqual((release / 'link').read_text(), 'verified build')

    def test_failed_copy_never_exposes_partial_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root / 'source'; stage.mkdir()
            release = root / SHA
            def failed_copy(source, destination, **kwargs):
                destination.mkdir()
                (destination / 'partial').write_text('incomplete')
                raise OSError('disk full')
            with patch.object(m.shutil, 'copytree', failed_copy), self.assertRaises(OSError):
                m.publish_release(stage, release)
            self.assertFalse(release.exists())
            self.assertFalse((root / ('.incoming-' + SHA)).exists())


class HealthSchemaTest(unittest.TestCase):
    def test_health_accepts_supported_schemas_but_not_unknown_or_wrong_revision(self):
        import io
        for schema, revision, ok, accepted in [(1, SHA, True, True), (2, SHA, True, True),
                                               (3, SHA, True, False), (2, OLD, True, False),
                                               (2, SHA, False, False)]:
            with self.subTest(schema=schema, revision=revision, ok=ok):
                payload = json.dumps({'ok': ok, 'revision': revision, 'schema': schema}).encode()
                with patch.object(m.urllib.request, 'urlopen', return_value=io.BytesIO(payload)):
                    if accepted:
                        m.health('http://test.invalid', SHA, wait=0)
                    else:
                        with self.assertRaises(RuntimeError):
                            m.health('http://test.invalid', SHA, wait=0)


if __name__ == '__main__':
    unittest.main()
