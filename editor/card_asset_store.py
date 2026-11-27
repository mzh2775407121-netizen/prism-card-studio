"""Private, immutable single-card revisions in the existing workspace database."""
import json
import re
import sqlite3
import time
from contextlib import nullcontext
from urllib.parse import parse_qs, urlsplit

from project_store import ProjectError, PROJECT_ID, validate_card, valid_text

def initialize(db):
    db.execute('CREATE TABLE IF NOT EXISTS card_assets (id TEXT PRIMARY KEY, summary TEXT NOT NULL)')
    db.execute('''CREATE TABLE IF NOT EXISTS card_asset_versions (
        asset TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(asset,version))''')


def version_record(db, asset_id, version):
    row = db.execute('''SELECT a.summary,v.content FROM card_assets a JOIN card_asset_versions v
                       ON v.asset=a.id WHERE v.asset=? AND v.version=?''', (asset_id,version)).fetchone()
    if not row:
        raise ProjectError('找不到这个资产版本',404)
    return tuple(json.loads(value) for value in row)


def restore_version(db, project_id, snapshot):
    """Recreate only the exact revision delivered in a verified account archive."""
    asset_id, version, card = snapshot['assetId'], snapshot['version'], snapshot['card']
    validate_card(card)
    row = db.execute('SELECT summary FROM card_assets WHERE id=?', (asset_id,)).fetchone()
    old = json.loads(row[0]) if row else None
    if old and (old['projectId'] != project_id or old['cardId'] != card['id']):
        raise ProjectError('账号中已有同标识的其他资产，请重新下载有效版本',409)
    same = db.execute('SELECT content FROM card_asset_versions WHERE asset=? AND version=?', (asset_id,version)).fetchone()
    if same:
        if json.loads(same[0]) != snapshot:
            raise ProjectError('账号中已有同编号的不同资产版本',409)
        return
    db.execute('INSERT INTO card_asset_versions VALUES (?,?,?)', (asset_id,version,json.dumps(snapshot,ensure_ascii=False)))
    versions = [row[0] for row in db.execute('SELECT version FROM card_asset_versions WHERE asset=? ORDER BY version',(asset_id,))]
    if old and old['version'] > version:
        meta = dict(old, versions=versions)
    else:
        meta = dict(id=asset_id,name=snapshot['name'],version=version,versions=versions,cover=snapshot['cover'],
                    digest=snapshot['digest'],projectId=project_id,cardId=card['id'],updatedAt=int(time.time()*1000),
                    widthMm=card['widthMm'],heightMm=card['heightMm'],singleSided=bool(card.get('singleSided')),
                    origin=card.get('communityOrigin'))
        if snapshot.get('backCover'):
            meta['backCover'] = snapshot['backCover']
    db.execute('INSERT OR REPLACE INTO card_assets VALUES (?,?)',(asset_id,json.dumps(meta,ensure_ascii=False)))

