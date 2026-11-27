"""Signed, account-bound single card archives and release schema extensions."""

import hashlib
import hmac
import io
import json
import re
import secrets
import time
import zipfile
from dataclasses import dataclass
from urllib.parse import quote

from project_store import ProjectError


MAX_PACKAGE_BYTES = 150 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024
PACKAGE_SCHEMA = 'prism-asset/v1'
LICENSE_VERSION = 'prism-personal-v1'
LICENSE_SCOPE = 'personal-edit-private'


@dataclass(frozen=True)
class AssetDownload:
    body: bytes
    name: str

    @property
    def disposition(self):
        safe_name = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', '_', self.name).strip(' .')[:100] or 'Prism'
        return 'attachment; filename="Prism.prismasset"; filename*=UTF-8\'\'' + quote(safe_name + '.prismasset', safe='')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def migrate(db):
    fields = {column['name'] for column in db.execute('PRAGMA table_info(editions)')}
    for name, sql_type in (('asset_version', 'INTEGER'), ('published_author', 'TEXT'),
                           ('license_version', 'TEXT'), ('licensed_at', 'INTEGER'),
                           ('cover_face', "TEXT NOT NULL DEFAULT 'front'")):
        if name not in fields:
            db.execute(f'ALTER TABLE editions ADD COLUMN {name} {sql_type}')
    # v0.6 used the asset version as the edition number. Historic names and
    # confirmation times are unknown, so leave those nullable on historic rows.
    db.execute('UPDATE editions SET asset_version=edition WHERE asset_version IS NULL')
    db.execute('UPDATE editions SET license_version=? WHERE license_version IS NULL', (LICENSE_VERSION,))
    db.execute('''CREATE TABLE IF NOT EXISTS asset_package_signing (
        singleton INTEGER PRIMARY KEY CHECK (singleton=1), secret BLOB NOT NULL)''')
    db.execute('INSERT OR IGNORE INTO asset_package_signing VALUES (1,?)', (secrets.token_bytes(32),))
    db.execute('''CREATE TABLE IF NOT EXISTS asset_events (
        event TEXT NOT NULL, actor TEXT NOT NULL, item TEXT NOT NULL, version INTEGER NOT NULL,
        created INTEGER NOT NULL, PRIMARY KEY(event,actor,item,version))''')


def event(db, action, actor, item, version):
    db.execute('INSERT OR IGNORE INTO asset_events VALUES (?,?,?,?,?)',
               (action, actor, item, version, time.time_ns() // 1_000_000))


def signing_key(db):
    return db.execute('SELECT secret FROM asset_package_signing WHERE singleton=1').fetchone()[0]


def encode(secret, claims, snapshot):
    data = canonical(snapshot)
    if len(data) > MAX_PACKAGE_BYTES:
        raise ProjectError('资产内容超过下载容量上限', 413)
    manifest = dict(claims, schema=PACKAGE_SCHEMA, bytes=len(data), sha256=sha256(data))
    signature = hmac.new(secret, canonical(manifest), hashlib.sha256).hexdigest()
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
        target.writestr('manifest.json', canonical(dict(manifest, signature=signature)))
        target.writestr('asset.json', data)
    return bytes(archive.getbuffer())


def decode(secret, archive, owner):
    if not isinstance(archive, bytes) or not 0 < len(archive) <= MAX_PACKAGE_BYTES:
        raise ProjectError('资产包无效或超过容量上限', 413)
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            names = source.namelist()
            if len(names) != 2 or set(names) != {'manifest.json', 'asset.json'}:
                raise ProjectError('请导入有效的 Prism 资产包')
            manifest_size = source.getinfo('manifest.json').file_size
            payload_size = source.getinfo('asset.json').file_size
            if manifest_size > MAX_MANIFEST_BYTES or payload_size > MAX_PACKAGE_BYTES:
                raise ProjectError('资产包超过容量上限', 413)
            manifest = json.loads(source.read('manifest.json'))
            if not isinstance(manifest, dict) or manifest.get('schema') != PACKAGE_SCHEMA:
                raise ProjectError('当前版本无法打开此资产包')
            signature = manifest.pop('signature', '')
            expected = hmac.new(secret, canonical(manifest), hashlib.sha256).hexdigest()
            if not isinstance(signature, str) or not signature.isascii() or not hmac.compare_digest(signature, expected):
                raise ProjectError('资产包签发记录无效或已损坏')
            if manifest.get('owner') != owner:
                raise ProjectError('请使用下载该资产包的账号。也可以从社区领取自己的版本。', 403)
            if manifest.get('bytes') != payload_size:
                raise ProjectError('资产包内容不完整')
            raw = source.read('asset.json')
            if sha256(raw) != manifest.get('sha256'):
                raise ProjectError('资产包内容不完整或已损坏')
            return manifest, json.loads(raw)
    except ProjectError:
        raise
    except (ValueError, OSError, RuntimeError, NotImplementedError, zipfile.BadZipFile, EOFError, RecursionError) as error:
        raise ProjectError('无法读取资产包，请重新下载') from error
