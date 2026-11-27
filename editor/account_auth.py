"""Prism account verification, password recovery and session handling."""

import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import threading
import time
import unicodedata
import uuid
from email.message import EmailMessage
from pathlib import Path

from project_store import ProjectError

SESSION_AGE = 7 * 86400
VERIFY_AGE = 3600
RESET_AGE = 1800
PENDING_AGE = 86400
EMAIL_CODE_AGE = 600
EMAIL_CODE_COOLDOWN = 60
EMAIL_CODE_MAX_ATTEMPTS = 5
AUTH_ACTIONS = frozenset((
    'register', 'login', 'verify-email', 'resend-verification', 'bind-email',
    'request-password-reset', 'reset-password', 'change-password', 'profile',
    'request-email-code', 'login-email-code', 'request-password-code',
    'verify-password-code', 'reset-password-code',
))
MAIL_MESSAGE = '如果该邮箱可以接收邮件，验证或恢复链接将发送到该邮箱。'
INVALID_LINK = '链接无效或已过期，请重新申请。'
INVALID_EMAIL_CODE = '验证码错误或已过期，请重新获取。'
PASSWORD_SLOTS = threading.BoundedSemaphore(4)
EMAIL_CODE_KEY = secrets.token_bytes(32)


def require(condition, message, status=400):
    if not condition:
        raise ProjectError(message, status)


def email_address(value):
    if isinstance(value, str):
        value = value.strip().lower()
        local, at, domain = value.partition('@')
        if (at and len(value) <= 254 and 0 < len(local) <= 64
                and re.fullmatch(r"[a-z0-9!#$%&'*+/=?^_`{|}~.-]+", local)
                and not any(part == '' for part in local.split('.'))
                and '.' in domain and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                                          for label in domain.split('.'))):
            return value
    raise ProjectError('请输入有效的邮箱地址')


def account_name(value):
    if isinstance(value, str):
        name = unicodedata.normalize('NFC', value.strip())
        if 1 <= len(name) <= 32 and not any(unicodedata.category(c).startswith('C') for c in name):
            return name
    raise ProjectError('昵称长度为 1–32 个字符')


def password_value(value):
    require(isinstance(value, str) and 8 <= len(value) <= 128, '密码长度为 8–128 位')
    return value


def password_digest(password, salt):
    require(PASSWORD_SLOTS.acquire(blocking=False), '账号服务繁忙，请稍后重试', 503)
    try:
        return hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    finally:
        PASSWORD_SLOTS.release()


def token_digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def email_code_digest(email, purpose, issued, code):
    return hmac.digest(EMAIL_CODE_KEY, f'{email}\n{purpose}\n{issued}\n{code}'.encode(), 'sha256')


def digest_matches(row, password):
    tried = password_digest(password, row['salt'] if row else b'prism-login-idle')
    return bool(row and hmac.compare_digest(tried, row['digest']))


def account_data(row):
    if not row:
        return None
    name = row['display_name'] or row['handle']
    return {'id':row['id'], 'handle':name, 'displayName':name,
            'email':row['email'], 'emailVerified':bool(row['email'])}


def migrate(db):
    columns = {row['name'] for row in db.execute('PRAGMA table_info(users)')}
    if 'display_name' not in columns:
        db.execute('ALTER TABLE users ADD COLUMN display_name TEXT')
    if 'email' not in columns:
        db.execute('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email)')
    db.execute('''CREATE TABLE IF NOT EXISTS account_challenges (
        token TEXT PRIMARY KEY, purpose TEXT NOT NULL, email TEXT NOT NULL, uid TEXT,
        display_name TEXT, salt BLOB, password_hash BLOB, issued INTEGER NOT NULL,
        expires INTEGER NOT NULL, retain_until INTEGER NOT NULL)''')
    db.execute('CREATE INDEX IF NOT EXISTS challenges_email ON account_challenges(email,issued)')
    db.execute('CREATE INDEX IF NOT EXISTS challenges_user ON account_challenges(uid,purpose)')
    db.execute('CREATE INDEX IF NOT EXISTS challenges_expiry ON account_challenges(retain_until)')
    db.execute('CREATE INDEX IF NOT EXISTS attempts_source_ts ON attempts(source,ts)')
    db.execute('''CREATE TABLE IF NOT EXISTS account_email_codes (
        email TEXT NOT NULL, purpose TEXT NOT NULL, uid TEXT,
        digest BLOB NOT NULL, issued INTEGER NOT NULL, expires INTEGER NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(email,purpose))''')
    db.execute('CREATE INDEX IF NOT EXISTS account_email_codes_expiry ON account_email_codes(expires)')


