"""Verification, account binding and revocable sessions in an isolated workspace."""

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_auth import EMAIL_CODE_AGE, EMAIL_CODE_COOLDOWN, EMAIL_CODE_MAX_ATTEMPTS, password_digest, token_digest
from community_store import CommunityStore
from project_store import ProjectError


class AccountTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        self.outbox = self.folder / 'outbox.jsonl'
        environment = patch.dict(os.environ, {'PRISM_AUTH_TEST_OUTBOX':str(self.outbox),
                                              'PRISM_SMTP_HOST':'','PRISM_SMTP_FROM':''})
        environment.start()
        self.addCleanup(environment.stop)
        self.store = CommunityStore(self.folder/'community.sqlite3',local_origin='http://127.0.0.1:4299')
        self.email = 'card-creator@example.test'
        self.password = 'initial-password'

    def call(self, action, data, token='', source='peer'):
        return self.store.accounts.handle(action,data,source,token)

    def submit(self):
        result, session = self.call('register',{'email':self.email.upper(),'password':self.password,
                                                'displayName':'苔芽设计'})
        self.assertIn('message',result)
        self.assertIsNone(session)

    def mail(self, purpose):
        item = json.loads(self.outbox.read_text().splitlines()[-1])
        self.assertEqual(item['to'], self.email)
        self.assertEqual(item['purpose'], purpose)
        link = urlsplit(item['link'])
        self.assertEqual(link.netloc, '127.0.0.1:4299')
        return parse_qs(link.fragment.split('?',1)[1])['token'][0]

    def verify(self):
        self.submit()
        self.call('verify-email',{'token':self.mail('register'),'password':self.password})

    def login(self, password=None, token=''):
        return self.call('login',{'identity':self.email,'password':password or self.password},token)

    def request_code(self, recovery=False):
        action = 'request-password-code' if recovery else 'request-email-code'
        result, session = self.call(action,{'email':self.email.upper()})
        self.assertEqual(result['retryAfter'], EMAIL_CODE_COOLDOWN)
        self.assertIsNone(session)
        item = json.loads(self.outbox.read_text().splitlines()[-1])
        self.assertEqual(item['to'], self.email)
        self.assertEqual(item['purpose'], 'password-code' if recovery else 'login-code')
        self.assertRegex(item['code'], r'^[0-9]{6}$')
        return item['code']

    def login_code(self, code, token=''):
        return self.call('login-email-code',{'email':self.email,'code':code},token)

    def session_user(self, session):
        with self.store.connection() as db:
            return self.store.user(db,session)

    def test_signup_verification_requires_both_mailbox_and_original_password(self):
        self.submit()
        token = self.mail('register')
        with self.assertRaisesRegex(ProjectError,'验证邮箱'):
            self.login()
        with self.assertRaisesRegex(ProjectError,'账号或密码'):
            self.call('verify-email',{'token':token,'password':'different-password'})
        _, session = self.call('verify-email',{'token':token,'password':self.password})
        self.assertIsNone(session)
        with self.assertRaisesRegex(ProjectError,'过期'):
            self.call('verify-email',{'token':token,'password':self.password})
        account, session = self.login()
        self.assertTrue(account['emailVerified'])
        self.assertEqual(account['displayName'],'苔芽设计')
        self.assertEqual(self.session_user(session),account)
        with self.store.connection() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0],1)

    def test_expired_verification_can_be_resent(self):
        self.submit()
        first = self.mail('register')
        with self.store.connection(True) as db:
            db.execute('UPDATE account_challenges SET expires=? WHERE token=?',(int(time.time())-1,token_digest(first)))
        with self.assertRaisesRegex(ProjectError,'过期'):
            self.call('verify-email',{'token':first,'password':self.password})
        self.call('resend-verification',{'email':self.email})
        second = self.mail('register')
        self.assertNotEqual(first,second)
        self.call('verify-email',{'token':second,'password':self.password})
        self.assertEqual(self.login()[0]['email'],self.email)

    def test_reset_and_change_revoke_sessions_and_old_challenges(self):
        self.verify()
        _, computer = self.login()
        _, mobile = self.login()
        unknown, _ = self.call('request-password-reset',{'email':'unknown@example.test'})
        self.assertEqual(len(self.outbox.read_text().splitlines()),1)
        known, _ = self.call('request-password-reset',{'email':self.email})
        self.assertEqual(known, unknown)
        first = self.mail('reset')
        self.call('request-password-reset',{'email': self.email})
        second = self.mail('reset')
        self.call('reset-password',{'token':first,'password':'new-first-password'})
        self.assertIsNone(self.session_user(computer))
        self.assertIsNone(self.session_user(mobile))
        with self.assertRaisesRegex(ProjectError,'过期'):
            self.call('reset-password',{'token':second,'password':'stale-password'})
        with self.assertRaisesRegex(ProjectError,'账号或密码'):
            self.login()
        _, new = self.login('new-first-password')
        self.call('change-password',{'currentPassword':'new-first-password','newPassword':'new-second-password'},new)
        self.assertIsNone(self.session_user(new))
        self.assertTrue(self.login('new-second-password')[0]['emailVerified'])

    def test_legacy_bind_preserves_id_login_handle_and_workspaces(self):
        path=self.folder/'legacy.sqlite3'
        uid='legacy-stable-uuid'
        existing_session='legacy-active-session'
        salt=b'1234567890123456'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE users(id TEXT PRIMARY KEY,handle TEXT UNIQUE COLLATE NOCASE,salt BLOB,digest BLOB)')
            db.execute('CREATE TABLE sessions(digest TEXT PRIMARY KEY,uid TEXT NOT NULL,expires INTEGER)')
            db.execute('INSERT INTO users VALUES(?,?,?,?)',(uid,'legacy-creator',salt,password_digest(self.password,salt)))
            db.execute('INSERT INTO sessions VALUES(?,?,?)',(token_digest(existing_session),uid,int(time.time())+300))
        self.store=CommunityStore(path,local_origin='http://127.0.0.1:4299')
        self.assertFalse(self.session_user(existing_session)['emailVerified'])
        _, legacy=self.call('login',{'identity':'legacy-creator','password':self.password})
        self.call('bind-email',{'email':self.email,'password':self.password},legacy)
        self.call('verify-email',{'token':self.mail('bind'),'password':self.password})
        self.call('profile',{'displayName':'墨灰工作台'},legacy)
        account,_=self.login()
        self.assertEqual(account['id'],uid)
        self.assertEqual(account['displayName'],'墨灰工作台')
        self.assertEqual(account,self.session_user(existing_session))
        self.assertEqual(self.call('login',{'identity':'legacy-creator','password':self.password})[0],account)
        via_code, session = self.login_code(self.request_code(), legacy)
        self.assertEqual(via_code, account)
        self.assertEqual(self.session_user(session), account)
        self.assertIsNone(self.session_user(legacy))
        self.assertIsNotNone(self.session_user(existing_session))

    def test_email_code_signup_discards_unproven_credentials_and_cannot_replay(self):
        self.submit()
        pending_link = self.mail('register')
        code = self.request_code()
        with self.store.connection() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0],0)
            digest = db.execute('SELECT digest FROM account_email_codes').fetchone()[0]
            self.assertEqual(len(digest),32)
            self.assertNotEqual(digest,code.encode())
        account, session = self.login_code(code)
        self.assertEqual(account['email'],self.email)
        self.assertTrue(account['emailVerified'])
        self.assertEqual(self.session_user(session),account)
        with self.assertRaisesRegex(ProjectError,'验证码'):
            self.login_code(code)
        with self.assertRaisesRegex(ProjectError,'账号或密码'):
            self.login()
        with self.assertRaisesRegex(ProjectError,'过期'):
            self.call('verify-email',{'token':pending_link,'password':self.password})

    def test_email_code_attempt_limit_cooldown_and_expiry(self):
        start = int(time.time())
        with patch('account_auth.secrets.randbelow',side_effect=(7,8,9)), patch('account_auth.time.time',return_value=start):
            code = self.request_code()
            with self.assertRaises(ProjectError) as cooldown:
                self.call('request-email-code',{'email':self.email},source='another-peer')
            self.assertEqual(cooldown.exception.status,429)
            for _ in range(EMAIL_CODE_MAX_ATTEMPTS):
                with self.assertRaisesRegex(ProjectError,'验证码'):
                    self.login_code('123456')
            with self.assertRaisesRegex(ProjectError,'验证码'):
                self.login_code(code)
        with patch('account_auth.secrets.randbelow',return_value=10):
            with patch('account_auth.time.time',return_value=start+EMAIL_CODE_COOLDOWN):
                fresh = self.request_code()
                self.assertNotEqual(fresh,code)
            with patch('account_auth.time.time',return_value=start+EMAIL_CODE_COOLDOWN+EMAIL_CODE_AGE):
                with self.assertRaisesRegex(ProjectError,'过期'):
                    self.login_code(fresh)

    def test_concurrent_code_use_creates_one_account_and_session(self):
        code = self.request_code()

        def redeem(_):
            try:
                return self.login_code(code)
            except ProjectError as error:
                self.assertEqual(error.status,401)
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(redeem,range(2)))
        self.assertEqual(sum(result is not None for result in results),1)
        with self.store.connection() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0],1)

    def test_password_code_has_separate_purpose_and_reset_signs_in_once(self):
        unknown, _ = self.call('request-password-code',{'email':'unknown@example.test'})
        self.assertFalse(self.outbox.exists())
        self.verify()
        account, previous = self.login()
        with patch('account_auth.secrets.randbelow',side_effect=(81,82)):
            sign_in_code = self.request_code()
            reset_code = self.request_code(recovery=True)
        self.assertIn('如果',unknown['message'])
        self.assertEqual(unknown['retryAfter'],EMAIL_CODE_COOLDOWN)
        with self.assertRaisesRegex(ProjectError,'验证码'):
            self.call('verify-password-code',{'email':self.email,'code':sign_in_code})
        with self.assertRaisesRegex(ProjectError,'验证码'):
            self.login_code(reset_code)
        result, session = self.call('verify-password-code',{'email':self.email,'code':reset_code})
        self.assertIsNone(session)
        token = result['token']
        with self.assertRaisesRegex(ProjectError,'过期'):
            self.call('reset-password',{'token':token,'password':'updated-password'})
        updated, session = self.call('reset-password-code',{'token':token,'password':'updated-password'})
        self.assertEqual(updated,account)
        self.assertIsNone(self.session_user(previous))
        self.assertEqual(self.session_user(session),account)
        self.assertEqual(self.login('updated-password')[0],account)
        with self.assertRaisesRegex(ProjectError,'过期'):
            self.call('reset-password-code',{'token':token,'password':'another-password'})

    def test_switch_cookie_revokes_old_session_only(self):
        self.verify()
        _, current=self.login()
        _, another_device=self.login()
        _, switched=self.login(token=current)
        self.assertIsNone(self.session_user(current))
        self.assertIsNotNone(self.session_user(another_device))
        self.assertIsNotNone(self.session_user(switched))
        self.store.handle(['logout'],'POST',{},switched,{})
        self.assertIsNone(self.session_user(switched))
        self.store.handle(['logout'],'POST',{},switched,{})
        self.assertIsNotNone(self.session_user(another_device))

    def test_mail_attempts_limit_normalized_mailbox_across_peers(self):
        for index in range(5):
            self.call('resend-verification',{'email':self.email.upper()},source=f'peer-{index}')
        with self.assertRaises(ProjectError) as error:
            self.call('request-password-reset',{'email':self.email},source='new-peer')
        self.assertEqual(error.exception.status,429)
        self.assertFalse(self.outbox.exists())

    def test_public_workspace_cannot_use_test_outbox(self):
        self.store=CommunityStore(self.folder/'hosted.sqlite3', public_origin='https://prism.example.test')
        with self.assertRaises(ProjectError) as error:
            self.submit()
        self.assertEqual(error.exception.status,503)
        self.assertFalse(self.outbox.exists())


if __name__=='__main__':
    unittest.main()
