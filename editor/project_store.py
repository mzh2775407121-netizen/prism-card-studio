"""Revision-checked storage for the local Prism project library."""

import json
import base64
import binascii
import hashlib
import re
import sqlite3
import time
from contextlib import contextmanager

PROJECT_ID = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')
MUTATION_ID = re.compile(r'[a-fA-F0-9-]{36}\Z')
METADATA = 'id, name, width_mm, height_mm, updated_at, archived_at, revision, card_count'
MAX_PROJECT_NOTE_LENGTH = 500
PROJECT_FIELDS = ('id', 'name', 'version', 'updatedAt', 'note', 'stylePresets', 'canvasFacePositions', 'projectCover')
CARD_FIELDS = ('cardId', 'cardName', 'additionalCards')
MAX_CANVAS_POSITION = 1_000_000_000
STOCK_REFLECTIONS = ('none', 'mirror', 'matte-silver', 'rainbow', 'dots', 'cracked-ice', 'pillar', 'radial')


class ProjectError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def valid_revision(value, minimum=0):
    return type(value) is int and minimum <= value < 2**53


def valid_number(value, low, high):
    return type(value) in (int, float) and low <= value <= high


def valid_text(value, limit):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def validate_finish(finish):
    if (
        not isinstance(finish, dict) or finish.get('style') not in STOCK_REFLECTIONS
        or not valid_number(finish.get('opacity'), 0, 1)
        or any(key in finish and type(finish[key]) is not bool for key in ('visible', 'reviewRequired'))
    ):
        raise ProjectError('卡面反光参数无效')
    if 'match' not in finish:
        return
    match = finish['match']
    if (
        finish['style'] == 'none' or not isinstance(match, dict)
        or not valid_text(match.get('materialCode'), 120)
        or ('patternCode' in match and not valid_text(match['patternCode'], 120))
        or not valid_number(match.get('orientationDeg'), -360, 360) or type(match.get('transparent')) is not bool
        or match.get('method') not in ('composite', 'underprint', 'overlaminate')
        or not all(valid_text(match.get(key), 4000) for key in ('profileKey', 'stockKey'))
    ):
        raise ProjectError('卡面反光料号无效')


def validate_card(card):
    if not isinstance(card, dict) or not valid_text(card.get('id'), 302) or not valid_text(card.get('name'), 500):
        raise ProjectError('卡牌名称或标识无效')
    for key, low, high in (('widthMm', 10, 500), ('heightMm', 10, 500), ('bleedMm', 0, 20)):
        if not valid_number(card.get(key), low, high):
            raise ProjectError('卡片尺寸或出血无效')
    if not isinstance(card.get('material'), str):
        raise ProjectError('卡牌材质无效')
    if 'looseFace' in card and (card['looseFace'] != 'back' or card.get('singleSided') is not True):
        raise ProjectError('独立卡面的方向无效')
    if 'stockReflection' in card and card['stockReflection'] not in STOCK_REFLECTIONS:
        raise ProjectError('底材反光类型无效')
    if 'stockSpec' in card:
        spec = card['stockSpec']
        if (
            not isinstance(spec, dict) or ('grammageGsm' in spec and 'thicknessMm' in spec)
            or ('grammageGsm' in spec and not valid_number(spec['grammageGsm'], 1, 2000))
            or ('thicknessMm' in spec and not valid_number(spec['thicknessMm'], .01, 10))
            or ('core' in spec and spec['core'] not in ('white', 'none', 'blue', 'black', 'gray'))
        ):
            raise ProjectError('卡基规格无效')
    for side in ('front', 'back'):
        face = card.get(side)
        if not isinstance(face, dict) or not all(
            isinstance(face.get(key), list) and all(isinstance(item, dict) for item in face[key])
            for key in ('nodes', 'regions', 'effects')
        ):
            raise ProjectError('项目缺少完整的正反面数据')
        if 'stockFinish' in face:
            validate_finish(face['stockFinish'])
        if 'canvasLocked' in face and type(face['canvasLocked']) is not bool:
            raise ProjectError('卡面锁定状态无效')