class AccountMailer:
    def __init__(self, public_origin=None, local_origin='http://127.0.0.1:4174'):
        self.origin = (public_origin or local_origin).rstrip('/')
        # The test outbox contains raw links. Never enable it on a hosted workspace.
        self.outbox = (os.environ.get('PRISM_AUTH_TEST_OUTBOX') or None) if not public_origin else None
        self.host = os.environ.get('PRISM_SMTP_HOST')
        self.sender = os.environ.get('PRISM_SMTP_FROM')
        self.username = os.environ.get('PRISM_SMTP_USERNAME')
        self.password = os.environ.get('PRISM_SMTP_PASSWORD')
        self.mode = os.environ.get('PRISM_SMTP_TLS', 'starttls')
        self.port = os.environ.get('PRISM_SMTP_PORT', '465' if self.mode == 'ssl' else '587')

    def ensure_configured(self):
        require(self.outbox or (self.host and self.sender and self.mode in ('starttls','ssl')),
                '账号邮件服务暂未配置，请稍后重试', 503)

    def send(self, email, purpose, token):
        self.ensure_configured()
        subject = {'register':'验证 Prism 邮箱', 'bind':'绑定 Prism 邮箱', 'reset':'重置 Prism 密码',
                   'login-code':'Prism 登录验证码', 'password-code':'Prism 找回密码验证码'}[purpose]
        if purpose in ('login-code', 'password-code'):
            payload = {'code':token}
            content = f'{subject}\n\n{token}\n\n验证码在 10 分钟内有效。请勿向他人提供验证码。'
        else:
            page = 'reset' if purpose == 'reset' else 'verify'
            link = f'{self.origin}/#/account/{page}?token={token}'
            payload = {'link':link}
            content = f'{subject}\n\n{link}\n\n请在本次操作中打开链接。若未发起操作，可忽略此邮件。'
        try:
            if self.outbox:
                path = Path(self.outbox)
                flags = os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0)
                fd = os.open(path, flags, 0o600)
                with os.fdopen(fd, 'a', encoding='utf-8') as stream:
                    stream.write(json.dumps({'to':email, 'purpose':purpose, **payload, 'createdAt':int(time.time())})
                                 + '\n')
                return
            message = EmailMessage()
            message['Subject'] = subject
            message['From'] = email_address(self.sender)
            message['To'] = email
            message.set_content(content)
            tls = ssl.create_default_context()
            if self.mode == 'ssl':
                mail = smtplib.SMTP_SSL(self.host, int(self.port), timeout=8, context=tls)
            else:
                mail = smtplib.SMTP(self.host, int(self.port), timeout=8)
            with mail:
                if self.mode == 'starttls':
                    mail.starttls(context=tls)
                if self.username:
                    mail.login(self.username, self.password or '')
                mail.send_message(message)
        except (OSError, smtplib.SMTPException, ValueError) as error:
            raise ProjectError('暂时无法发送账号邮件，请稍后重试', 503) from error


