"""Exercise v0.7 through the HTTP surface using an isolated workspace and mail outbox."""

import base64
import hashlib
import http.cookiejar
import io
import json
import os
import selectors
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

from PIL import Image
from card_asset_store import perform as asset_operation
from project_store import ProjectStore


EDITOR = Path(__file__).resolve().parents[1]
PASSWORD = 'test-account-password'


class Client:
    def __init__(self, origin):
        self.origin = origin
        self.opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, body=None, *, workspace=None):
        headers = {}
        if workspace is not None:
            headers['X-Prism-Workspace'] = workspace
        if body is not None:
            headers['Origin'] = self.origin
            if isinstance(body, bytes):
                headers['Content-Type'] = 'application/octet-stream'
            else:
                headers['Content-Type'] = 'application/json'
                body = json.dumps(body, ensure_ascii=False).encode()
        request = Request(self.origin + path, data=body, headers=headers)
        try:
            response = self.opener.open(request, timeout=12)
        except HTTPError as error:
            response = error
        with response:
            data = response.read()
            if response.headers.get_content_type() == 'application/json':
                data = json.loads(data)
            return response.status, data, response.headers


class EcosystemTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.outbox = self.root / 'outbox.jsonl'
        self.data = self.root / 'workspace'
        self.start(self.data)
        self.addCleanup(self.stop)

    def start(self, data):
        env = {key: value for key, value in os.environ.items() if not key.startswith('PRISM_SMTP_')}
        env['PRISM_AUTH_TEST_OUTBOX'] = str(self.outbox)
        self.service = subprocess.Popen(
            [sys.executable, '-u', 'server.py', '--port', '0', '--data-dir', str(data)],
            cwd=EDITOR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(self.service.stdout, selectors.EVENT_READ)
                ready = selector.select(timeout=15)
                line = self.service.stdout.readline().decode('utf-8', 'replace').strip() if ready else ''
            self.assertTrue(line.startswith('Prism ready on http://127.0.0.1:'), line)
            self.origin = line.removeprefix('Prism ready on ')
        except BaseException:
            self.stop()
            raise

    def stop(self):
        if self.service.poll() is None:
            self.service.terminate()
            try:
                self.service.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.service.kill()
                self.service.wait(timeout=5)
        self.service.stdout.close()

    def expect(self, client, path, body=None, *, status=200, workspace=None):
        actual, data, headers = client.call(path, body, workspace=workspace)
        self.assertEqual(actual, status, data if isinstance(data, dict) else path)
        return data, headers

    def account(self, client, name):
        email = name + '@example.test'
        self.expect(client, '/api/community/register', {'email': email, 'password': PASSWORD, 'displayName': name})
        self.assertIsNone(self.expect(client, '/api/community/session')[0])
        rows = [json.loads(line) for line in self.outbox.read_text().splitlines()]
        message = next(row for row in reversed(rows) if row['to'] == email and row['purpose'] == 'register')
        url = urlsplit(message['link'])
        self.assertEqual(f'{url.scheme}://{url.netloc}', self.origin)
        token = parse_qs(url.fragment.partition('?')[2])['token'][0]
        self.expect(client, '/api/community/verify-email', {'token': token, 'password': PASSWORD})
        return self.login(client, name)

    def login(self, client, name):
        data, headers = self.expect(client, '/api/community/login', {'identity': name + '@example.test', 'password': PASSWORD})
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertNotIn(PASSWORD, json.dumps(data))
        return self.expect(client, '/api/community/session')[0]['id']

    def test_publish_download_reuse_and_restore(self):
        local = Client(self.origin)
        cover = io.BytesIO()
        Image.new('RGB', (8, 12), '#237ac2').save(cover, format='PNG')
        preview = 'data:image/png;base64,' + base64.b64encode(cover.getvalue()).decode()
        card = dict(id='source-card', name='底纹样件', material='white', widthMm=63, heightMm=88, bleedMm=3,
                    front=dict(nodes=[], effects=[], regions=[]), back=dict(nodes=[], effects=[], regions=[]))
        snapshot = dict(card=card, cover=preview, backCover=preview, fonts=[],
                        digest=hashlib.sha256(json.dumps({'card': card, 'fonts': []}, ensure_ascii=False,
                                                         separators=(',', ':')).encode()).hexdigest())
        payload = {'expected': 0, 'projectId': 'test-local-project', 'cardId': card['id'],
                   'name': card['name'], 'snapshot': snapshot}
        self.expect(local, '/api/card-assets/original/save', payload, workspace='local', status=401)
        self.expect(local, '/api/card-assets?scope=local', status=401)
        _, headers = self.expect(local, '/api/projects', status=401)
        self.assertEqual(headers['X-Prism-Workspace'], 'guest')
        self.expect(local, '/api/projects/test-local-project', status=401)
        self.expect(local, '/api/projects/test-local-project', {'project': {}}, status=401)
        self.expect(local, '/api/lan', status=401)
        self.expect(local, '/api/export', {'project': {}}, status=401)
        self.assertEqual(self.expect(local, '/api/community/works')[0], [])
        legacy_store = ProjectStore(self.data / 'projects.sqlite3')
        with legacy_store.connection() as db:
            asset_operation(db, 'POST', '/api/card-assets/original/save', payload)
            db.execute("""INSERT INTO projects (id,name,width_mm,height_mm,updated_at,archived_at,revision,mutation,document)
                       VALUES ('test-local-project','旧归档',63,88,1,2,3,'recorded','{}')""")
            db.execute("INSERT INTO deliveries VALUES ('test-local-project','old-delivery','{}',X'BEEF')")

        author, reader, visitor = (Client(self.origin) for _ in range(3))
        owner_id = self.account(author, 'author')
        reader_id = self.account(reader, 'reader')
        self.account(visitor, 'visitor')
        self.assertEqual(self.expect(author, '/api/card-assets', workspace=owner_id)[0], [])
        self.expect(author, '/api/card-assets?scope=local', status=404)
        self.expect(author, '/api/card-assets/original/adopt-local', {'version': 1}, workspace=owner_id, status=404)
        expected = {'projects': 1, 'deliveries': 1, 'card_assets': 1, 'card_asset_versions': 1}
        for _ in range(2):
            migrated = subprocess.run([sys.executable, 'scripts/migrate-account-library.py',
                                      '--data-dir', str(self.data), '--account', owner_id],
                                      cwd=EDITOR, capture_output=True, text=True)
            self.assertEqual(migrated.returncode, 0, migrated.stderr)
            self.assertEqual(json.loads(migrated.stdout)['copied'], expected)
            expected = dict.fromkeys(expected, 0)
        private, _ = self.expect(author, '/api/card-assets', workspace=owner_id)
        self.assertEqual([item['id'] for item in private], ['original'])
        self.assertEqual(self.expect(author, '/api/projects')[0][0]['archivedAt'], 2)
        self.assertEqual(self.expect(author, '/api/projects/test-local-project/deliveries/old-delivery')[0], b'\xbe\xef')
        self.assertEqual(self.expect(reader, '/api/projects')[0], [])
        self.expect(local, '/api/card-assets', workspace='local', status=401)

        publishing = dict(asset='original', assetVersion=1, expectedEdition=0, name='底纹样件',
                          category='card', description='', grant=True)
        status, _, _ = reader.call('/api/community/publish', publishing, workspace=reader_id)
        self.assertIn(status, (403, 404))
        released, _ = self.expect(author, '/api/community/publish', publishing, workspace=owner_id)
        self.assertEqual(released, self.expect(author, '/api/community/publish', publishing, workspace=owner_id)[0])
        work, edition = released['id'], released['edition']
        source = {'work': work, 'edition': edition}
        self.expect(local, f'/api/community/work/{work}')
        self.expect(local, f'/api/community/card/{work}/{edition}', status=401)
        self.expect(reader, '/api/community/copy', source)
        self.expect(reader, '/api/community/copy', source)
        self.assertEqual(len(self.expect(reader, '/api/community/library')[0]), 1)
        self.expect(reader, '/api/community/download', source, workspace=owner_id, status=409)

        package, headers = self.expect(reader, '/api/community/download', source, workspace=reader_id)
        self.assertIn('.prismasset', headers['Content-Disposition'])
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            self.assertIsNone(archive.testzip())
            members = {name: archive.read(name) for name in archive.namelist()}
        status, _, _ = visitor.call('/api/community/import-asset', package)
        self.assertIn(status, (403, 409))
        self.expect(reader, '/api/community/inspect-asset', package)
        self.expect(reader, '/api/community/import-asset', package)
        self.assertEqual(len(self.expect(reader, '/api/community/library')[0]), 1)
        manifest_name = next(name for name in members if name.endswith('manifest.json'))
        invalid = io.BytesIO()
        with zipfile.ZipFile(invalid, 'w') as archive:
            for name, content in members.items():
                archive.writestr(name, content + b'x' if name == manifest_name else content)
        status, _, _ = reader.call('/api/community/import-asset', invalid.getvalue())
        self.assertEqual(status, 400)

        claimed, _ = self.expect(reader, f'/api/community/card/{work}/{edition}')
        claimed.update(id='reader-card', name='我的改版')
        claimed.setdefault('communityOrigin', dict(workId=work, edition=edition, author='author'))
        project = dict(id='reader-project', name='独立改版', version=1, cards=[claimed])
        self.expect(reader, '/api/projects/reader-project',
                    {'project': project, 'revision': 0, 'mutation': str(uuid.uuid4())}, workspace=reader_id)
        event = dict(cardId=claimed['id'], source=dict(kind='received', **source))
        for _ in range(2):
            self.expect(reader, '/api/projects/reader-project/asset-use', event, workspace=reader_id)
        with sqlite3.connect(self.data / 'community.sqlite3') as db:
            counts = dict(db.execute('SELECT event, COUNT(*) FROM asset_events GROUP BY event'))
        self.assertEqual({kind: counts[kind] for kind in ('publish', 'copy', 'download', 'use')},
                         dict(publish=1, copy=1, download=1, use=1))

        revised, _ = self.expect(author, '/api/community/publish',
                                 {**publishing, 'coverFace': 'back', 'expectedEdition': edition})
        self.assertEqual(revised['edition'], edition + 1)
        self.assertEqual(self.expect(local, f'/api/community/work/{work}')[0]['coverFace'], 'back')
        self.assertEqual(self.expect(reader, f'/api/community/holding/{work}/{edition}')[0]['coverFace'], 'front')
        self.expect(author, '/api/community/withdraw', {'work': work, 'edition': revised['edition']})
        self.assertIsNone(self.expect(author, '/api/community/publication/original')[0])
        inactive, _ = self.expect(author, '/api/community/publication/original?includeInactive=1')
        self.assertEqual((inactive['state'], inactive['edition']), ('withdrawn', revised['edition']))
        self.expect(author, '/api/community/publish', {**publishing, 'expectedEdition': inactive['edition']}, status=409)
        self.expect(reader, '/api/community/download', source)
        status, _, _ = visitor.call('/api/community/copy', source)
        self.assertIn(status, (409, 410))
        self.expect(reader, '/api/community/remove', source)
        self.assertEqual(self.expect(reader, '/api/community/library')[0], [])
        self.expect(reader, '/api/community/download', source, status=403)
        self.expect(reader, '/api/community/import-asset', package)
        self.assertEqual(len(self.expect(reader, '/api/community/library')[0]), 1)

        self.stop()
        backup = self.root / 'restored'
        shutil.copytree(self.data, backup)
        self.start(backup)
        fresh = Client(self.origin)
        self.assertEqual(self.login(fresh, 'reader'), reader_id)
        restored_project, _ = self.expect(fresh, '/api/projects/reader-project', workspace=reader_id)
        self.assertEqual(restored_project['project']['cardName'], '我的改版')
        self.assertEqual(self.expect(fresh, f'/api/community/holding/{work}/{edition}')[0]['name'], '底纹样件')
        self.expect(fresh, '/api/community/import-asset', package)

    def test_private_asset_warns_about_device_fonts_without_embedding_unrelated_files(self):
        author = Client(self.origin)
        owner_id = self.account(author, 'font-owner')
        cover = io.BytesIO()
        Image.new('RGB', (8, 12), '#237ac2').save(cover, format='PNG')
        preview = 'data:image/png;base64,' + base64.b64encode(cover.getvalue()).decode()
        card = dict(id='font-card', name='字体样件', material='white', widthMm=63, heightMm=88, bleedMm=3,
                    singleSided=True,
                    front=dict(effects=[], regions=[], nodes=[dict(type='text', name='标题',
                        fontRef=dict(kind='device', family='设备字体', style='Regular', postScriptName='DeviceFont'))]),
                    back=dict(nodes=[], effects=[], regions=[]))
        snapshot = dict(card=card, cover=preview, digest='a'*64, fonts=[
            dict(ref=dict(kind='imported', id='unused', share=True), data='data:application/octet-stream;base64,QQ==')])
        self.expect(author, '/api/card-assets/font-test/save',
                    {'expected': 0, 'projectId': 'font-project', 'cardId': card['id'],
                     'name': card['name'], 'snapshot': snapshot}, workspace=owner_id)
        package, _ = self.expect(author, '/api/community/download', {'asset':'font-test','assetVersion':1})
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            self.assertEqual(json.loads(archive.read('asset.json'))['fonts'], [])
        inspected, _ = self.expect(author, '/api/community/inspect-asset', package)
        self.assertEqual(inspected['fontWarnings'], ['设备字体'])


if __name__ == '__main__':
    unittest.main()
