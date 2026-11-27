"""Account-owned card editions and community releases for Prism's HTTP service."""

import base64
import hashlib
import io
import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from http.cookies import SimpleCookie
from typing import NamedTuple, Optional
from urllib.parse import urlsplit

from PIL import Image
from account_auth import AUTH_ACTIONS, SESSION_AGE, Accounts, migrate as migrate_accounts
from project_store import ProjectError, ProjectStore, PROJECT_ID, valid_number, validate_card
import asset_packages
import card_asset_store

MAX_BODY = 40 * 1024 * 1024
COOKIE = 'prism_community'
COMMUNITY_CATEGORIES = frozenset(('card', 'set', 'component', 'process', 'other'))
PUBLISHABLE_CATEGORIES = frozenset(('card', 'process', 'other'))
IMAGE_TYPES = {'data:image/png;base64':'PNG', 'data:image/jpeg;base64':'JPEG', 'data:image/webp;base64':'WEBP'}
REMOVED_IMAGE = ('data:image/png;base64,'
                 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=')
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, handle TEXT UNIQUE COLLATE NOCASE, salt BLOB, digest BLOB);
CREATE TABLE IF NOT EXISTS sessions (
 digest TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER);
CREATE TABLE IF NOT EXISTS works (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, asset TEXT NOT NULL, edition INTEGER,
 state TEXT NOT NULL, changed INTEGER, UNIQUE(owner,asset));
CREATE TABLE IF NOT EXISTS editions (
 work TEXT NOT NULL, edition INTEGER NOT NULL, name TEXT NOT NULL, description TEXT,
 width REAL, height REAL, single INTEGER, card TEXT, front BLOB, back BLOB,
 signature TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'card', PRIMARY KEY(work,edition));
CREATE TABLE IF NOT EXISTS holdings (
 uid TEXT NOT NULL, work TEXT NOT NULL, edition INTEGER NOT NULL, acquired INTEGER,
 PRIMARY KEY(uid,work,edition));
CREATE TABLE IF NOT EXISTS reports (
 uid TEXT, work TEXT, edition INTEGER, reason TEXT, created INTEGER,
 PRIMARY KEY(uid,work,edition));
CREATE TABLE IF NOT EXISTS resource_reports (
 uid TEXT NOT NULL, work TEXT NOT NULL, edition INTEGER NOT NULL, resource TEXT NOT NULL, reason TEXT NOT NULL,
 created INTEGER NOT NULL, PRIMARY KEY(uid,work,edition,resource));
CREATE TABLE IF NOT EXISTS resource_restrictions (
 work TEXT NOT NULL, edition INTEGER NOT NULL, resource TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(work,edition,resource));
CREATE TABLE IF NOT EXISTS resource_replacements (
 uid TEXT NOT NULL, work TEXT NOT NULL, edition INTEGER NOT NULL, resource TEXT NOT NULL, source TEXT NOT NULL,
 PRIMARY KEY(uid,work,edition,resource));