def validate_style_presets(presets):
    if not isinstance(presets, list) or len(presets) > 32:
        raise ProjectError('项目样式预设数量无效')
    ids, names = set(), set()
    for preset in presets:
        if not isinstance(preset, dict):
            raise ProjectError('项目样式预设无效')
        identity, name, kind = preset.get('id'), preset.get('name'), preset.get('kind')
        if not isinstance(identity, str) or not 1 <= len(identity) <= 128 or identity in ids or \
                not isinstance(name, str) or len(name) > 40 or not name.strip() or kind not in ('gradient', 'effects'):
            raise ProjectError('项目样式预设无效')
        key = (kind, name.strip().lower())
        if key in names:
            raise ProjectError('项目样式预设名称重复')
        ids.add(identity)
        names.add(key)
        if kind == 'gradient':
            gradient = preset.get('gradient')
            stops = gradient.get('stops') if isinstance(gradient, dict) else None
            if not isinstance(stops, list) or not 2 <= len(stops) <= 24 or not all(
                    isinstance(stop, list) and len(stop) == 2 and valid_number(stop[0], 0, 1) and isinstance(stop[1], str)
                    for stop in stops):
                raise ProjectError('形状渐变无效')
        else:
            effects = preset.get('effects')
            if not isinstance(effects, list) or len(effects) > 12 or not all(isinstance(effect, dict) for effect in effects):
                raise ProjectError('图层效果数据无效')


def canonical_document(doc, project_id):
    if not isinstance(doc, dict) or doc.get('id') != project_id:
        raise ProjectError('项目标识无效')
    name = doc.get('name')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 500:
        raise ProjectError('请输入有效的项目名称')
    if 'note' in doc:
        note = doc['note']
        if not isinstance(note, str) or len(note) > MAX_PROJECT_NOTE_LENGTH:
            raise ProjectError('项目备注无效')
    if 'stylePresets' in doc:
        validate_style_presets(doc['stylePresets'])
    if not valid_revision(doc.get('version'), 1):
        raise ProjectError('项目版本无效')
    if 'cards' in doc:
        cards = doc['cards']
    else:
        additional = doc.get('additionalCards', [])
        if not isinstance(additional, list):
            raise ProjectError('项目卡牌列表无效')
        first = {key: value for key, value in doc.items() if key not in PROJECT_FIELDS + CARD_FIELDS}
        first.update(id=doc.get('cardId', project_id + '_1'), name=doc.get('cardName', '卡牌 1'))
        cards = [first, *additional]
    if not isinstance(cards, list) or not cards:
        raise ProjectError('项目缺少卡牌')
    ids = set()
    for card in cards:
        validate_card(card)
        if card['id'] in ids:
            raise ProjectError('卡牌标识重复')
        ids.add(card['id'])
    if 'projectCover' in doc:
        cover = doc['projectCover']
        if not isinstance(cover, dict) or cover.get('face') not in ('front', 'back') or not any(
            card['id'] == cover.get('cardId') and (cover['face'] == 'front' or not card.get('singleSided'))
            for card in cards
        ):
            raise ProjectError('项目封面对应的卡面无效')
    if 'canvasFacePositions' in doc:
        positions = doc['canvasFacePositions']
        face_keys = {
            f"{card['id']}:{slot}"
            for card in cards
            for slot in (('front',) if card.get('singleSided') else ('front', 'back'))
        }
        if not isinstance(positions, dict) or any(
            key not in face_keys or not isinstance(point, dict) or not all(
                valid_number(point.get(axis), -MAX_CANVAS_POSITION, MAX_CANVAS_POSITION) for axis in ('x', 'y')
            )
            for key, point in positions.items()
        ):
            raise ProjectError('卡面画布坐标无效')
    return {
        **{key: doc[key] for key in PROJECT_FIELDS if key in doc},
        'cards': cards,
    }


def editor_document(doc):
    if 'cards' not in doc:
        return doc
    first, *additional = doc['cards']
    result = {
        **{key: value for key, value in first.items() if key not in ('id', 'name')},
        **{key: doc[key] for key in PROJECT_FIELDS if key in doc},
        'cardId': first['id'],
        'cardName': first['name'],
    }
    if additional:
        result['additionalCards'] = additional
    return result


def project_payload(row):
    result = {
        'id': row['id'], 'name': row['name'], 'widthMm': row['width_mm'],
        'heightMm': row['height_mm'], 'updatedAt': row['updated_at'],
        'archivedAt': row['archived_at'], 'revision': row['revision'], 'cardCount': row['card_count'],
    }
    if 'document' in row.keys():
        result['project'] = editor_document(json.loads(row['document']))
    return result


