"""Regression cases for offline retries, release races and account-owned editions."""
import base64
import copy
import io
import json
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from card_asset_store import perform as card_assets
from community_store import CommunityStore, REMOVED_IMAGE, digest
from asset_packages import AssetDownload
from project_store import ProjectError


class EditionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = CommunityStore(Path(temp.name) / 'community.db')
        self.a, self.b, self.c = [self.store.auth('register', {'handle': n, 'password': 'local-test-password'}, n)[1]
                                  for n in ('author','reader','visitor')]
        out = io.BytesIO()
        Image.new('RGB',(8,10),'#563941').save(out,'PNG')
        preview = 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode()
        side = {'nodes':[],'regions':[],'effects':[]}
        self.card = {'id':'published-card','name':'林地 02','widthMm':63,'heightMm':88,'bleedMm':3,
                     'material':'white','front':side,'back':copy.deepcopy(side)}
        self.package = {'asset':'local-card','edition':1,'name':'林地 02','card':self.card,'description':'',
                        'cover':preview,'backCover':preview,'grant':True}
        self.wid = self.post('publish',self.a,self.package)['id']

    def post(self, route, actor, payload):
        if route == 'publish' and 'card' in payload:
            payload = self.save_release_asset(actor,payload)
        return self.store.handle([route],'POST',payload,actor,{})

    def save_release_asset(self, actor, payload):
        with self.store.connection() as db:
            uid = self.store.user(db,actor)['id']
        asset = payload['asset']
        version = payload.get('assetVersion',payload['edition'])
        card = payload['card']
        snapshot = {key: payload[key] for key in ('card','cover','backCover') if key in payload}
        snapshot['digest'] = digest(json.dumps(card,sort_keys=True).encode())
        with self.store.asset_workspace(uid).connection() as db:
            card_assets(db,'POST',f'/api/card-assets/{asset}/adopt',
                {'version':version,'name':card['name'],'cardId':card['id'],'snapshot':snapshot})
        return {key: payload[key] for key in ('name','description','asset','category','grant','republish') if key in payload} | {
            'assetVersion':version,'expectedEdition':payload.get('expectedEdition',payload['edition']-1),
        }

    def get(self, route, actor='', **query):
        return self.store.handle(route.split('/'),'GET',{},actor,{key: [value] for key, value in query.items()})

    def test_release_isolation(self):
        original = {'work':self.wid,'edition':1}
        self.post('copy',self.b,original)
        new = copy.deepcopy(self.package)
        new.update(edition=2,name='林地 03')
        new['card']['name']='林地 03'
        self.assertEqual(self.post('publish',self.a,new)['id'],self.wid)
        self.assertEqual(self.get('work/'+self.wid)['edition'],2)
        self.assertNotIn('ownedAsset',self.get('work/'+self.wid))
        self.assertEqual(self.get('card/'+self.wid+'/1',self.b)['name'],'林地 02')
        self.post('copy',self.b,{**original,'edition':2})
        self.post('copy',self.b,{**original,'edition':2})
        self.assertEqual(len(self.get('library',self.b)),2)
        self.assertEqual(self.get('library',self.c),[])
        for actor in ('',self.c):
            with self.assertRaises(ProjectError):
                self.get('card/'+self.wid+'/1',actor)

    def test_categories_filter_latest_releases_and_preserve_holdings(self):
        self.post('copy',self.b,{'work':self.wid,'edition':1})
        process_release = {**self.package, 'edition':2, 'category':'process'}
        self.assertEqual(self.post('publish',self.a,process_release),{'id':self.wid,'edition':2})
        self.assertEqual(self.post('publish',self.a,process_release),{'id':self.wid,'edition':2})
        with self.assertRaises(ProjectError) as error:
            self.post('publish',self.a,{**process_release,'category':'other'})
        self.assertEqual(error.exception.status,409)

        self.assertEqual(self.get('works',category='process',q='林地')[0]['id'],self.wid)
        self.assertEqual(self.get('works',category='process',q='AUTHOR')[0]['id'],self.wid)
        self.assertEqual(self.get('works',category='process',q='无匹配'),[])
        for category in ('card','set','component','other'):
            self.assertEqual(self.get('works',category=category),[])
        with self.assertRaises(ProjectError):
            self.get('works',category='unsupported')

        self.assertEqual(self.get('work/'+self.wid)['category'],'process')
        self.assertEqual(self.get(f'holding/{self.wid}/1',self.b)['category'],'card')
        self.assertEqual(self.get(f'card/{self.wid}/1',self.b),self.card)
        for category in ('set','component','unsupported'):
            with self.assertRaises(ProjectError):
                self.post('publish',self.a,{**self.package,'asset':'another-card','category':category})

    def test_category_migration_retains_legacy_release_and_persists_after_restart(self):
        with self.store.connection(True) as db:
            db.execute('ALTER TABLE editions RENAME TO editions_with_category')
            db.execute('''CREATE TABLE editions (
                work TEXT NOT NULL, edition INTEGER NOT NULL, name TEXT NOT NULL, description TEXT,
                width REAL, height REAL, single INTEGER, card TEXT, front BLOB, back BLOB,
                signature TEXT NOT NULL, PRIMARY KEY(work,edition))''')
            db.execute('''INSERT INTO editions SELECT work,edition,name,description,width,height,single,card,front,back,
                          'legacy-signature' FROM editions_with_category''')
            db.execute('DROP TABLE editions_with_category')

        self.store = CommunityStore(self.store.path)
        self.assertEqual(self.get('works',category='card')[0]['category'],'card')
        self.assertEqual(self.post('publish',self.a,self.package)['id'],self.wid)
        self.post('publish',self.a,{**self.package,'edition':2,'category':'other'})

        self.store = CommunityStore(self.store.path)
        self.assertEqual(self.get('works',category='other')[0]['id'],self.wid)
        self.assertEqual(self.get(f'holding/{self.wid}/1',self.a)['category'],'card')

    def test_withdraw_and_retry(self):
        at = {'work':self.wid,'edition':1}
        self.post('copy',self.b,at)
        with self.assertRaises(ProjectError):
            self.post('withdraw',self.b,at)
        self.post('withdraw',self.a,at)
        self.assertEqual(self.get('works'),[])
        self.post('copy',self.b,at)  # A late acknowledgement of the already completed copy.
        self.assertEqual(len(self.get('library',self.b)),1)
        with self.assertRaises(ProjectError):
            self.post('copy',self.c,at)
        with self.assertRaises(ProjectError):
            self.post('publish',self.a,self.package)
        self.post('remove',self.b,at)
        self.assertEqual(self.get('library',self.b),[])

    def test_withdraw_and_remove_is_one_author_transaction(self):
        at = {'work':self.wid,'edition':1}
        self.post('copy',self.b,at)
        with self.assertRaises(ProjectError):
            self.post('withdraw-remove',self.b,at)
        with self.assertRaises(ProjectError):
            self.post('withdraw-remove',self.a,{**at,'edition':2})
        self.assertEqual(self.get('works')[0]['id'],self.wid)
        self.assertEqual(self.get('publication/local-card',self.a)['edition'],1)
        for _ in range(2):
            self.post('withdraw-remove',self.a,at)
        self.assertEqual(self.get('library',self.a),[])
        self.assertEqual(self.get('library',self.b)[0]['id'],self.wid)
        self.assertIsNone(self.get('publication/local-card',self.a))
        self.assertEqual(self.get('works'),[])
        self.assertEqual(self.get('card/'+self.wid+'/1',self.b),self.card)
        with self.assertRaises(ProjectError):
            self.post('copy',self.c,at)

    def test_restrict_and_replace_a_resource_for_affected_holders_only(self):
        def image(color):
            out = io.BytesIO()
            Image.new('RGB',(8,10),color).save(out,'PNG')
            return 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode()

        source, second, replacement = image('#436688'), image('#eeeeee'), image('#ab4949')
        card = copy.deepcopy(self.card)
        card['front']['nodes'] = [{'id':'art','name':'山景','type':'image','src':source},
                                  {'id':'frame','name':'框','type':'rect','imageFill':{'src':second}}]
        card['back']['nodes'] = [{'id':'reuse','name':'共用山景','type':'image','src':source}]
        self.post('publish',self.a,{**self.package,'edition':2,'card':card})
        at = {'work':self.wid,'edition':2}
        self.post('copy',self.b,at)
        self.post('publish',self.a,{**self.package,'edition':3,'card':card})
        resource = digest(source.encode())
        path = self.wid+'/2'
        self.assertEqual(self.get('resources/'+path,self.b)[0]['labels'],['正面 · 山景','背面 · 共用山景'])
        with self.assertRaises(ProjectError):
            self.get('resources/'+path)
        self.post('report',self.b,{**at,'resource':resource,'reason':'待确认图像授权'})
        self.assertEqual(self.store.restrict_resource(self.wid,2,resource,'请替换插画'),[2,3])
        self.assertEqual(self.get('works'),[])
        self.assertEqual(self.get('holding/'+path,self.b)['resourcesPending'],1)
        self.assertEqual(self.get('resources/'+path,self.b)[0]['reason'],'请替换插画')
        with self.assertRaises(ProjectError):
            self.get('image/'+path+'/front',self.b)
        with self.assertRaises(ProjectError):
            self.post('copy',self.c,{**at,'edition':3})
        with self.assertRaises(ProjectError):
            self.post('publish',self.a,{**self.package,'edition':4,'card':card})
        received = self.get('card/'+path,self.b)
        self.assertEqual(received['front']['nodes'][0]['src'],REMOVED_IMAGE)
        self.assertEqual(received['front']['nodes'][1]['imageFill']['src'],second)
        self.assertEqual(received['back']['nodes'][0]['src'],REMOVED_IMAGE)
        for actor, invalid in ((self.c,replacement),(self.b,source),(self.b,'data:image/png;base64,SGVsbG8=')):
            with self.assertRaises(ProjectError):
                self.post('replace-resource',actor,{**at,'resource':resource,'source':invalid})
        self.post('replace-resource',self.b,{**at,'resource':resource,'source':replacement})
        self.assertEqual(self.get('holding/'+path,self.b)['resourcesPending'],0)
        self.assertEqual(self.get('card/'+path,self.b)['front']['nodes'][0]['src'],replacement)
        self.assertEqual(self.get('card/'+path,self.a)['front']['nodes'][0]['src'],REMOVED_IMAGE)
        with Image.open(io.BytesIO(base64.b64decode(REMOVED_IMAGE.split(',')[1]))) as placeholder:
            self.assertEqual(placeholder.getpixel((0,0)),(0,0,0,0))

    def test_account_adoption_preserves_exact_edition_and_future_edits(self):
        with sqlite3.connect(':memory:') as db:
            body = {'version':4,'name':self.card['name'],'cardId':self.card['id'],
                    'snapshot':{'card':self.card,'cover':self.package['cover'],'digest':'a'*64}}
            route = '/api/card-assets/local-card/'
            meta = card_assets(db,'POST',route+'adopt',body)
            self.assertEqual(meta['version'],4)
            self.assertEqual(meta['versions'],[4])
            self.assertEqual(meta,card_assets(db,'POST',route+'adopt',body))
            self.assertEqual(card_assets(db,'GET',route+'4',None)['card'],self.card)
            change = {**body,'expected':4,'projectId':meta['projectId'],
                      'snapshot':{**body['snapshot'],'digest':'b'*64}}
            updated = card_assets(db,'POST',route+'save',change)
            self.assertEqual(updated['versions'],[4,5])
            self.assertEqual(card_assets(db,'POST',route+'adopt',body),updated)
            with self.assertRaises(ProjectError):
                card_assets(db,'POST',route+'adopt',change)

    def test_rich_text_round_trip_through_community_package(self):
        card = copy.deepcopy(self.card)
        node = {'id':'text','name':'招式','type':'text','text':'火🔥◆ 50','textStyles':[
            {'start':0,'end':1,'bold':True},{'start':3,'end':4,'symbol':True,'color':'#2288bb'}]}
        card['front']['nodes'] = [node]
        self.post('publish',self.a,{**self.package,'edition':2,'card':card})
        self.post('copy',self.b,{'work':self.wid,'edition':2})
        self.assertEqual(self.get('card/'+self.wid+'/2',self.b)['front']['nodes'][0],node)
        node['textStyles'][1]['start']=2
        with self.assertRaises(ProjectError):
            self.post('publish',self.a,{**self.package,'edition':3,'card':card})

    def test_scoping_and_forbidden_payloads(self):
        for changes in ({'note':'private order'},{'communityOrigin':{'author':'other'}},
                        {'production':{'steps':[],'stockCode':'internal'}},
                        {'front':{**self.card['front'],'reference':{'src':'private'}}}):
            bad={**self.package,'asset':'unpublished','card':{**self.card,**changes}}
            with self.assertRaises(ProjectError):
                self.post('publish',self.a,bad)
        self.assertEqual(len(self.get('works')),1)
        self.post('report',self.b,{'work':self.wid,'edition':1,'reason':'需要核对素材授权'})
        with self.store.connection(True) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM reports').fetchone()[0],1)
            db.execute("UPDATE works SET state='blocked' WHERE id=?",(self.wid,))
        with self.assertRaises(ProjectError):
            self.post('copy',self.c,{'work':self.wid,'edition':1})
        with self.assertRaises(ProjectError):
            self.post('publish',self.a,{**self.package,'edition':2})

    def test_publish_resolves_private_version_and_mints_independent_public_edition(self):
        existing = {'asset':'local-card','assetVersion':1,'expectedEdition':1,'name':'公开标题修改', 'grant':True}
        with self.assertRaises(ProjectError) as denied:
            self.post('publish',self.b,existing)
        self.assertEqual(denied.exception.status,404)
        with self.assertRaises(ProjectError):
            self.store.handle(['publish'],'POST',{**existing,'card':{}},self.a,{})
        self.assertEqual(self.post('publish',self.a,existing),{'id':self.wid,'edition':2})
        self.assertEqual(self.post('publish',self.a,existing),{'id':self.wid,'edition':2})
        work = self.get('work/'+self.wid)
        self.assertEqual((work['edition'],work['assetVersion'],work['publishedAuthor']),(2,1,'author'))
        self.assertEqual(work['license']['scope'],'personal-edit-private')
        with self.assertRaises(ProjectError) as stale:
            self.post('publish',self.a,{**existing,'name':'旧页另行提交'})
        self.assertEqual(stale.exception.status,409)
        details = self.get('publication/local-card', self.a, includeInactive='1')
        self.assertEqual((details['state'], details['edition']), ('public', 2))

    def test_owned_face_provenance_checks_each_version_and_stays_out_of_public_snapshot(self):
        with self.store.connection() as db:
            author = self.store.user(db,self.a)['id']
        card = copy.deepcopy(self.card)
        card['assetFaceOrigins'] = {
            'front':{'assetId':'local-card','version':1,'authorId':author},
            'back':{'assetId':'unavailable','version':1,'authorId':author},
        }
        payload = {**self.package,'asset':'composed','card':card}
        with self.assertRaises(ProjectError) as invalid:
            self.post('publish',self.a,payload)
        self.assertEqual(invalid.exception.status,404)
        card['assetFaceOrigins']['back']['assetId'] = 'local-card'
        work = self.post('publish',self.a,{**payload,'assetVersion':2,'expectedEdition':0})['id']
        self.post('copy',self.b,{'work':work,'edition':1})
        self.assertNotIn('assetFaceOrigins',self.get(f'card/{work}/1',self.b))

    def test_signed_package_binds_account_and_restores_received_version_after_removal(self):
        at = {'work':self.wid,'edition':1}
        with self.assertRaises(ProjectError):
            self.post('download',self.b,at)
        self.assertEqual(self.post('copy',self.b,at),{'id':self.wid,'edition':1})
        self.assertEqual(self.post('copy',self.b,at),{'id':self.wid,'edition':1})
        download = self.post('download',self.b,at)
        self.assertIsInstance(download,AssetDownload)
        self.assertIn('.prismasset',download.disposition)
        self.assertEqual(self.post('inspect-asset',self.b,download.body)['name'],self.card['name'])
        with self.assertRaises(ProjectError) as invalid:
            self.post('import-asset',self.c,download.body)
        self.assertEqual(invalid.exception.status,403)
        self.post('remove',self.b,at)
        self.post('withdraw',self.a,at)
        self.assertEqual(self.get('library',self.b),[])
        self.post('inspect-asset',self.b,download.body)
        self.assertEqual(self.get('library',self.b),[])
        self.assertEqual(self.post('import-asset',self.b,download.body),{'kind':'received',**at})
        self.assertEqual(self.post('import-asset',self.b,download.body),{'kind':'received',**at})
        self.assertEqual(len(self.get('library',self.b)),1)
        altered = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(download.body)) as old, zipfile.ZipFile(altered,'w') as changed:
            changed.writestr('manifest.json',old.read('manifest.json'))
            changed.writestr('asset.json',old.read('asset.json')[:-1] + b']')
        with self.assertRaises(ProjectError):
            self.post('import-asset',self.b,altered.getvalue())

    def test_private_derivative_archive_reports_original_author_and_recovers_exact_snapshot(self):
        card = {**self.card,'id':'derived-card','communityOrigin':{
            'workId':self.wid,'edition':1,'author':'display string from old project'}}
        payload = {**self.package,'asset':'private-derivative','card':card}
        self.save_release_asset(self.b,payload)
        selection = {'asset':'private-derivative','assetVersion':1}
        download = self.post('download',self.b,selection)
        with self.store.connection() as db:
            author = self.store.user(db,self.a)['id']
            receiver = self.store.user(db,self.b)['id']
        with zipfile.ZipFile(io.BytesIO(download.body)) as archive:
            claims = json.loads(archive.read('manifest.json'))
            snapshot = json.loads(archive.read('asset.json'))
        self.assertEqual((claims['owner'],claims['authorId'],claims['author']),(receiver,author,'author'))
        self.assertEqual(snapshot['card'],card)
        self.assertEqual(self.post('inspect-asset',self.b,download.body)['author'],'author')
        with self.store.asset_workspace(receiver).connection() as db:
            card_assets(db,'POST','/api/card-assets/private-derivative/remove',{'expected':1})
        self.store = CommunityStore(self.store.path)
        self.assertEqual(self.post('import-asset',self.b,download.body),{'kind':'owned',
                         'assetId':'private-derivative','assetVersion':1})
        self.assertEqual(self.store.account_asset(receiver,'private-derivative',1)[1],snapshot)
        with self.assertRaises(ProjectError):
            self.post('publish',self.b,{**selection,'expectedEdition':0,'name':'不能去掉原作者','grant':True})

    def test_resource_restriction_invalidates_previous_package_and_retains_receiver_replacement(self):
        card = copy.deepcopy(self.card)
        source = self.package['cover']
        card['front']['nodes'] = [{'id':'art','name':'公开插画','type':'image','src':source}]
        work = self.post('publish',self.a,{**self.package,'asset':'image-card','card':card})['id']
        at = {'work':work,'edition':1}
        self.post('copy',self.b,at)
        before = self.post('download',self.b,at)
        identity = digest(source.encode())
        self.store.restrict_resource(work,1,identity,'更换插画')
        with self.assertRaises(ProjectError):
            self.post('inspect-asset',self.b,before.body)
        with self.assertRaises(ProjectError):
            self.post('download',self.b,at)
        with self.assertRaises(ProjectError):
            self.post('download',self.a,{'asset':'image-card','assetVersion':1})
        self.post('replace-resource',self.b,{**at,'resource':identity,'source':REMOVED_IMAGE})
        after = self.post('download',self.b,at)
        with zipfile.ZipFile(io.BytesIO(after.body)) as archive:
            self.assertNotIn(source.encode(),archive.read('asset.json'))
        self.post('remove',self.b,at)
        self.post('import-asset',self.b,after.body)
        self.assertEqual(self.get(f'card/{work}/1',self.b)['front']['nodes'][0]['src'],REMOVED_IMAGE)


if __name__=='__main__':
    unittest.main()