class Accounts:
    def __init__(self, connection, public_origin=None, local_origin='http://127.0.0.1:4174'):
        self.connection = connection
        self.mailer = AccountMailer(public_origin, local_origin)

    def limit(self, source, action, subject=None, email=False):
        now = int(time.time())
        peer = 'auth:' + ('mail' if email else 'session') + ':' + token_digest(source)
        scopes = [(peer, 3600 if email else 300, 180 if email else 160)]
        if subject:
            namespace = 'mail' if email else action
            scopes.append(('auth:' + namespace + ':id:' + token_digest(subject), 900 if email else 300,
                           5 if email else 12))
        with self.connection(True) as db:
            db.execute('DELETE FROM attempts WHERE ts<=?', (now - 3600,))
            for key, duration, maximum in scopes:
                used = db.execute('SELECT count(*) FROM attempts WHERE source=? AND ts>?', (key,now-duration)).fetchone()[0]
                require(used < maximum, '操作过于频繁，请稍后重试', 429)
            db.executemany('INSERT INTO attempts VALUES (?,?)', ((key, now) for key, _, _ in scopes))

    @staticmethod
    def session(db, uid):
        token = secrets.token_urlsafe(36)
        now = int(time.time())
        db.execute('DELETE FROM sessions WHERE expires<=?', (now,))
        db.execute('INSERT INTO sessions VALUES (?,?,?)', (token_digest(token), uid, now+SESSION_AGE))
        return token

    def switch_session(self, db, account, prior_token):
        if prior_token:
            db.execute('DELETE FROM sessions WHERE digest=?', (token_digest(prior_token),))
        return account_data(account), self.session(db,account['id'])

    @staticmethod
    def user(db, token):
        if not token:
            return None
        row = db.execute('''SELECT u.id,u.handle,u.display_name,u.email FROM users u JOIN sessions s ON u.id=s.uid
                          WHERE s.digest=? AND s.expires>?''', (token_digest(token),int(time.time()))).fetchone()
        return account_data(row)

    def legacy_register(self, data, source):
        """Preserve the in-process compatibility path for historical fixtures."""
        name = data.get('handle')
        require(isinstance(name, str) and re.fullmatch(r'[\w.-]{2,32}', name.strip()), '账号名无效')
        name = name.strip()
        password = password_value(data.get('password'))
        self.limit(source, 'register', name.casefold())
        uid, salt = uuid.uuid4().hex, secrets.token_bytes(16)
        hashed = password_digest(password, salt)
        with self.connection(True) as db:
            require(not db.execute('SELECT 1 FROM users WHERE handle=?', (name,)).fetchone(), '该账号名已使用', 409)
            db.execute('INSERT INTO users (id,handle,salt,digest) VALUES (?,?,?,?)', (uid, name, salt, hashed))
            account = account_data(db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())
            token = self.session(db,uid)
        return account, token

    def login(self, data, source, prior_token=''):
        identity = data.get('identity', data.get('handle'))
        require(isinstance(identity, str) and 1 <= len(identity.strip()) <= 254, '请输入邮箱或原账号名')
        identity = identity.strip()
        password = password_value(data.get('password'))
        email = email_address(identity) if '@' in identity else None
        self.limit(source, 'login', identity.casefold())
        with self.connection() as db:
            row = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone() if email else (
                db.execute('SELECT * FROM users WHERE handle=? AND handle<>id', (identity,)).fetchone())
            pending = self.recent_challenge(db, email, 'register') if email and not row else None
        if pending:
            candidate = {'salt':pending['salt'], 'digest':pending['password_hash']}
            if digest_matches(candidate, password):
                raise ProjectError('请先验证邮箱，或重发验证邮件', 403)
        require(digest_matches(row, password), '账号或密码有误', 401)
        with self.connection(True) as db:
            latest = db.execute('SELECT * FROM users WHERE id=?', (row['id'],)).fetchone()
            require(latest and latest['digest']==row['digest'], '账号或密码有误', 401)
            return self.switch_session(db,latest,prior_token)

    def request_email_code(self, data, source, purpose):
        email = email_address(data.get('email'))
        self.mailer.ensure_configured()
        self.limit(source, purpose, email, email=True)
        code = f'{secrets.randbelow(1_000_000):06}'
        now = int(time.time())
        code_hash = email_code_digest(email, purpose, now, code)
        with self.connection(True) as db:
            db.execute('DELETE FROM account_email_codes WHERE expires<=?', (now,))
            current = db.execute('SELECT issued FROM account_email_codes WHERE email=? AND purpose=?',
                                 (email,purpose)).fetchone()
            require(not current or current['issued']<=now-EMAIL_CODE_COOLDOWN, '请稍后重新发送验证码', 429)
            owner = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
            db.execute('INSERT OR REPLACE INTO account_email_codes VALUES (?,?,?,?,?,?,0)',
                       (email,purpose,owner['id'] if owner else None,code_hash,now,now+EMAIL_CODE_AGE))
        if purpose == 'login-code' or owner:
            try:
                self.mailer.send(email, purpose, code)
            except ProjectError:
                with self.connection(True) as db:
                    db.execute('DELETE FROM account_email_codes WHERE email=? AND purpose=? AND digest=?',
                               (email,purpose,code_hash))
                raise
        message = ('验证码已发送，请查收邮件。' if purpose=='login-code'
                   else '如果该邮箱已绑定账号，验证码将发送到该邮箱。')
        return {'message':message, 'retryAfter':EMAIL_CODE_COOLDOWN}

    def email_code_input(self, data, source, purpose):
        email = email_address(data.get('email'))
        code = data.get('code')
        require(isinstance(code,str) and re.fullmatch(r'[0-9]{6}',code), '请输入 6 位验证码')
        self.limit(source, purpose, email)
        return email, code

    @staticmethod
    def consume_email_code(db, email, purpose, code):
        row = db.execute('''SELECT uid,digest,issued,failures FROM account_email_codes
                            WHERE email=? AND purpose=? AND expires>?''',
                         (email,purpose,int(time.time()))).fetchone()
        if row and row['failures']<EMAIL_CODE_MAX_ATTEMPTS:
            if hmac.compare_digest(email_code_digest(email,purpose,row['issued'],code), row['digest']):
                db.execute('DELETE FROM account_email_codes WHERE email=? AND purpose=?', (email,purpose))
                return row
            db.execute('UPDATE account_email_codes SET failures=failures+1 WHERE email=? AND purpose=?',
                       (email,purpose))
        return None

    def login_email_code(self, data, source, prior_token):
        email, code = self.email_code_input(data, source, 'login-code')
        with self.connection(True) as db:
            if self.consume_email_code(db,email,'login-code',code):
                account = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
                if not account:
                    uid = uuid.uuid4().hex
                    # This account has no password until its owner sets one via password recovery.
                    db.execute('INSERT INTO users (id,handle,salt,digest,display_name,email) VALUES (?,?,?,?,?,?)',
                               (uid,uid,secrets.token_bytes(16),secrets.token_bytes(32),'Prism 用户',email))
                    account = db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
                    db.execute("DELETE FROM account_challenges WHERE email=? AND purpose IN ('register','bind')",
                               (email,))
                return self.switch_session(db,account,prior_token)
        raise ProjectError(INVALID_EMAIL_CODE, 401)

    def verify_password_code(self, data, source):
        email, code = self.email_code_input(data, source, 'password-code')
        with self.connection(True) as db:
            row = self.consume_email_code(db,email,'password-code',code)
            if row and row['uid'] and db.execute('SELECT 1 FROM users WHERE id=? AND email=?',
                                                  (row['uid'],email)).fetchone():
                return {'token':self.challenge(db,'reset-code',email,uid=row['uid'])}
        raise ProjectError(INVALID_EMAIL_CODE, 401)

    @staticmethod
    def recent_challenge(db, email, purpose=None):
        return db.execute('''SELECT * FROM account_challenges WHERE email=? AND retain_until>?
                            AND (purpose=? OR (? IS NULL AND purpose IN ('register','bind')))
                            ORDER BY rowid DESC LIMIT 1''',
                          (email,int(time.time()),purpose,purpose)).fetchone()

    @staticmethod
    def challenge(db, purpose, email, uid=None, name=None, salt=None, hashed=None):
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        recovery = purpose in ('reset','reset-code')
        lifetime = RESET_AGE if recovery else VERIFY_AGE
        retained = RESET_AGE if recovery else PENDING_AGE
        db.execute('DELETE FROM account_challenges WHERE retain_until<=?', (now,))
        db.execute('INSERT INTO account_challenges VALUES (?,?,?,?,?,?,?,?,?,?)',
                   (token_digest(token),purpose,email,uid,name,salt,hashed,now,now+lifetime,now+retained))
        return token

    def register(self, data, source):
        email = email_address(data.get('email'))
        name = account_name(data.get('displayName'))
        password = password_value(data.get('password'))
        self.mailer.ensure_configured()
        self.limit(source, 'register', email, email=True)
        salt = secrets.token_bytes(16)
        hashed = password_digest(password, salt)
        with self.connection(True) as db:
            if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
                return {'message':MAIL_MESSAGE}
            token = self.challenge(db, 'register', email, name=name, salt=salt, hashed=hashed)
        self.mailer.send(email, 'register', token)
        return {'message':MAIL_MESSAGE}

    def resend(self, data, source):
        email = email_address(data.get('email'))
        self.mailer.ensure_configured()
        self.limit(source, 'resend', email, email=True)
        with self.connection(True) as db:
            challenge = self.recent_challenge(db, email)
            if not challenge or db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
                return {'message':MAIL_MESSAGE}
            purpose = challenge['purpose']
            token = self.challenge(db, purpose, email, challenge['uid'], challenge['display_name'],
                                   challenge['salt'], challenge['password_hash'])
        self.mailer.send(email, purpose, token)
        return {'message':MAIL_MESSAGE}

    def bind(self, data, source, session):
        email = email_address(data.get('email'))
        password = password_value(data.get('password'))
        self.mailer.ensure_configured()
        with self.connection() as db:
            account = self.user(db, session)
            require(account, '请先登录', 401)
            row = db.execute('SELECT * FROM users WHERE id=?', (account['id'],)).fetchone()
        self.limit(source, 'bind-password', account['id'])
        require(digest_matches(row, password), '账号或密码有误', 401)
        require(not row['email'], '当前账号已验证邮箱', 409)
        self.limit(source, 'bind', email, email=True)
        with self.connection(True) as db:
            require(self.user(db,session) and db.execute('SELECT 1 FROM users WHERE id=? AND email IS NULL',
                                                        (account['id'],)).fetchone(), '账号状态已变化', 409)
            if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
                return {'message':MAIL_MESSAGE}
            token = self.challenge(db, 'bind', email, uid=account['id'])
        self.mailer.send(email, 'bind', token)
        return {'message':MAIL_MESSAGE}

    @staticmethod
    def find_challenge(db, data, purposes):
        token = data.get('token')
        require(isinstance(token, str) and re.fullmatch(r'[a-zA-Z0-9_-]{43}', token), INVALID_LINK)
        row = db.execute('SELECT * FROM account_challenges WHERE token=? AND expires>?',
                         (token_digest(token),int(time.time()))).fetchone()
        require(row and row['purpose'] in purposes, INVALID_LINK)
        return row

    def verify(self, data, source):
        password = password_value(data.get('password'))
        self.limit(source, 'verify')
        with self.connection() as db:
            challenge = self.find_challenge(db,data,('register','bind'))
            credential = {'salt':challenge['salt'], 'digest':challenge['password_hash']} if challenge['purpose']=='register' else (
                db.execute('SELECT * FROM users WHERE id=?', (challenge['uid'],)).fetchone())
        self.limit(source, 'verify-email', challenge['email'])
        require(digest_matches(credential,password), '账号或密码有误',401)
        with self.connection(True) as db:
            challenge = self.find_challenge(db,data,('register','bind'))
            email, uid = challenge['email'], challenge['uid']
            require(not db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone(), INVALID_LINK)
            if challenge['purpose']=='register':
                uid = uuid.uuid4().hex
                db.execute('INSERT INTO users (id,handle,salt,digest,display_name,email) VALUES (?,?,?,?,?,?)',
                           (uid,uid,challenge['salt'],challenge['password_hash'],challenge['display_name'],email))
            else:
                changed = db.execute('UPDATE users SET email=? WHERE id=? AND email IS NULL AND digest=?',
                                     (email,uid,credential['digest'])).rowcount
                require(changed==1, INVALID_LINK)
            db.execute("DELETE FROM account_challenges WHERE (email=? AND purpose IN ('register','bind')) OR (uid=? AND purpose='bind')",
                       (email,uid))
        return {'message':'邮箱已验证，可以登录了。'}

    def request_reset(self, data, source):
        email = email_address(data.get('email'))
        self.mailer.ensure_configured()
        self.limit(source, 'reset', email, email=True)
        with self.connection(True) as db:
            user = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
            if not user:
                return {'message':MAIL_MESSAGE}
            token = self.challenge(db, 'reset', email, uid=user['id'])
        self.mailer.send(email, 'reset', token)
        return {'message':MAIL_MESSAGE}

    @staticmethod
    def replace_password(db, uid, salt, hashed):
        db.execute('UPDATE users SET salt=?,digest=? WHERE id=?', (salt,hashed,uid))
        db.execute('DELETE FROM sessions WHERE uid=?', (uid,))
        db.execute("DELETE FROM account_challenges WHERE uid=? AND purpose IN ('reset','reset-code','bind')", (uid,))
        db.execute("DELETE FROM account_email_codes WHERE uid=? AND purpose='password-code'", (uid,))

    def reset(self, data, source, purpose, prior_token):
        password = password_value(data.get('password'))
        self.limit(source, 'recover')
        with self.connection() as db:
            challenge = self.find_challenge(db,data,(purpose,))
        self.limit(source, 'recover-email', challenge['email'])
        salt = secrets.token_bytes(16)
        hashed = password_digest(password, salt)
        with self.connection(True) as db:
            challenge = self.find_challenge(db,data,(purpose,))
            uid = challenge['uid']
            account = db.execute('SELECT * FROM users WHERE id=? AND email=?', (uid,challenge['email'])).fetchone()
            require(account, INVALID_LINK)
            self.replace_password(db,uid,salt,hashed)
            if purpose=='reset-code':
                return self.switch_session(db,account,prior_token)
        return {'message':'密码已重置，请重新登录。'}, None

    def change_password(self, data, source, token):
        old = password_value(data.get('currentPassword'))
        new = password_value(data.get('newPassword'))
        with self.connection() as db:
            account = self.user(db,token)
            require(account, '请先登录', 401)
            row = db.execute('SELECT * FROM users WHERE id=?', (account['id'],)).fetchone()
        self.limit(source, 'change-password', account['id'])
        require(digest_matches(row,old), '账号或密码有误', 401)
        salt = secrets.token_bytes(16)
        hashed = password_digest(new,salt)
        with self.connection(True) as db:
            require(self.user(db,token), '登录已过期，请重新登录', 401)
            self.replace_password(db, account['id'], salt, hashed)
        return {'message':'密码已修改，请重新登录。'}

    def profile(self, data, token):
        name = account_name(data.get('displayName'))
        with self.connection(True) as db:
            account = self.user(db,token)
            require(account, '请先登录', 401)
            db.execute('UPDATE users SET display_name=? WHERE id=?', (name,account['id']))
            return self.user(db,token)

    def handle(self, action, data, source, token):
        if action=='login':
            return self.login(data,source,token)
        if action=='login-email-code':
            return self.login_email_code(data,source,token)
        if action in ('request-email-code','request-password-code'):
            purpose = 'login-code' if action=='request-email-code' else 'password-code'
            return self.request_email_code(data,source,purpose), None
        if action=='verify-password-code':
            return self.verify_password_code(data,source), None
        if action in ('reset-password','reset-password-code'):
            purpose = 'reset' if action=='reset-password' else 'reset-code'
            return self.reset(data,source,purpose,token)
        if action=='bind-email':
            return self.bind(data,source,token), None
        if action=='change-password':
            return self.change_password(data,source,token), None
        if action=='profile':
            return self.profile(data,token), None
        handler = {'register':self.register, 'verify-email':self.verify,
                   'resend-verification':self.resend, 'request-password-reset':self.request_reset}[action]
        return handler(data,source), None