class ProjectStore:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('BEGIN IMMEDIATE')
            db.execute('''CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                width_mm REAL NOT NULL,
                height_mm REAL NOT NULL,
                updated_at INTEGER NOT NULL,
                archived_at INTEGER,
                revision INTEGER NOT NULL,
                mutation TEXT NOT NULL,
                document TEXT NOT NULL,
                card_count INTEGER NOT NULL DEFAULT 1
            )''')
            if not any(column['name'] == 'card_count' for column in db.execute('PRAGMA table_info(projects)')):
                db.execute('ALTER TABLE projects ADD COLUMN card_count INTEGER NOT NULL DEFAULT 1')
            db.execute('''CREATE TABLE IF NOT EXISTS deliveries (
                project_id TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL, source BLOB NOT NULL,
                PRIMARY KEY(project_id,id))''')

    def deliveries(self, project_id):
        with self.connection() as db:
            return [json.loads(row['metadata']) for row in db.execute(
                'SELECT metadata FROM deliveries WHERE project_id=?', (project_id,))]

    def delivery_source(self, project_id, delivery_id):
        with self.connection() as db:
            row = db.execute('SELECT source FROM deliveries WHERE project_id=? AND id=?',
                             (project_id, delivery_id)).fetchone()
            if row is None:
                raise ProjectError('交付版本不存在', 404)
            return row['source']

    def save_delivery(self, project_id, payload):
        entry = payload.get('entry')
        if (not isinstance(entry, dict) or entry.get('projectId') != project_id
                or not isinstance(entry.get('id'), str) or not MUTATION_ID.fullmatch(entry['id'])
                or not valid_revision(entry.get('revision'), 1) or not valid_revision(entry.get('cardIndex'))
                or not valid_text(entry.get('cardId'), 302) or not valid_text(entry.get('cardName'), 500)
                or entry.get('mode') not in ('image', 'print') or not valid_revision(entry.get('time'), 1)
                or not isinstance(entry.get('faces'), list) or not 1 <= len(entry['faces']) <= 2
                or not all(face in ('front','back') for face in entry['faces'])
                or any(not valid_text(entry.get(field), 1100) for field in ('profile', 'output','engine'))
                or not valid_number(entry.get('dpi'), 1, 9600)
                or any(not isinstance(entry.get(key),str) or not re.fullmatch('[0-9a-f]{64}',entry[key])
                       for key in ('sourceHash','checksum'))):
            raise ProjectError('交付记录无效')
        try:
            source = base64.b64decode(payload.get('source', ''), validate=True)
        except (ValueError, TypeError, binascii.Error) as error:
            raise ProjectError('交付源稿无效') from error
        if not 0 < len(source) <= 100*1024*1024 or hashlib.sha256(source).hexdigest() != entry['sourceHash']:
            raise ProjectError('交付源稿校验失败')
        metadata = json.dumps(entry, ensure_ascii=False, sort_keys=True)
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM projects WHERE id=?',(project_id,)).fetchone():
                raise ProjectError('项目不存在',404)
            old = db.execute('SELECT metadata FROM deliveries WHERE project_id=? AND id=?',(project_id,entry['id'])).fetchone()
            if old and old['metadata'] != metadata:
                raise ProjectError('交付记录已有不同内容',409)
            if not old:
                db.execute('INSERT INTO deliveries VALUES (?,?,?,?)',(project_id,entry['id'],metadata,source))
        return {'id': entry['id']}

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

    def summary(self, project_id):
        with self.connection() as db:
            row = db.execute(f'SELECT {METADATA} FROM projects WHERE id=?', (project_id,)).fetchone()
            if row is None:
                raise ProjectError('项目不存在', 404)
            return project_payload(row)

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
        doc = canonical_document(payload.get('project'), project_id)
        cards = doc['cards']
        first = cards[0]
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
                           revision=?, mutation=?, document=?, card_count=? WHERE id=?''',
                           (doc['name'], first['widthMm'], first['heightMm'], now, revision + 1, mutation, document, len(cards), project_id))
            else:
                db.execute('''INSERT INTO projects (id, name, width_mm, height_mm, updated_at, revision, mutation, document, card_count)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                           (project_id, doc['name'], first['widthMm'], first['heightMm'], now, 1, mutation, document, len(cards)))
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
