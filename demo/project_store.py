"""Revision-checked storage for the local Prism project library."""

import json
import re
import sqlite3
import time
from contextlib import contextmanager

PROJECT_ID = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')
MUTATION_ID = re.compile(r'[a-fA-F0-9-]{36}\Z')
METADATA = 'id, name, width_mm, height_mm, updated_at, archived_at, revision'


class ProjectError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def valid_revision(value, minimum=0):
    return type(value) is int and minimum <= value < 2**53


def validate_document(doc, project_id):
    if not isinstance(doc, dict) or doc.get('id') != project_id:
        raise ProjectError('项目标识无效')
    name = doc.get('name')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 500:
        raise ProjectError('请输入有效的项目名称')
    for key, low, high in (('widthMm', 10, 500), ('heightMm', 10, 500), ('bleedMm', 0, 20)):
        value = doc.get(key)
        if type(value) not in (int, float) or not low <= value <= high:
            raise ProjectError('卡片尺寸或出血无效')
    if not isinstance(doc.get('material'), str) or not valid_revision(doc.get('version'), 1):
        raise ProjectError('项目材质或版本无效')
    for side in ('front', 'back'):
        face = doc.get(side)
        if not isinstance(face, dict) or not all(
            isinstance(face.get(key), list) and all(isinstance(item, dict) for item in face[key])
            for key in ('nodes', 'regions', 'effects')
        ):
            raise ProjectError('项目缺少完整的正反面数据')


def project_payload(row):
    result = {
        'id': row['id'], 'name': row['name'], 'widthMm': row['width_mm'],
        'heightMm': row['height_mm'], 'updatedAt': row['updated_at'],
        'archivedAt': row['archived_at'], 'revision': row['revision'],
    }
    if 'document' in row.keys():
        result['project'] = json.loads(row['document'])
    return result


class ProjectStore:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                width_mm REAL NOT NULL,
                height_mm REAL NOT NULL,
                updated_at INTEGER NOT NULL,
                archived_at INTEGER,
                revision INTEGER NOT NULL,
                mutation TEXT NOT NULL,
                document TEXT NOT NULL
            )''')

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def list(self):
        with self.connection() as db:
            return [project_payload(row) for row in db.execute(
                f'SELECT {METADATA} FROM projects ORDER BY updated_at DESC, id'
            )]

    def get(self, project_id):
        with self.connection() as db:
            row = db.execute(f'SELECT {METADATA}, document FROM projects WHERE id=?', (project_id,)).fetchone()
            if row is None:
                raise ProjectError('项目不存在', 404)
            return project_payload(row)

    def save(self, project_id, payload):
        revision, mutation = payload.get('revision'), payload.get('mutation')
        if not valid_revision(revision) or not isinstance(mutation, str) or not MUTATION_ID.fullmatch(mutation):
            raise ProjectError('保存版本无效')
        doc = payload.get('project')
        validate_document(doc, project_id)
        now = time.time_ns() // 1_000_000
        doc['updatedAt'] = now
        try:
            document = json.dumps(doc, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
        except (ValueError, RecursionError) as error:
            raise ProjectError('项目包含无效数据') from error

        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute(f'SELECT {METADATA}, mutation FROM projects WHERE id=?', (project_id,)).fetchone()
            if row and row['mutation'] == mutation and row['revision'] == revision + 1:
                return project_payload(row)
            if (row and (row['revision'] != revision or row['archived_at'] is not None)) or (not row and revision != 0):
                raise ProjectError('此项目已有更新，请重新打开或将当前修改另存为副本', 409)
            if row:
                db.execute('''UPDATE projects SET name=?, width_mm=?, height_mm=?, updated_at=?,
                           revision=?, mutation=?, document=? WHERE id=?''',
                           (doc['name'], doc['widthMm'], doc['heightMm'], now, revision + 1, mutation, document, project_id))
            else:
                db.execute('''INSERT INTO projects (id, name, width_mm, height_mm, updated_at, revision, mutation, document)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                           (project_id, doc['name'], doc['widthMm'], doc['heightMm'], now, 1, mutation, document))
            return project_payload(db.execute(f'SELECT {METADATA} FROM projects WHERE id=?', (project_id,)).fetchone())

    def archive(self, project_id, payload):
        revision, archived = payload.get('revision'), payload.get('archived')
        if not valid_revision(revision, 1) or type(archived) is not bool:
            raise ProjectError('项目状态无效')
        with self.connection() as db:
            changed = db.execute('''UPDATE projects SET archived_at=?, revision=revision+1
                                 WHERE id=? AND revision=?''',
                                 (time.time_ns() // 1_000_000 if archived else None, project_id, revision))
            if changed.rowcount != 1:
                raise ProjectError('项目状态已变化，请刷新项目库', 409)
            return project_payload(db.execute(f'SELECT {METADATA} FROM projects WHERE id=?', (project_id,)).fetchone())
