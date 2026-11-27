"""Copy an old Prism library into one explicitly selected account."""

import argparse
import json
import os
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from card_asset_store import initialize
from project_store import ProjectStore


TABLES = ('projects', 'deliveries', 'card_assets', 'card_asset_versions')


def backup(source, snapshot):
    snapshot.touch(mode=0o600, exist_ok=False)
    with closing(sqlite3.connect(source)) as before, closing(sqlite3.connect(snapshot)) as after:
        before.execute('PRAGMA query_only=ON')
        before.backup(after)
        after.execute('PRAGMA journal_mode=DELETE')
        if after.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('备份校验失败')


def rows_match(columns):
    return ' AND '.join(f's."{column}" IS d."{column}"' for column in columns)


def copy_library(source, target):
    with closing(sqlite3.connect(target, timeout=15, uri=True)) as db, db:
        db.execute('ATTACH DATABASE ? AS previous', (source.as_uri() + '?mode=ro',))
        db.execute('BEGIN IMMEDIATE')
        result = {}
        for table in TABLES:
            info = db.execute(f'PRAGMA previous.table_info({table})').fetchall()
            if not info:
                result[table] = 0
                continue
            columns = [row[1] for row in info]
            destination = [row[1] for row in db.execute(f'PRAGMA main.table_info({table})')]
            if set(columns) != set(destination):
                raise RuntimeError(f'{table} 的版本不同，请先升级 Prism')
            pk = rows_match(row[1] for row in info if row[5])
            payload = rows_match(columns)
            source_rows = f'previous.{table} AS s'
            dest_rows = f'main.{table} AS d'
            if db.execute(f'SELECT 1 FROM {source_rows} JOIN {dest_rows} ON {pk} WHERE NOT ({payload}) LIMIT 1').fetchone():
                raise RuntimeError(f'{table} 中有同标识的不同记录，现有账号数据已保留')
            names = ', '.join(f'"{column}"' for column in columns)
            added = db.execute(f'''INSERT INTO main.{table} ({names})
                SELECT {names} FROM {source_rows} WHERE NOT EXISTS (SELECT 1 FROM {dest_rows} WHERE {pk})''')
            if db.execute(f'''SELECT 1 FROM {source_rows}
                WHERE NOT EXISTS (SELECT 1 FROM {dest_rows} WHERE {pk} AND {payload}) LIMIT 1''').fetchone():
                raise RuntimeError(f'{table} 迁移后的内容校验失败')
            result[table] = added.rowcount
        if db.execute('PRAGMA main.quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('账号项目库校验失败')
        return result


def migrate(data, account):
    source, identity = data / 'projects.sqlite3', data / 'community.sqlite3'
    if not source.is_file() or not identity.is_file():
        raise RuntimeError('找不到本机项目库或账号库')
    with closing(sqlite3.connect(identity)) as db:
        db.execute('PRAGMA query_only=ON')
        owners = db.execute('SELECT id FROM users WHERE id=? OR handle=?', (account, account)).fetchall()
    owner = owners[0][0] if len(owners) == 1 else None
    if not owner or len(owner) != 32 or any(value not in '0123456789abcdef' for value in owner):
        raise RuntimeError('找不到已注册的目标账号')
    target = data / 'accounts' / owner / 'projects.sqlite3'
    backups = data / 'migration-backups'
    backups.mkdir(mode=0o700, exist_ok=True)
    snapshot = backups / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    snapshot.mkdir(mode=0o700)
    backup(source, snapshot / 'local-projects.sqlite3')
    backup(identity, snapshot / 'community.sqlite3')
    if target.is_file():
        backup(target, snapshot / 'account-projects.sqlite3')
    with ProjectStore(target).connection() as db:
        initialize(db)
    return {'copied': copy_library(snapshot / 'local-projects.sqlite3', target), 'backup': str(snapshot)}


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('--account', required=True, help='现有 Prism 账号 ID 或旧版账号名')
    args = parser.parse_args()
    try:
        print(json.dumps(migrate(args.data_dir.expanduser().resolve(), args.account), ensure_ascii=False))
    except (RuntimeError, OSError, sqlite3.Error) as error:
        parser.exit(1, f'{error}\n')
