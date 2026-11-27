"""Explicit TLS access to a single project from the owner's private network."""
import datetime
import hashlib
import hmac
import ipaddress
import json
import secrets
import socket
import ssl
import threading
import time
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from project_store import PROJECT_ID, ProjectError

PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
LOGIN = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prism · 局域网接力</title><style>
*{box-sizing:border-box}body{background:#171717;color:#fafafa;font:14px system-ui;margin:0;display:grid;place-items:center;min-height:100dvh}form{background:#292929;border:1px solid #444;border-radius:18px;width:min(360px,92vw);padding:24px}h1{font-size:20px;margin:0 0 20px}input,button{width:100%;min-height:38px;border-radius:9px;margin-top:8px;padding:0 10px;font:inherit}input{background:#393939;color:white;border:1px solid #555}button{background:#237ac2;color:white;border:0;margin-top:18px}p{color:#ffa899}</style>
<form method="post" action="/lan/login"><h1>局域网接力</h1><label>访问密码<input name="password" type="password" required autofocus autocomplete="current-password"></label>ERROR<button>打开共享项目</button></form></html>'''


def local_address():
    # UDP connect chooses a route without sending a datagram.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(('192.0.2.1', 9))
            ip = ipaddress.ip_address(probe.getsockname()[0])
            if any(ip in network for network in PRIVATE_NETS):
                return str(ip)
        except OSError:
            pass
    raise ProjectError('未找到同网设备可访问的 IPv4 地址，请检查 Wi-Fi 或有线网络。', 503)


def make_tls(directory, address):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    root_key_path = directory / 'host-key.pem'
    root_cert_path = directory / 'prism-lan-ca.crt'
    if root_key_path.is_file() and root_cert_path.is_file():
        root_key = serialization.load_pem_private_key(root_key_path.read_bytes(), password=None)
        root_cert = x509.load_pem_x509_certificate(root_cert_path.read_bytes())
    else:
        root_key = ec.generate_private_key(ec.SECP256R1())
        root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Prism LAN ' + secrets.token_hex(4))])
        root_cert = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name)
                     .public_key(root_key.public_key()).serial_number(x509.random_serial_number())
                     .not_valid_before(now-datetime.timedelta(minutes=5)).not_valid_after(now+datetime.timedelta(days=1825))
                     .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
                     .add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False),critical=True)
                     .add_extension(x509.NameConstraints(permitted_subtrees=[x509.IPAddress(n) for n in PRIVATE_NETS]+[x509.IPAddress(ipaddress.ip_network('127.0.0.0/8'))],excluded_subtrees=None),critical=True)
                     .sign(root_key,hashes.SHA256()))
        root_key_path.touch(mode=0o600)
        root_key_path.write_bytes(root_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        root_cert_path.write_bytes(root_cert.public_bytes(serialization.Encoding.PEM))
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,address)]))
            .issuer_name(root_cert.subject).public_key(leaf_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now-datetime.timedelta(minutes=5)).not_valid_after(now+datetime.timedelta(days=90))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(address))]),critical=False)
            .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False).sign(root_key,hashes.SHA256()))
    cert_file = directory / 'server.crt'
    key_file = directory / 'server.key'
    key_file.touch(mode=0o600)
    key_file.write_bytes(leaf_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    cert_file.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert_file,key_file)
    return context


def shared_handler(base):
    class SharedHandler(base):
        def origin_allowed(self):
            expected = self.server.lan.url
            origin = self.headers.get('Origin')
            return self.headers.get('Host','').lower() == urlsplit(expected).netloc and (not origin or origin == expected)

        def do_OPTIONS(self):
            self.respond(405,b'{}')

        def project_workspace(self):
            self.workspace_scope = 'lan'
            return self.server.projects

        def do_GET(self):
            self.route()

        def do_POST(self):
            self.route()

        def route(self):
            access = self.server.lan
            if not self.origin_allowed() or access.listener is not self.server:
                self.respond(403,b'{}')
                return
            path=urlsplit(self.path).path
            login_page = lambda status,error: self.respond(status, LOGIN.replace('ERROR', '<p>'+error+'</p>' if error else '').encode(), 'text/html; charset=utf-8')
            if self.command == 'POST' and path == '/lan/login':
                if self.headers.get_content_type() != 'application/x-www-form-urlencoded':
                    self.respond(415,b'{}')
                    return
                try:
                    size=int(self.headers.get('Content-Length','0'))
                except ValueError:
                    size=0
                if not 0 < size <= 1024:
                    self.respond(400,b'{}')
                    return
                self.connection.settimeout(10)
                value=parse_qs(self.rfile.read(size).decode('utf-8','replace')).get('password',[''])[0]
                token=access.login(self.client_address[0],value)
                if not token:
                    login_page(403,'密码无效或尝试次数过多，请稍后重试。')
                    return
                self.send_response(303)
                self.send_header('Set-Cookie','prism_lan='+token+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800')
                self.send_header('Location','/?project='+access.project)
                self.send_header('Cache-Control','no-store')
                self.send_header('Content-Length','0')
                self.end_headers()
                return

            cookie=SimpleCookie()
            try: cookie.load(self.headers.get('Cookie',''))
            except ValueError: pass
            session=cookie.get('prism_lan')
            if not session or not access.authorized(session.value):
                if self.command == 'GET' and path in ('/','/lan/login'):
                    login_page(200,'')
                else:
                    self.respond(401,json.dumps({'error':'局域网会话已失效，请重新验证密码。'},ensure_ascii=False).encode())
                return
            target='/api/projects/'+access.project
            if path.startswith('/api/'):
                try:
                    summary=self.server.projects.summary(access.project)
                    if summary['archivedAt'] is not None: raise ProjectError('共享项目已归档',403)
                except ProjectError as exc:
                    self.respond(exc.status,json.dumps({'error':str(exc)},ensure_ascii=False).encode())
                    return
            if self.command=='GET' and path=='/api/projects':
                self.workspace_scope='lan'
                self.respond(200,json.dumps([summary],ensure_ascii=False).encode())
            elif path==target or path==target+'/deliveries' or (self.command=='GET' and path.startswith(target+'/deliveries/') and PROJECT_ID.fullmatch(path.split('/')[-1])):
                self.handle_projects(path)
            elif (self.command=='GET' and path=='/api/health') or (self.command=='POST' and path=='/api/export'):
                if self.command=='GET': super().do_GET()
                else: super().do_POST()
            elif self.command=='GET' and not path.startswith('/api/'):
                self.serve_frontend(path)
            else:
                self.respond(403,json.dumps({'error':'局域网会话仅允许使用已共享的项目。'},ensure_ascii=False).encode())
    return SharedHandler


class LanAccess:
    def __init__(self,base,directory):
        self.base,self.directory=base,Path(directory)
        self.lock=threading.RLock()
        self.sessions={}
        self.failures={}
        self.listener=None
        self.url=self.project=''
        self.password=''
        self.owner=None

    def require_owner(self,owner):
        if owner is not None and self.owner is not None and owner!=self.owner:
            raise ProjectError('当前共享由另一个账号开启',409)

    def status(self,owner=None):
        with self.lock:
            self.require_owner(owner)
            return {'enabled':self.listener is not None,'url':self.url,'projectId':self.project,
                    'password':self.password}

    def login(self,address,value):
        now=time.monotonic()
        with self.lock:
            failures=[stamp for stamp in self.failures.get(address,[]) if now-stamp<60]
            if len(failures)>=8: return None
            if not self.listener or not hmac.compare_digest(value.encode(),self.password.encode()):
                self.failures[address]=failures+[now]
                return None
            self.failures.pop(address,None)
            self.sessions={key:end for key,end in self.sessions.items() if end>now}
            token=secrets.token_urlsafe(32)
            self.sessions[hashlib.sha256(token.encode()).digest()]=now+28800
            return token

    def authorized(self,token):
        with self.lock:
            return bool(self.listener and self.sessions.get(hashlib.sha256(token.encode()).digest(),0)>time.monotonic())

    def enable(self,project,store,owner,address=None):
        with self.lock:
            self.require_owner(owner)
            if self.listener:
                if self.project==project: return self.status(owner)
                raise ProjectError('请先停止当前项目的共享。',409)
            record=store.summary(project)
            if record['archivedAt'] is not None: raise ProjectError('请先恢复该项目。',409)
            address=address or local_address()
            context=make_tls(self.directory,address)
            listener=ThreadingHTTPServer((address,0),shared_handler(self.base))
            try:
                listener.socket=context.wrap_socket(listener.socket,server_side=True)
                listener.daemon_threads=True
                listener.projects=store
                listener.shared_project_id=project
                listener.lan=self
                self.project=project
                self.owner=owner
                self.password=secrets.token_urlsafe(12)
                self.url='https://'+address+':'+str(listener.server_port)
                self.listener=listener
                threading.Thread(target=listener.serve_forever,daemon=True).start()
            except Exception:
                self.listener=None
                self.owner=None
                self.password=self.project=self.url=''
                listener.server_close()
                raise
            return self.status(owner)

    def rotate(self,owner):
        with self.lock:
            self.require_owner(owner)
            if not self.listener: raise ProjectError('尚未开启共享',409)
            self.sessions.clear();self.failures.clear()
            self.password=secrets.token_urlsafe(12)
            return self.status(owner)

    def stop(self,owner=None):
        with self.lock:
            self.require_owner(owner)
            listener=self.listener
            self.listener=None
            self.owner=None
            self.sessions.clear();self.failures.clear()
            self.password=self.project=self.url=''
            result=self.status()
        if listener:
            listener.shutdown()
            listener.server_close()
        return result


def manage_lan(handler):
    def send(status,value):
        handler.respond(status,json.dumps(value,ensure_ascii=False).encode())
    try:
        # Management is only reachable on the original loopback listener.
        host=urlsplit('//'+handler.headers.get('Host','')).hostname
        if host not in ('localhost','127.0.0.1','::1') or handler.client_address[0] not in ('127.0.0.1','::1'):
            raise ProjectError('请在主机上管理共享',403)
        store=handler.project_workspace()
        owner=handler.workspace_scope
        access=handler.server.lan
        if handler.command=='GET':
            if urlsplit(handler.path).path=='/api/lan/certificate':
                cert=access.directory/'prism-lan-ca.crt'
                if not cert.is_file():raise ProjectError('请先开启局域网共享',404)
                handler.respond(200,cert.read_bytes(),'application/x-x509-ca-cert')
            else: send(200,access.status(owner))
            return
        if handler.headers.get_content_type()!='application/json':
            raise ProjectError('共享参数无效')
        size=int(handler.headers.get('Content-Length',0))
        if not 0<size<=4096:raise ProjectError('共享参数无效')
        payload=json.loads(handler.rfile.read(size))
        if not isinstance(payload,dict): raise ProjectError('共享参数无效')
        action=payload.get('action')
        if action=='start' and isinstance(payload.get('projectId'),str) and PROJECT_ID.fullmatch(payload['projectId']):
            value=access.enable(payload['projectId'],store,owner)
        elif action=='rotate': value=access.rotate(owner)
        elif action=='stop': value=access.stop(owner)
        else: raise ProjectError('共享操作无效')
        send(200,value)
    except ProjectError as exc:
        send(exc.status,{'error':str(exc)})
    except ImportError:
        send(503,{'error':'本机缺少 TLS 证书组件，请安装 editor/requirements.txt 后重启服务。'})
    except OSError:
        send(503,{'error':'无法启动局域网监听或读取证书，请检查网络和本机存储。'})
    except (TypeError,ValueError):
        send(400,{'error':'共享参数或本机证书无效。'})