CREATE TABLE IF NOT EXISTS attempts (source TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS attempts_ts ON attempts(ts);
CREATE INDEX IF NOT EXISTS holdings_uid ON holdings(uid,acquired);
"""
BASE_SELECT = """SELECT w.id,w.owner,w.asset,w.state,w.edition currentEdition,COALESCE(u.display_name,u.handle) author,
 e.edition,e.name,e.description,e.width,e.height,e.single,e.category,w.changed,
 e.asset_version,e.published_author,e.license_version,e.cover_face
 FROM works w JOIN users u ON u.id=w.owner JOIN editions e ON w.id=e.work """


class EditionData(NamedTuple):
    name: str
    description: str
    width: float
    height: float
    single: int
    card: str
    front: bytes
    back: Optional[bytes]
    signature: str
    category: str


def require(condition, message, status=400):
    if not condition:
        raise ProjectError(message, status)


def field(data, key, maximum):
    value = data.get(key)
    require(isinstance(value, str) and 0 < len(value.strip()) <= maximum, '字段无效：' + key)
    return value.strip()


def number(data, key):
    value = data.get(key)
    require(type(value) is int and 0 < value < 2**31, '版本无效')
    return value


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def picture(value):
    require(isinstance(value, str), '缺少卡面预览')
    head, sep, body = value.partition(',')
    require(sep and head in ('data:image/png;base64', 'data:image/jpeg;base64', 'data:image/webp;base64')
            and len(body) < 4_000_000, '预览图片格式或大小无效')
    try:
        raw = base64.b64decode(body, validate=True)
        with Image.open(io.BytesIO(raw)) as img:
            require(img.format in ('PNG', 'JPEG', 'WEBP') and max(img.size) <= 2048, '预览图片过大')
            img.load()
            output = io.BytesIO()
            img.convert('RGBA').save(output, format='PNG')
        return output.getvalue()
    except (OSError, ValueError) as error:
        raise ProjectError('无法读取预览图片') from error


def replacement_image(value):
    require(isinstance(value, str), '请选择替换图片')
    header, separator, encoded = value.partition(',')
    require(separator and header in IMAGE_TYPES and 0 < len(encoded) <= 28_000_000, '请选择不超过 20 MB 的 PNG、JPEG 或 WebP')
    try:
        raw = base64.b64decode(encoded, validate=True)
        require(len(raw) <= 20 * 1024 * 1024, '替换图片不能超过 20 MB')
        with Image.open(io.BytesIO(raw)) as image:
            require(image.format == IMAGE_TYPES[header] and image.width * image.height <= 24_000_000, '替换图片的格式或尺寸无效')
            image.verify()
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        if isinstance(error, ProjectError):
            raise
        raise ProjectError('无法读取替换图片') from error
    return header + ',' + base64.b64encode(raw).decode('ascii')


def face_nodes(face):
    yield from face['nodes']
    for region in face['regions']:
        if isinstance(region.get('snapshot'), dict):
            yield region['snapshot']
    for effect in face['effects']:
        content = effect.get('maskContent')
        if isinstance(content, list):
            yield from (node for node in content if isinstance(node, dict))


def asset_font_files(snapshot):
    """Only include font files declared distributable and used by this snapshot."""
    refs = [node['fontRef'] for side in ('front', 'back') for node in face_nodes(snapshot['card'][side])
            if isinstance(node.get('fontRef'), dict)]
    compatible = {ref['id'] for ref in refs if isinstance(ref, dict) and ref.get('kind') == 'imported'
                  and ref.get('share') is True and isinstance(ref.get('id'), str)}
    files = []
    added = set()
    entries = snapshot.get('fonts')
    for entry in entries if isinstance(entries, list) else []:
        ref = entry.get('ref') if isinstance(entry, dict) else None
        if not isinstance(ref, dict) or ref.get('kind') != 'imported' or ref.get('share') is not True:
            continue
        key = ref.get('id')
        data = entry.get('data')
        if (isinstance(key, str) and key in compatible and key not in added
                and isinstance(data, str) and data.startswith('data:') and ';base64,' in data):
            files.append(entry)
            added.add(key)
    warnings = set()
    for ref in refs:
        kind, key = ref.get('kind'), ref.get('id')
        embedded = ref.get('share') is True and isinstance(key, str) and key in added
        if kind == 'device' or (kind == 'imported' and not embedded):
            warnings.add(str(ref.get('family') or '未命名字体')[:128])
    return files, sorted(warnings)


def resource_slots(card):
    for side in ('front', 'back'):
        face = card[side]
        label = '背面' if side == 'back' or card.get('looseFace') == 'back' else '正面'
        for node in face_nodes(face):
            name = label + ' · ' + str(node.get('name', '图片'))[:300]
            if node.get('type') == 'image' and isinstance(node.get('src'), str):
                yield node, name
            fill = node.get('imageFill')
            if isinstance(fill, dict) and isinstance(fill.get('src'), str):
                yield fill, name + ' · 图片填充'


def image_resources(card):
    result = {}
    for slot, label in resource_slots(card):
        identity = digest(slot['src'].encode())
        labels = result.setdefault(identity, set())
        labels.add(label)
    return result


# Only card design fields travel to another creator. Project identity, orders,
# print profiles, ancillary references and source storage addresses stay private.
CARD_FIELDS = set('id name widthMm heightMm bleedMm material previewStyle cornerRadiusMm singleSided looseFace stockReflection stockSpec front back production'.split())
SIDE_FIELDS = set('nodes regions effects groups stockFinish'.split())
DESIGN_KEYS = set('''id name type x y width height rotation flipX flipY opacity visible locked fill stroke
strokeWidth text fontSize fillOpacity fillHidden fillMode imageFill fit crop space tileScale presetId adjustments strokeOpacity strokeHidden
strokeLineCap strokeLineJoin strokeMiterLimit strokeAlign strokeStyle fontFamily fontStyle fontRef align src
verticalAlign blend lineHeight letterSpacing cornerRadius groupId clipRegionId unclassified printSafe maskInk
polygon pathPoints pathClosed in out gradient visualEffects layoutItem kind angle stops stopIds endpoints
radialAxis enabled radius spread color center strength nodeId binding inverted strokes points size erase
bounds snapshot sources operation contours fillRule groupMotionCopy maskSource regionId productionEnabled process pattern flashStyle
maskContent parentId autoLayout direction widthMode heightMode gap padding top right bottom left minWidth offset absolute
minHeight style reviewRequired appearance orientationDeg transparent method weight family postScriptName
textStyles start end bold symbol'''.split())
IMAGE_ADJUSTMENT_KEYS = frozenset('exposure contrast saturation brightness temperature tint highlights shadows'.split())
MAX_LAYOUT_ITEM_OFFSET = 1_000_000
TEXT_SYMBOLS = frozenset('★◆●▲◇✚')


def check_design(value, depth=0):
    require(depth < 32, '卡牌层级过深')
    if isinstance(value, list):
        for item in value:
            check_design(item, depth + 1)
    elif isinstance(value, dict):
        require(value.keys() <= DESIGN_KEYS, '卡牌包含尚不支持分发的属性')
        if 'src' in value:
            source = value['src']
            require(isinstance(source, str) and source.startswith(('data:image/png;base64,', 'data:image/jpeg;base64,',
                        'data:image/webp;base64,')), '请将图片导入为 PNG、JPEG 或 WebP 后再发布')
        if value.get('fontRef'):
            require(value['fontRef'].get('kind') == 'builtin', '请将设备或导入字体换为内置字体，或先转曲')
        for key, item in value.items():
            if key == 'adjustments':
                require(isinstance(item, dict) and item.keys() <= IMAGE_ADJUSTMENT_KEYS
                        and all(valid_number(level, -100, 100) for level in item.values()), '图片调色参数无效')
            elif key == 'offset':
                require(isinstance(item, dict) and item.keys() == {'x', 'y'} and
                        all(valid_number(axis, -MAX_LAYOUT_ITEM_OFFSET, MAX_LAYOUT_ITEM_OFFSET) for axis in item.values()),
                        '自动布局子项的位置偏移无效')
            elif key == 'absolute':
                require(item is True, '自动布局子项的自由定位状态无效')
            elif key == 'textStyles':
                text = value.get('text')
                require(value.get('type') == 'text' and isinstance(text, str) and isinstance(item, list), '局部文字样式无效')
                units = text.encode('utf-16-le', errors='surrogatepass')
                require(len(item) <= len(units)//2 <= 50_000, '局部文字样式无效')
                last = 0
                for style in item:
                    require(isinstance(style, dict) and style.keys() <= {'start','end','bold','color','symbol'}
                            and type(style.get('start')) is int and type(style.get('end')) is int
                            and last <= style['start'] < style['end'] <= len(units)//2
                            and style.keys() & {'bold','color','symbol'}
                            and ('bold' not in style or type(style['bold']) is bool)
                            and ('symbol' not in style or style['symbol'] is True)
                            and ('color' not in style or isinstance(style['color'], str)
                                 and re.fullmatch(r'#[0-9a-fA-F]{6}', style['color'])), '局部文字样式无效')
                    if style.get('symbol'):
                        symbols = units[style['start']*2:style['end']*2].decode('utf-16-le', errors='surrogatepass')
                        require(set(symbols) <= TEXT_SYMBOLS, '行内符号无效')
                    last = style['end']
            else:
                check_design(item, depth + 1)


def edition_data(body):
    category = body.get('category', 'card')
    require(isinstance(category, str) and category in PUBLISHABLE_CATEGORIES, '该分类暂不支持发布')
    card = body.get('card')
    require(isinstance(card, dict) and card.keys() <= CARD_FIELDS, '公开版本只接受独立的原创卡面')
    validate_card(card)
    if 'production' in card:
        plan = card['production']
        require(isinstance(plan, dict) and plan.keys() <= {'dieShape','steps'} and plan.get('steps') == []
                and plan.get('dieShape','card') in ('card','rectangle','ellipse'), '请移除印厂及订单数据')
    for side in ('front', 'back'):
        face = card[side]
        require(face.keys() <= SIDE_FIELDS, '卡面含有未清理的参考素材')
        for value in face.values():
            check_design(value)
        nodes = {n.get('id') for n in face['nodes']}
        regions = {r.get('id') for r in face['regions']}
        groups = {g.get('id') for g in face.get('groups',[])}
        require(None not in nodes|regions|groups and len(nodes)==len(face['nodes']) and len(regions)==len(face['regions']),
                '图层或蒙版标识无效')
        for node in face['nodes']:
            require('clipRegionId' not in node or node['clipRegionId'] in regions,'图层缺少裁切蒙版')
            require('groupId' not in node or node['groupId'] in groups,'图层组缺失')
        for effect in face['effects']:
            require(effect.get('regionId') in regions,'工艺作用区域缺失')
        for region in face['regions']:
            require(all(source in regions for source in region.get('sources',[])),'蒙版运算来源缺失')
            if region.get('kind')=='node':
                require(region.get('nodeId') in nodes or (region.get('binding')=='fixed' and
                        (region.get('snapshot') or region.get('bounds'))),
                        '找不到蒙版引用的图层')
    if card.get('singleSided'):
        require(not any(card['back'].get(k) for k in ('nodes','regions','effects','groups')), '请移除单面卡的隐藏背面')
    if 'stockSpec' in card:
        require(card['stockSpec'].keys() <= {'core','grammageGsm','thicknessMm'}, '材质规格含有私有配置')
    title = field(body, 'name', 120)
    description = body.get('description', '')
    require(isinstance(description, str) and len(description) <= 600, '说明限 600 字')
    require(body.get('grant') is True, '请确认允许复制、编辑及个人使用')
    raw = json.dumps(card, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)
    front = picture(body.get('cover'))
    back = None if card.get('singleSided') else picture(body.get('backCover'))
    signature = digest(json.dumps([raw, title, description, digest(front), digest(back or b''), category],
                                  ensure_ascii=False).encode())
    return EditionData(title, description, card['widthMm'], card['heightMm'], int(bool(card.get('singleSided'))),
                       raw, front, back, signature, category)


class CommunityStore:
    def __init__(self, path, public_origin=None, local_origin='http://127.0.0.1:4174'):
        self.path = path
        self.accounts = Accounts(self.connection, public_origin, local_origin)
        with self.connection() as db:
            db.executescript(SCHEMA)
            db.execute('BEGIN IMMEDIATE')
            if not any(column['name'] == 'category' for column in db.execute('PRAGMA table_info(editions)')):
                db.execute("ALTER TABLE editions ADD COLUMN category TEXT NOT NULL DEFAULT 'card'")
            migrate_accounts(db)
            asset_packages.migrate(db)

    @contextmanager
    def connection(self, mutation=False):
        db = sqlite3.connect(self.path, timeout=12)
        db.row_factory = sqlite3.Row
        try:
            if mutation:
                db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        finally:
            db.close()

    def auth(self, action, data, source):
        if action=='register' and 'handle' in data and 'email' not in data:
            return self.accounts.legacy_register(data,source)
        return self.accounts.handle(action,data,source,'')

    def user(self, db, token):
        return self.accounts.user(db,token)

    @staticmethod
    def summary(db, row, uid):
        obj = dict(row)
        owner = obj.pop('owner')
        source_asset = obj.pop('asset')
        obj['assetVersion'] = obj.pop('asset_version') or obj['edition']
        obj['authorId'] = owner
        obj['coverFace'] = obj.pop('cover_face')
        obj['publishedAuthor'] = obj.pop('published_author') or obj['author']
        obj['license'] = dict(version=obj.pop('license_version') or asset_packages.LICENSE_VERSION,
                              scope=asset_packages.LICENSE_SCOPE)
        obj['mine'] = owner == uid
        if obj['mine']:
            obj['ownedAsset'] = source_asset
        obj['held'] = bool(uid and db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',
                                             (uid,row['id'],row['edition'])).fetchone())
        restrictions = db.execute('''SELECT COUNT(*),COUNT(s.resource) FROM resource_restrictions r
            LEFT JOIN resource_replacements s ON s.uid=? AND s.work=r.work AND s.edition=r.edition AND s.resource=r.resource
            WHERE r.work=? AND r.edition=?''',(uid,row['id'],row['edition'])).fetchone()
        if restrictions[0]:
            obj['resourcesRestricted'] = restrictions[0]
            obj['resourcesPending'] = restrictions[0] - restrictions[1]
        return obj

    def asset_workspace(self, uid):
        return ProjectStore(self.path.parent / 'accounts' / uid / 'projects.sqlite3')

    def account_asset(self, uid, asset_id, version):
        require(PROJECT_ID.fullmatch(asset_id), '资产标识无效')
        with self.asset_workspace(uid).connection() as db:
            card_asset_store.initialize(db)
            return card_asset_store.version_record(db,asset_id,version)

    @staticmethod
    def restrictions(db, uid, work, edition):
        return dict(db.execute('''SELECT r.resource,s.source FROM resource_restrictions r
            LEFT JOIN resource_replacements s ON s.uid=? AND s.work=r.work AND s.edition=r.edition
            AND s.resource=r.resource WHERE r.work=? AND r.edition=?''',(uid,work,edition)))

    @staticmethod
    def corrected_card(card, replacements):
        for slot, _ in resource_slots(card):
            identity = digest(slot['src'].encode())
            if identity in replacements:
                slot['src'] = replacements[identity] or REMOVED_IMAGE
                slot.pop('presetId', None)
        return card

    @staticmethod
    def release_record(db, work, edition):
        row = db.execute('''SELECT e.*,w.owner,w.state,COALESCE(u.display_name,u.handle) current_author FROM editions e
                         JOIN works w ON w.id=e.work JOIN users u ON u.id=w.owner
                         WHERE e.work=? AND e.edition=?''',(work,edition)).fetchone()
        require(row, '找不到该作品版本',404)
        require(row['state']!='blocked','该作品已下架，资产包不可用',410)
        return row

    @staticmethod
    def check_private_download(db, uid, asset_id, card):
        source = db.execute('SELECT id,state FROM works WHERE owner=? AND asset=?',(uid,asset_id)).fetchone()
        origins = card.get('faceOrigins')
        references = [card.get('communityOrigin'), *(origins.values() if isinstance(origins,dict) else ())]
        works = {value['workId'] for value in references if isinstance(value,dict) and isinstance(value.get('workId'),str)}
        own_faces = card.get('assetFaceOrigins')
        owned_links = [card.get('assetOrigin'), *(own_faces.values() if isinstance(own_faces,dict) else ())]
        for link in owned_links:
            if isinstance(link,dict) and isinstance(link.get('assetId'),str):
                author = link.get('authorId')
                result = db.execute('SELECT id FROM works WHERE owner=? AND asset=?',
                                    (author if isinstance(author,str) else uid, link['assetId'])).fetchone()
                if result:
                    works.add(result['id'])
        if source:
            works.add(source['id'])
        if not works:
            return
        resources = image_resources(card)
        for work in works:
            flags = db.execute('SELECT state FROM works WHERE id=?',(work,)).fetchone()
            require(not flags or flags['state']!='blocked','来源作品已下架，资产包不可用',410)
            require(not any(row['resource'] in resources for row in db.execute(
                'SELECT DISTINCT resource FROM resource_restrictions WHERE work=?',(work,))),
                '素材受限，请先替换相关图片',409)

    @staticmethod
    def private_asset_author(db, user, card):
        face_origins = card.get('faceOrigins')
        origins = face_origins.values() if isinstance(face_origins, dict) and face_origins else [card.get('communityOrigin')]
        references = [origin for origin in origins if isinstance(origin, dict)]
        if not references:
            return dict(authorId=user['id'],author=user.get('displayName') or user['handle'])
        verified = {}
        for origin in references:
            work, edition = origin.get('workId'), origin.get('edition')
            if not isinstance(work,str) or type(edition) is not int:
                return dict(author='来源待确认')
            source = db.execute('''SELECT w.owner,COALESCE(e.published_author,u.display_name,u.handle) author
                                   FROM editions e JOIN works w ON w.id=e.work JOIN users u ON u.id=w.owner
                                   WHERE e.work=? AND e.edition=?''',(work,edition)).fetchone()
            if not source:
                return dict(author='来源待确认')
            verified[source['owner']] = source['author']
        if len(verified) == 1:
            author_id, name = next(iter(verified.items()))
            return dict(authorId=author_id,author=name)
        return dict(author='多位来源作者')

    def private_asset_faces(self, db, user, card):
        shared_faces = card.get('faceOrigins')
        owned_faces = card.get('assetFaceOrigins')
        if not isinstance(shared_faces, dict) and not isinstance(owned_faces, dict):
            return []
        faces = []
        for slot in ('front',) if card.get('singleSided') else ('front', 'back'):
            shared = shared_faces.get(slot) if isinstance(shared_faces, dict) else card.get('communityOrigin')
            owned = owned_faces.get(slot) if isinstance(owned_faces, dict) else card.get('assetOrigin')
            if isinstance(shared, dict) and type(shared.get('edition')) is int:
                author = self.private_asset_author(db, user, {'communityOrigin': shared})['author']
                version = shared['edition']
            elif isinstance(owned, dict) and type(owned.get('version')) is int:
                author = (user.get('displayName') or user['handle']) if owned.get('authorId') == user['id'] else '来源待确认'
                version = owned['version']
            else:
                continue
            face = 'back' if slot == 'back' or card.get('looseFace') == 'back' else 'front'
            faces.append(dict(face=face, author=author, version=version))
        return faces

    def download_asset(self, db, user, data):
        uid = user['id']
        if 'asset' in data:
            asset_id, version = field(data,'asset',128), number(data,'assetVersion')
            meta, snapshot = self.account_asset(uid,asset_id,version)
            self.check_private_download(db,uid,asset_id,snapshot['card'])
            snapshot['fonts'], _ = asset_font_files(snapshot)
            claims = dict(kind='owned',owner=uid,assetId=asset_id,assetVersion=version,projectId=meta['projectId'],
                          **self.private_asset_author(db,user,snapshot['card']))
            item = 'asset:' + asset_id
        else:
            work, version = field(data,'work',64), number(data,'edition')
            require(db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',(uid,work,version)).fetchone(),
                    '请先复制到自己的资产',403)
            row = self.release_record(db,work,version)
            replacements = self.restrictions(db,uid,work,version)
            require(all(replacements.values()),'素材受限，请先在我的资产替换相关图片',409)
            card = self.corrected_card(json.loads(row['card']),replacements)
            snapshot = dict(name=row['name'],card=card,fonts=[],replacements=replacements)
            if not replacements:
                for slot, target in (('front','cover'),('back','backCover')):
                    if row[slot]:
                        snapshot[target] = 'data:image/png;base64,' + base64.b64encode(row[slot]).decode('ascii')
            claims = dict(kind='received',owner=uid,work=work,edition=version,authorId=row['owner'],
                          author=row['published_author'] or row['current_author'],
                          assetVersion=row['asset_version'] or version,licenseVersion=row['license_version'])
            item = work
        archive = asset_packages.encode(asset_packages.signing_key(db),claims,snapshot)
        asset_packages.event(db,'download',uid,item,version)
        return asset_packages.AssetDownload(archive,f"{snapshot['name']}-v{version}")

    def import_asset(self, db, user, archive, inspect):
        uid = user['id']
        claims, snapshot = asset_packages.decode(asset_packages.signing_key(db),archive,uid)
        kind = claims['kind']
        card = snapshot['card']
        validate_card(card)
        if kind == 'owned':
            asset_id, version = claims['assetId'], claims['assetVersion']
            require(snapshot['assetId']==asset_id and snapshot['version']==version,'资产包版本不一致')
            self.check_private_download(db,uid,asset_id,card)
            if not inspect:
                with self.asset_workspace(uid).connection() as local:
                    card_asset_store.initialize(local)
                    local.execute('BEGIN IMMEDIATE')
                    card_asset_store.restore_version(local,claims['projectId'],snapshot)
            result = dict(kind=kind,assetId=asset_id,assetVersion=version)
        else:
            work, version = claims['work'], claims['edition']
            self.release_record(db,work,version)
            current = self.restrictions(db,uid,work,version)
            replacements = snapshot.get('replacements',{})
            disallowed = {row['resource'] for row in db.execute('SELECT DISTINCT resource FROM resource_restrictions WHERE work=?',(work,))}
            require(current.keys() <= replacements.keys() and all(digest(value.encode()) not in disallowed for value in replacements.values()),
                    '该文件含有受限素材，请在我的资产处理后重新下载',409)
            if not inspect:
                db.execute('INSERT OR IGNORE INTO holdings VALUES (?,?,?,?)',(uid,work,version,time.time_ns()//1_000_000))
                db.executemany('INSERT OR IGNORE INTO resource_replacements VALUES (?,?,?,?,?)',
                               [(uid,work,version,key,replacements[key]) for key in current])
            result = dict(kind=kind,work=work,edition=version)
        if inspect:
            _, font_warnings = asset_font_files(snapshot)
            result.update(name=snapshot['name'],author=claims['author'],edition=version,
                          widthMm=card['widthMm'],heightMm=card['heightMm'],singleSided=bool(card.get('singleSided')),
                          cover=snapshot.get('cover'),backCover=snapshot.get('backCover'),fontWarnings=font_warnings,
                          faceSources=self.private_asset_faces(db,user,card) if kind=='owned' else [])
        return result

    def verify_own_sources(self, uid, card):
        links = []
        if 'assetOrigin' in card:
            links.append(card.pop('assetOrigin'))
        if 'assetFaceOrigins' in card:
            faces = card.pop('assetFaceOrigins')
            require(isinstance(faces,dict) and faces.keys() <= {'front','back'},'卡面来源不完整')
            links.extend(faces.values())
        for link in links:
            require(isinstance(link,dict) and link.get('authorId') in (None,uid),
                    '作品包含他人资产，请仅保存为私有改版',403)
            _, source = self.account_asset(uid,field(link,'assetId',128),number(link,'version'))
            require(not source['card'].get('communityOrigin') and not source['card'].get('faceOrigins'),
                    '作品包含他人资产，请仅保存为私有改版',403)

    def publish_asset(self, db, user, data):
        uid = user['id']
        key, asset_version = field(data,'asset',128), number(data,'assetVersion')
        expected = data.get('expectedEdition')
        require(type(expected) is int and 0 <= expected < 2**31,'公开版本无效')
        _, snapshot = self.account_asset(uid,key,asset_version)
        card = snapshot['card']
        self.check_private_download(db,uid,key,card)
        self.verify_own_sources(uid,card)
        card['id'] = 'published-card'
        for side in ('front','back'):
            card[side].pop('canvasLocked',None)
        version_data = edition_data(dict(data,card=card,cover=snapshot['cover'],backCover=snapshot.get('backCover')))
        cover_face = data.get('coverFace','front')
        require(cover_face == 'front' or (cover_face == 'back' and version_data.back is not None),
                '所选封面对应的卡面不可用')
        existing = db.execute('SELECT * FROM works WHERE owner=? AND asset=?',(uid,key)).fetchone()
        require(not existing or existing['state']!='blocked','该作品已下架',403)
        wid = existing['id'] if existing else uuid.uuid4().hex
        candidate = image_resources(card)
        require(not any(row['resource'] in candidate for row in db.execute(
            'SELECT DISTINCT resource FROM resource_restrictions WHERE work=?',(wid,))),
            '发布版本仍包含已限制的图片，请替换后重试',409)
        current = existing['edition'] if existing else 0
        if existing and existing['state'] == 'withdrawn':
            require(expected == current and data.get('republish') is True, '作品已撤回，请重新确认后再发布',409)
        elif current:
            prior = db.execute('SELECT * FROM editions WHERE work=? AND edition=?',(wid,current)).fetchone()
            same = (prior['asset_version'] or current,prior['name'],prior['description'],prior['card'],prior['category'],prior['cover_face']) == (
                asset_version,version_data.name,version_data.description,version_data.card,version_data.category,cover_face)
            if same:
                return {'id':wid,'edition':current}
        require(expected==current,'作品已有新版，请重新查看',409)
        edition = current+1
        stamp = time.time_ns()//1_000_000
        if existing:
            db.execute("UPDATE works SET edition=?,state='public',changed=? WHERE id=?",(edition,stamp,wid))
        else:
            db.execute('INSERT INTO works VALUES (?,?,?,?,?,?)',(wid,uid,key,edition,'public',stamp))
        db.execute('''INSERT INTO editions (work,edition,name,description,width,height,single,card,front,back,
                      signature,category,asset_version,published_author,license_version,licensed_at,cover_face)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (wid,edition,*version_data,asset_version,
                      user.get('displayName') or user['handle'],asset_packages.LICENSE_VERSION,stamp,cover_face))
        db.execute('INSERT OR IGNORE INTO holdings VALUES (?,?,?,?)',(uid,wid,edition,stamp))
        asset_packages.event(db,'publish',uid,wid,edition)
        return {'id':wid,'edition':edition}

    def restrict_resource(self, work, edition, resource, reason):
        require(re.fullmatch(r'[0-9a-f]{64}', resource), '素材标识无效')
        with self.connection(True) as db:
            editions, source = [], None
            for row in db.execute('SELECT edition,card FROM editions WHERE work=? ORDER BY edition', (work,)):
                candidate = next((slot['src'] for slot, _ in resource_slots(json.loads(row['card']))
                                  if digest(slot['src'].encode()) == resource), None)
                if candidate:
                    editions.append(row['edition'])
                    source = candidate
            require(edition in editions, '找不到该版本的素材', 404)
            db.executemany('INSERT OR REPLACE INTO resource_restrictions VALUES (?,?,?,?)',
                           [(work, row, resource, reason) for row in editions])
            db.execute('DELETE FROM resource_replacements WHERE work=? AND source=?',(work,source))
        return editions

    def handle(self, parts, method, data, token, query, scope=None):
        action = parts[0] if parts else 'works'
        read = method == 'GET'
        # Decode a replacement before taking the writer lock.
        if not read and action == 'replace-resource':
            with self.connection() as db:
                publisher = self.user(db, token)
                require(publisher, '请先登录', 401)
                require(db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',
                                   (publisher['id'],field(data,'work',64),number(data,'edition'))).fetchone(),
                        '资产不存在', 404)
            replacement = replacement_image(data.get('source'))
        with self.connection(not read and action!='inspect-asset') as db:
            user = self.user(db, token)
            uid = user['id'] if user else None
            if action not in ('session','works','work','image','logout'):
                require(uid, '请先登录', 401)
                require(not scope or scope==uid,'工作区已切换，请重新打开资产',409)
            if read and action == 'session':
                return dict(user) if user else None
            if read and action in ('works','library') and len(parts) <= 1:
                if action == 'library':
                    require(uid, '请先登录', 401)
                    sql = BASE_SELECT + ' JOIN holdings h ON h.work=w.id AND h.edition=e.edition WHERE h.uid=? ORDER BY h.acquired DESC'
                    args = (uid,)
                else:
                    term = query.get('q',[''])[0][:120]
                    category = query.get('category', [''])[0]
                    require(not category or category in COMMUNITY_CATEGORIES, '社区分类无效')
                    sql = BASE_SELECT + """ WHERE w.state='public' AND e.edition=w.edition AND
                            NOT EXISTS (SELECT 1 FROM resource_restrictions r WHERE r.work=w.id AND r.edition=e.edition) AND
                            (instr(lower(e.name),lower(?))>0 OR instr(lower(COALESCE(u.display_name,u.handle)),lower(?))>0)"""
                    args = (term, term)
                    if category:
                        sql += ' AND e.category=?'
                        args += (category,)
                    sql += ' ORDER BY w.changed DESC'
                return [self.summary(db,r,uid) for r in db.execute(sql,args)]
            if read and len(parts) == 2 and action == 'work':
                row = db.execute(BASE_SELECT+' WHERE w.id=? AND e.edition=w.edition',(parts[1],)).fetchone()
                require(row,'作品不存在',404)
                require(row['state']=='public' or uid==row['owner'],'作品已撤回或下架',410)
                summary = self.summary(db,row,uid)
                require(not summary.get('resourcesRestricted') or summary['mine'] or summary['held'], '作品正在处理素材问题',410)
                return summary
            if read and len(parts) == 2 and action == 'publication':
                require(uid, '请先登录', 401)
                sql = BASE_SELECT+' WHERE w.owner=? AND w.asset=? AND e.edition=w.edition'
                if query.get('includeInactive') != ['1']:
                    sql += " AND w.state='public'"
                row = db.execute(sql, (uid, parts[1])).fetchone()
                return self.summary(db, row, uid) if row else None
            if read and len(parts)==3 and action in ('holding','resources'):
                require(uid,'请先登录',401)
                row = db.execute(BASE_SELECT + ''' JOIN holdings h ON h.work=w.id AND h.edition=e.edition
                                 WHERE h.uid=? AND h.work=? AND h.edition=?''',(uid,parts[1],parts[2])).fetchone()
                require(row,'资产不存在',404)
                if action == 'resources':
                    raw = db.execute('SELECT card FROM editions WHERE work=? AND edition=?',(parts[1],parts[2])).fetchone()[0]
                    restricted = {item['resource']: dict(item) for item in db.execute('''SELECT r.resource,r.reason,s.resource IS NOT NULL replaced
                        FROM resource_restrictions r LEFT JOIN resource_replacements s
                        ON s.uid=? AND s.work=r.work AND s.edition=r.edition AND s.resource=r.resource
                        WHERE r.work=? AND r.edition=?''',(uid,parts[1],parts[2]))}
                    return [{'id': key, 'labels': sorted(labels), 'reason': restricted.get(key,{}).get('reason'),
                             'replaced': bool(restricted.get(key,{}).get('replaced'))}
                            for key, labels in image_resources(json.loads(raw)).items()]
                return self.summary(db,row,uid)
            if read and len(parts) in (3,4) and action in ('image','card'):
                require(parts[2].isascii() and parts[2].isdigit() and len(parts[2])<=10, '版本无效')
                edition = int(parts[2])
                work = db.execute('SELECT state,edition,owner FROM works WHERE id=?',(parts[1],)).fetchone()
                held = uid and db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',(uid,parts[1],edition)).fetchone()
                restricted = self.restrictions(db,uid,parts[1],edition)
                if action == 'image' and len(parts)==4 and parts[3] in ('front','back'):
                    public = work and work['state']=='public' and work['edition']==edition
                    require(work and work['state']!='blocked' and (held or public) and not restricted,'预览不可用',404)
                    column = parts[3]
                else:
                    require(len(parts)==3 and action=='card' and held, '请先复制到自己的资产',403)
                    require(work and work['state']!='blocked','该作品已下架',410)
                    column = 'card'
                row = db.execute(f'SELECT {column} FROM editions WHERE work=? AND edition=?',(parts[1],edition)).fetchone()
                require(row and row[0],'内容不存在',404)
                if action == 'image':
                    return row[0]
                card = json.loads(row[0])
                return self.corrected_card(card,restricted) if restricted else card
            require(not read, '接口不存在',404)
            if action == 'logout':
                db.execute('DELETE FROM sessions WHERE digest=?',(digest(token.encode()),))
                return {}
            require(uid, '请先登录',401)
            if action == 'publish' and len(parts)==1:
                require(data.keys() <= {'asset','assetVersion','expectedEdition','name','description','category','grant','republish','coverFace'},
                        '请从账号资产选择已保存的版本后发布')
                return self.publish_asset(db,user,data)
            if action == 'download' and len(parts)==1:
                return self.download_asset(db,user,data)
            if action in ('inspect-asset','import-asset') and len(parts)==1:
                return self.import_asset(db,user,data,inspect=action=='inspect-asset')
            wid = field(data,'work',64)
            work = db.execute('SELECT * FROM works WHERE id=?',(wid,)).fetchone()
            require(work, '作品不存在',404)
            edition = number(data,'edition')
            blocked_resource = db.execute('SELECT 1 FROM resource_restrictions WHERE work=? AND edition=?',(wid,edition)).fetchone()
            if action == 'remove':
                require(work['owner'] != uid or work['state']!='public' or work['edition']!=edition, '请先撤回当前公开版本',409)
                db.execute('DELETE FROM holdings WHERE uid=? AND work=? AND edition=?',(uid,wid,edition))
                db.execute('DELETE FROM resource_replacements WHERE uid=? AND work=? AND edition=?',(uid,wid,edition))
            elif action in ('withdraw','withdraw-remove'):
                require(work['owner']==uid,'只有作者可撤回',403)
                require(work['edition']==edition and work['state']!='blocked','状态已变化，请刷新',409)
                db.execute("UPDATE works SET state='withdrawn' WHERE id=?",(wid,))
                if action == 'withdraw-remove':
                    db.execute('DELETE FROM holdings WHERE uid=? AND work=?',(uid,wid))
                    db.execute('DELETE FROM resource_replacements WHERE uid=? AND work=?',(uid,wid))
            elif action == 'copy':
                held = db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',(uid,wid,edition)).fetchone()
                if held:
                    return {'id':wid,'edition':edition}
                require(work['state']=='public' and work['edition']==edition and not blocked_resource,
                        '作品已撤回、素材受限或版本已变化，请重新查看',409)
                db.execute('INSERT OR IGNORE INTO holdings VALUES (?,?,?,?)',(uid,wid,edition,time.time_ns()//1_000_000))
                asset_packages.event(db,'copy',uid,wid,edition)
                return {'id':wid,'edition':edition}
            elif action == 'report':
                reason = field(data,'reason',600)
                resource = data.get('resource')
                if resource:
                    held = db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',(uid,wid,edition)).fetchone()
                    require(held, '请从已领取的版本举报具体素材', 403)
                    raw = db.execute('SELECT card FROM editions WHERE work=? AND edition=?',(wid,edition)).fetchone()[0]
                    require(isinstance(resource,str) and resource in image_resources(json.loads(raw)), '找不到该版本的素材', 404)
                    db.execute('INSERT OR REPLACE INTO resource_reports VALUES (?,?,?,?,?,?)',
                               (uid,wid,edition,resource,reason,int(time.time())))
                else:
                    require(work['state']=='public' and work['edition']==edition,'作品状态已变化',409)
                    db.execute('INSERT OR REPLACE INTO reports VALUES (?,?,?,?,?)',(uid,wid,edition,reason,int(time.time())))
            elif action == 'replace-resource':
                resource = field(data,'resource',64)
                require(db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',(uid,wid,edition)).fetchone(),
                        '资产不存在', 404)
                require(db.execute('SELECT 1 FROM resource_restrictions WHERE work=? AND edition=? AND resource=?',
                                   (wid,edition,resource)).fetchone(), '此素材无需替换', 404)
                require(not db.execute('SELECT 1 FROM resource_restrictions WHERE work=? AND resource=?',
                                       (wid,digest(replacement.encode()))).fetchone(), '请选择未受限制的图片')
                db.execute('INSERT OR REPLACE INTO resource_replacements VALUES (?,?,?,?,?)',(uid,wid,edition,resource,replacement))
            else:
                raise ProjectError('接口不存在',404)
            return {}


def session_token(headers):
    cookies = SimpleCookie()
    cookies.load(headers.get('Cookie',''))
    return cookies[COOKIE].value if COOKIE in cookies else ''


def serve_community(handler):
    from urllib.parse import parse_qs
    url = urlsplit(handler.path)
    parts = [s for s in url.path.removeprefix('/api/community').split('/') if s]
    auth_action = parts[0] if len(parts)==1 and parts[0] in AUTH_ACTIONS else None
    asset_upload = parts in (['inspect-asset'],['import-asset'])
    try:
        token = session_token(handler.headers)
        body = {}
        cookie = None
        if handler.command=='POST':
            origin = handler.headers.get('Origin')
            require(not origin or urlsplit(origin).netloc == handler.headers.get('Host'),
                    '请从当前工作台提交',403)
            size = int(handler.headers.get('Content-Length') or 0)
            handler.connection.settimeout(30)
            if asset_upload:
                require(handler.headers.get_content_type()=='application/octet-stream','请选择 Prism 资产包')
                require(0 < size <= asset_packages.MAX_PACKAGE_BYTES,'资产包无效或超过容量上限',413)
                with handler.server.community.connection() as db:
                    require(handler.server.community.user(db,token),'请先登录',401)
                body = handler.rfile.read(size)
                require(len(body)==size,'资产包上传不完整，请重新选择')
            else:
                require(handler.headers.get_content_type()=='application/json','请使用 JSON')
                if auth_action:
                    require(0 < size <= 8192,'账号请求过大',413)
                else:
                    require(0 < size <= MAX_BODY,'卡牌超过社区传输上限',413)
                body = json.loads(handler.rfile.read(size))
                require(isinstance(body,dict),'请求格式无效')
        if handler.command=='POST' and auth_action:
            result, session = handler.server.community.accounts.handle(auth_action,body,handler.client_address[0],token)
            if session:
                cookie = f'{COOKIE}={session}; Path=/api; Max-Age={SESSION_AGE}; HttpOnly; SameSite=Strict'
            elif auth_action=='change-password':
                cookie = f'{COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Strict'
        else:
            result = handler.server.community.handle(parts,handler.command,body,token,parse_qs(url.query),
                                                     handler.headers.get('X-Prism-Workspace'))
            if parts==['logout']:
                cookie = f'{COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Strict'
        if cookie:
            if getattr(handler.server, 'public_origin', None) or handler.headers.get('Origin','').startswith('https://'):
                cookie += '; Secure'
            handler.send_response(200)
            handler.send_header('Set-Cookie',cookie)
            raw = json.dumps(result,ensure_ascii=False).encode()
            handler.send_header('Content-Type','application/json; charset=utf-8')
            handler.send_header('Content-Length',str(len(raw)))
            handler.send_header('Cache-Control','no-store')
            handler.end_headers()
            handler.wfile.write(raw)
        elif isinstance(result,asset_packages.AssetDownload):
            handler.respond(200,result.body,'application/zip',result.disposition)
        elif isinstance(result,bytes):
            handler.respond(200,result,'image/png')
        else:
            handler.respond(200,json.dumps(result,ensure_ascii=False).encode())
    except (ValueError, TypeError, AttributeError, KeyError, RecursionError, TimeoutError) as error:
        msg = str(error) if isinstance(error,ProjectError) else '社区数据无效，请刷新重试'
        handler.respond(getattr(error,'status',400),json.dumps({'error':msg},ensure_ascii=False).encode())
    except sqlite3.Error:
        handler.respond(503,json.dumps({'error':'账号存储暂时不可用，请重试'},ensure_ascii=False).encode())


def moderate():
    import argparse
    from pathlib import Path
    parser = argparse.ArgumentParser(description='查看社区举报、核对素材，或处理已核实的权利投诉')
    parser.add_argument('--data-dir', type=Path, default=Path.home() / 'Library' / 'Application Support' / 'Prism')
    parser.add_argument('operation', choices=('reports','block','resources','restrict'))
    parser.add_argument('work', nargs='?')
    parser.add_argument('--edition', type=int)
    parser.add_argument('--resource')
    parser.add_argument('--reason')
    args = parser.parse_args()
    path = args.data_dir.expanduser() / 'community.sqlite3'
    if not path.is_file():
        parser.error('此工作区没有社区数据库')
    store = CommunityStore(path)
    if args.operation in ('resources','restrict') and not (args.work and args.edition and args.edition > 0):
        parser.error('请提供作品 ID 和 --edition 版本号')
    if args.operation == 'restrict':
        if not args.resource or not args.reason or not 0 < len(args.reason.strip()) <= 600:
            parser.error('请提供 --resource 素材标识 和 --reason 通知内容（最多 600 字）')
        try:
            affected = store.restrict_resource(args.work, args.edition, args.resource, args.reason.strip())
        except ProjectError as error:
            parser.error(str(error))
        print(json.dumps({'restrictedEditions':affected},ensure_ascii=False))
        return
    with store.connection(args.operation=='block') as db:
        if args.operation=='reports':
            for row in db.execute('''SELECT work,edition,NULL resource,reason,created FROM reports
                                     UNION ALL SELECT work,edition,resource,reason,created FROM resource_reports
                                     ORDER BY created DESC'''):
                print(json.dumps(dict(row), ensure_ascii=False))
        elif args.operation == 'resources':
            row = db.execute('SELECT card FROM editions WHERE work=? AND edition=?',(args.work,args.edition)).fetchone()
            if not row:
                parser.error('版本不存在')
            for resource, labels in image_resources(json.loads(row['card'])).items():
                print(json.dumps({'resource':resource,'layers':sorted(labels)},ensure_ascii=False))
        else:
            cursor=db.execute("UPDATE works SET state='blocked' WHERE id=?", (args.work,))
            if not cursor.rowcount:
                parser.error('作品不存在')
            print('作品已下架')


if __name__=='__main__':
    moderate()