def perform(db, method, path, body, include_back_covers=False):
    initialize(db)
    parts = path.split('/')[3:]
    if method == 'GET' and not parts:
        if include_back_covers:
            rows = db.execute("""SELECT a.summary,
                CASE WHEN json_extract(a.summary,'$.backCover') IS NULL
                     AND NOT COALESCE(json_extract(a.summary,'$.singleSided'), 0)
                THEN (SELECT json_extract(v.content,'$.backCover')
                      FROM card_asset_versions v WHERE v.asset=a.id
                      AND v.version=json_extract(a.summary,'$.version')) END
                FROM card_assets a ORDER BY a.rowid DESC""")
            return [dict(json.loads(summary), backCover=back) if isinstance(back,str) and back.startswith('data:image/')
                    else json.loads(summary) for summary,back in rows]
        return [json.loads(row[0]) for row in db.execute('SELECT summary FROM card_assets ORDER BY rowid DESC')]
    if not parts or not PROJECT_ID.fullmatch(parts[0]) or len(parts) > 2:
        raise ProjectError('资产地址无效',404)
    asset_id = parts[0]
    row = db.execute('SELECT summary FROM card_assets WHERE id=?',(asset_id,)).fetchone()
    meta = json.loads(row[0]) if row else None
    if method == 'GET' and len(parts) == 2 and parts[1].isdigit():
        return version_record(db,asset_id,int(parts[1]))[1]
    if method != 'POST' or len(parts) != 2 or not isinstance(body,dict):
        raise ProjectError('资产操作无效',404)
    action = parts[1]
    if action in ('save','adopt'):
        adopt = action == 'adopt'
        item, expected = body.get('snapshot'), body.get('expected')
        source, card_id, name = body.get('projectId'), body.get('cardId'), body.get('name')
        requested = body.get('version') if adopt else None
        if adopt:
            if type(requested) is not int or not 0 < requested < 2**31:
                raise ProjectError('资产版本无效')
            source = meta['projectId'] if meta else 'asset-'+asset_id
            expected = 0
        if (not isinstance(item,dict) or not valid_text(name,500) or not valid_text(source,302)
            or not valid_text(card_id,302) or type(expected) is not int or expected < 0 or
            not re.fullmatch(r'[0-9a-f]{64}',str(item.get('digest',''))) or not str(item.get('cover','')).startswith('data:image/')):
            raise ProjectError('卡牌资产数据无效')
        card = item.get('card')
        validate_card(card)
        if card['id'] != card_id or (meta and (meta['projectId'] != source or meta['cardId'] != card_id)):
            raise ProjectError('资产来源不匹配',409)
        version = meta['version'] if meta else 0
        if adopt:
            existing = db.execute("SELECT json_extract(content,'$.digest') FROM card_asset_versions WHERE asset=? AND version=?",
                                  (asset_id,requested)).fetchone()
            if existing:
                if existing[0] != item['digest']:
                    raise ProjectError('账号资产已有同编号的不同版本，请从账号资产发布。',409)
                return meta
            if requested < version:
                restore_version(db,source,dict(item,assetId=asset_id,version=requested,name=name.strip()))
                return dict(meta,versions=sorted([*(meta.get('versions') or range(1,version+1)),requested]))
            next_version = requested
        else:
            if meta and meta['digest'] == item['digest']:
                return meta
            if expected != version:
                raise ProjectError('此资产已有更新，请重新打开后重试。',409)
            next_version = version + 1
        versions = meta.get('versions') if meta else None
        if versions is not None or next_version != version + 1:
            versions = (versions if versions is not None else list(range(1,version+1)))+[next_version]
        version = next_version
        meta = dict(id=asset_id,name=name.strip(),version=version,cover=item['cover'],digest=item['digest'],
                    projectId=source,cardId=card_id,updatedAt=int(time.time()*1000),widthMm=card['widthMm'],
                    heightMm=card['heightMm'],singleSided=bool(card.get('singleSided')),origin=card.get('communityOrigin'))
        if versions is not None:
            meta['versions'] = versions
        back_cover = item.get('backCover')
        if not meta['singleSided'] and isinstance(back_cover,str) and back_cover.startswith('data:image/'):
            meta['backCover'] = back_cover
        record = dict(item,assetId=asset_id,version=version,name=meta['name'])
        db.execute('INSERT INTO card_asset_versions VALUES (?,?,?)',(asset_id,version,json.dumps(record,ensure_ascii=False)))
    elif action in ('rename','remove'):
        if not meta:
            raise ProjectError('找不到这份资产',404)
        if body.get('expected') != meta['version']:
            raise ProjectError('此资产已有更新，请刷新后重试。',409)
        if action == 'remove':
            db.execute('DELETE FROM card_asset_versions WHERE asset=?',(asset_id,))
            db.execute('DELETE FROM card_assets WHERE id=?',(asset_id,))
            return {}
        if not valid_text(body.get('name'),500):
            raise ProjectError('请填写资产名称')
        meta['name'] = body['name'].strip()
        meta['updatedAt'] = int(time.time()*1000)
    else:
        raise ProjectError('资产操作无效',404)
    db.execute('INSERT OR REPLACE INTO card_assets VALUES (?,?)',(asset_id,json.dumps(meta,ensure_ascii=False)))
    return meta

def handle_card_assets(handler, path, max_bytes):
    try:
        workspace = handler.project_workspace()
        body = None
        query = parse_qs(urlsplit(handler.path).query)
        if query.get('scope') == ['local'] or query.get('workspace') == ['local'] or path.endswith('/adopt-local'):
            raise ProjectError('旧本机库仅支持由主机迁入账号',404)
        if handler.command == 'POST':
            length = int(handler.headers.get('Content-Length','0'))
            if not 0 < length <= max_bytes or handler.headers.get_content_type() != 'application/json':
                raise ProjectError('资产数据格式无效或超过容量上限',413)
            body = json.loads(handler.rfile.read(length))
        user = getattr(handler,'workspace_user',None)
        community = getattr(handler.server,'community',None)
        removing = community and user and handler.command == 'POST' and path.endswith('/remove')
        # Lock the publication records before the account store, in the same order as publish.
        with (community.connection(True) if removing else nullcontext()) as releases:
            if removing:
                active = releases.execute("SELECT 1 FROM works WHERE owner=? AND asset=? AND state='public'",
                                          (user['id'],path.split('/')[-2])).fetchone()
                if active:
                    raise ProjectError('请先撤回当前公开版本，再移除资产',409)
            with workspace.connection() as db:
                if handler.command == 'POST':
                    db.execute('BEGIN IMMEDIATE')
                include_back_covers = query.get('backCovers') == ['1']
                result = perform(db,handler.command,path,body,include_back_covers)
        if user and isinstance(result,dict) and handler.command=='GET' and 'assetId' in result:
            result = dict(result,authorId=user['id'],author=user.get('displayName') or user['handle'])
        status = 200
    except ProjectError as error:
        status,result = error.status,{'error':str(error)}
    except (ValueError,UnicodeDecodeError,TypeError,OverflowError):
        status,result = 400,{'error':'资产数据格式无效'}
    except (sqlite3.Error,OSError):
        status,result = 503,{'error':'无法读写本机资产，请重试'}
    handler.respond(status,json.dumps(result,ensure_ascii=False).encode())
