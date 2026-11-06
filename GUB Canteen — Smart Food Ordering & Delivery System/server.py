"""GUB Canteen campus prototype backend: Python 3.9+, standard library only.
Run `python server.py --create-owner` once; then `python server.py`.
Student ID self-reported. No payment settlement, identity validation, or canteen POS integration.
For real production: HTTPS, stronger user verification, backups, monitoring, and external security review.
"""
import argparse
import base64
import csv
import getpass
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / 'canteen.db'
HOST = os.getenv('GUB_HOST', '127.0.0.1')
PORT = int(os.getenv('GUB_PORT', '8000'))
UPLOAD_DIR = BASE / 'uploads'
SESSION_DAYS = 7
VALID_BUILDINGS = {'Main Building', 'NX Building', 'Other GUB Campus Building'}
CATEGORIES = ('Meals', 'Breakfast', 'Chicken', 'Snacks', 'Beverages', 'Cakes', 'Biscuits')
DEFAULT_SETTINGS = {'base_fee': '15', 'step_fee': '5', 'items_per_tier': '2', 'platform_percent': '33.33333333333333'}
LOGIN_ATTEMPTS = {}
ATTEMPT_LOCK = threading.Lock()
MAX_IMAGE_BYTES = 2 * 1024 * 1024


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=10000')
    return db


def add_column(db, table, column, definition):
    names = {r['name'] for r in db.execute(f'PRAGMA table_info({table})')}
    if column not in names:
        db.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')


def initialize():
    UPLOAD_DIR.mkdir(exist_ok=True)
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL, student_id TEXT UNIQUE NOT NULL, phone TEXT NOT NULL,
              salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              csrf TEXT NOT NULL, expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orders (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              buyer_id INTEGER NOT NULL REFERENCES users(id),
              courier_id INTEGER REFERENCES users(id),
              status TEXT NOT NULL CHECK(status IN ('placed','accepted','picked_up','delivered','cancelled')),
              building TEXT NOT NULL, floor TEXT NOT NULL, room TEXT NOT NULL, notes TEXT NOT NULL,
              food_total INTEGER NOT NULL, delivery_fee INTEGER NOT NULL,
              platform_share INTEGER NOT NULL, courier_share INTEGER NOT NULL,
              total INTEGER NOT NULL, quantity INTEGER NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS order_items (
              order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
              item_id TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL,
              PRIMARY KEY(order_id, item_id)
            );
            CREATE TABLE IF NOT EXISTS menu_items (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0),
              category TEXT NOT NULL, image TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
              available INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
              sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS audit_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '',
              target_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS order_status ON orders(status,created_at);
            CREATE INDEX IF NOT EXISTS order_buyer ON orders(buyer_id);
            CREATE INDEX IF NOT EXISTS order_courier ON orders(courier_id);
            CREATE INDEX IF NOT EXISTS audit_created ON audit_logs(created_at DESC);
            CREATE INDEX IF NOT EXISTS menu_category ON menu_items(category,sort_order);
        ''')
        for col, definition in (
            ('role', "TEXT NOT NULL DEFAULT 'student'"),
            ('active', 'INTEGER NOT NULL DEFAULT 1'),
            ('last_login_at', 'TEXT'),
            ('last_seen_at', 'TEXT')
        ):
            add_column(db, 'users', col, definition)
        add_column(db, 'sessions', 'last_seen_at', 'TEXT')
        for k, v in DEFAULT_SETTINGS.items():
            db.execute('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', (k, v))
        if db.execute('SELECT count(*) FROM menu_items').fetchone()[0] == 0:
            original = json.loads((BASE / 'menu.json').read_text(encoding='utf-8'))
            now = utc_now()
            for i, m in enumerate(original):
                db.execute('''INSERT INTO menu_items(id,name,price,category,image,tag,available,sort_order,created_at,updated_at)
                              VALUES(?,?,?,?,?,?,?,?,?,?)''',
                           (m['id'], m['name'], m['price'], m['category'], m.get('image', ''),
                            m.get('tag',''), 1, i, now, now))
            # Suggested products are hidden until the owner confirms canteen pricing & availability.
            drafts = [
              ('Milk Tea', 15, 'Beverages'), ('Black Tea', 10, 'Beverages'),
              ('Coffee', 30, 'Beverages'), ('Bottled Water (500ml)', 20, 'Beverages'),
              ('Soft Drink', 30, 'Beverages'), ('Chocolate Cake Slice', 60, 'Cakes'),
              ('Vanilla Cake Slice', 50, 'Cakes'), ('Plain Cake', 40, 'Cakes'),
              ('Butter Biscuit Pack', 20, 'Biscuits'), ('Cream Biscuit Pack', 20, 'Biscuits'),
              ('Chocolate Biscuit Pack', 25, 'Biscuits')
            ]
            for i, (name, price, category) in enumerate(drafts, len(original)):
                ident = 'draft-' + re.sub(r'[^a-z0-9]+','-',name.lower()).strip('-')
                db.execute('''INSERT INTO menu_items(id,name,price,category,image,tag,available,sort_order,created_at,updated_at)
                              VALUES(?,?,?,?,?,?,?,?,?,?)''',
                           (ident, name, price, category, '', 'Price to verify', 0, i, now, now))
        db.execute('DELETE FROM sessions WHERE expires_at<?', (utc_now(),))


def pass_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), 240000).hex()


def settings_json(db):
    s = {r['key']:r['value'] for r in db.execute('SELECT key,value FROM settings')}
    return {'base_fee': int(s['base_fee']), 'step_fee': int(s['step_fee']),
            'items_per_tier':int(s['items_per_tier']),
            'platform_percent': float(s['platform_percent'])}


def cost_split(quantity, db):
    s = settings_json(db)
    fee = s['base_fee'] + s['step_fee'] * ((quantity-1)//s['items_per_tier'])
    share = int((Decimal(fee) * Decimal(str(s['platform_percent']))/Decimal(100)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    return fee, share, fee-share


def audit(db, actor, action, target_type='', target_id='', detail=''):
    db.execute('''INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at)
                  VALUES(?,?,?,?,?,?)''', (actor, action, target_type, str(target_id), str(detail)[:240], utc_now()))


def check_attempts(name):
    now = datetime.now(timezone.utc).timestamp()
    with ATTEMPT_LOCK:
        attempts = [t for t in LOGIN_ATTEMPTS.get(name, []) if now - t < 300]
        LOGIN_ATTEMPTS[name] = attempts
        if len(attempts) >= 8:
            raise APIError(429, 'Too many login attempts. Retry in five minutes.')


def failed_attempt(name):
    with ATTEMPT_LOCK:
        LOGIN_ATTEMPTS.setdefault(name, []).append(datetime.now(timezone.utc).timestamp())


def cleared_attempts(name):
    with ATTEMPT_LOCK:
        LOGIN_ATTEMPTS.pop(name, None)


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args, directory=str(BASE), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        super().end_headers()

    def static_route(self):
        path = urlparse(self.path).path
        allowed = {'/','/index.html','/admin.html','/style.css','/main.js','/admin.js','/admin.css','/menu.json','/favicon.svg'}
        if path == '/':
            self.path='/index.html'; return True
        if path in allowed:
            self.path=path; return True
        if re.fullmatch(r'/images/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp|svg)', path):
            self.path=path;return True
        if re.fullmatch(r'/uploads/[a-f0-9]{32}\.(?:jpg|png|webp)', path):
            self.path=path;return True
        self.send_error(HTTPStatus.NOT_FOUND)
        return False

    def do_GET(self):
        path=urlparse(self.path).path
        if path.startswith('/api/'):
            return self.api('GET',path)
        if self.static_route():
            return super().do_GET()

    def do_HEAD(self):
        if self.static_route():
            return super().do_HEAD()

    def do_POST(self):
        path=urlparse(self.path).path
        if not path.startswith('/api/'):
            self.send_error(HTTPStatus.NOT_FOUND);return
        return self.api('POST',path)

    def send_json(self, status, payload, cookie=None):
        # Commit before sending HTTP headers: clients may make an immediate follow-up
        # request, otherwise login sessions can appear missing in another thread.
        active_db=getattr(self,'_request_db',None)
        if status < 400 and active_db is not None and active_db.in_transaction:
            active_db.commit()
        data=json.dumps(payload,ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(data)))
        if cookie:self.send_header('Set-Cookie',cookie)
        self.end_headers()
        self.wfile.write(data)

    def send_csv(self, filename, columns, rows):
        active_db=getattr(self,'_request_db',None)
        if active_db is not None and active_db.in_transaction:
            active_db.commit()
        output=io.StringIO()
        writer=csv.writer(output)
        writer.writerow(columns)
        for row in rows:
            writer.writerow([str(v) if v is not None else '' for v in row])
        # UTF-8 BOM supports Excel import. Excel formula injection protection.
        content='\ufeff'+output.getvalue()
        raw=content.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type','text/csv; charset=utf-8')
        self.send_header('Content-Disposition',f'attachment; filename="{filename}"')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(raw)))
        self.end_headers();self.wfile.write(raw)

    def read_json(self):
        try:
            n=int(self.headers.get('Content-Length','0'))
            if n<2 or n>3_000_000:raise APIError(413,'Request too large or empty.')
            data=json.loads(self.rfile.read(n))
            if not isinstance(data,dict):raise ValueError('JSON object required')
            return data
        except (ValueError,TypeError,UnicodeDecodeError):
            raise APIError(400,'Invalid JSON request.')

    def session(self,db):
        c=SimpleCookie()
        try:c.load(self.headers.get('Cookie',''))
        except Exception:return None
        raw=c.get('gub_session')
        if not raw:return None
        user=db.execute('''SELECT s.csrf,s.token,s.last_seen_at AS session_seen,
            u.id,u.name,u.student_id,u.phone,u.role,u.active,u.last_login_at
            FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token=? AND s.expires_at>? AND u.active=1''',(raw.value,utc_now())).fetchone()
        if user:
            now=utc_now()
            if not user['session_seen'] or user['session_seen'] < (datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat():
                db.execute('UPDATE sessions SET last_seen_at=? WHERE token=?',(now,user['token']))
                db.execute('UPDATE users SET last_seen_at=? WHERE id=?',(now,user['id']))
        return user

    def require(self,db,method,role='student'):
        u=self.session(db)
        if not u:raise APIError(401,'Please sign in first.')
        if method=='POST' and not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),u['csrf']):
            raise APIError(403,'Security token missing. Refresh the page.')
        if role=='student' and u['role']!='student':
            raise APIError(403,'Use a student account for ordering/delivery.')
        if role=='admin' and u['role'] not in ('admin','owner'):
            raise APIError(403,'Admin access required.')
        if role=='owner' and u['role']!='owner':
            raise APIError(403,'Owner access required.')
        return u

    def check_origin(self):
        origin=self.headers.get('Origin','')
        if not origin:return
        host=self.headers.get('Host','')
        if origin.rstrip('/') not in (f'http://{host}',f'https://{host}'):
            raise APIError(403,'Cross-origin request blocked.')

    def make_session(self,db,user_id):
        token, csrf=secrets.token_urlsafe(32),secrets.token_urlsafe(24)
        expiry=(datetime.now(timezone.utc)+timedelta(days=SESSION_DAYS)).isoformat()
        now=utc_now()
        db.execute('''INSERT INTO sessions(token,user_id,csrf,expires_at,last_seen_at)
                       VALUES(?,?,?,?,?)''',(token,user_id,csrf,expiry,now))
        db.execute('UPDATE users SET last_login_at=?,last_seen_at=? WHERE id=?',(now,now,user_id))
        secure = '; Secure' if os.getenv('GUB_HTTPS','')=='1' else ''
        return csrf,f'gub_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_DAYS*86400}{secure}'

    def user_json(self,u):
        return {'id':u['id'],'name':u['name'],'student_id':u['student_id'], 'phone':u['phone'], 'role':u['role']}

    def public_menu(self,db):
        return [dict(r) for r in db.execute('''SELECT id,name,price,category,image,tag,available
                FROM menu_items WHERE available=1 AND archived=0 ORDER BY sort_order,id''')]

    def full_order(self,db,r,full=False):
        o=dict(r)
        o['items']=[dict(x) for x in db.execute('SELECT item_id,name,price,quantity FROM order_items WHERE order_id=?',(o['id'],))]
        if full:
            o['buyer']=dict(db.execute('SELECT name,student_id,phone FROM users WHERE id=?',(o['buyer_id'],)).fetchone())
            if o['courier_id']:
                courier=db.execute('SELECT name,student_id,phone FROM users WHERE id=?',(o['courier_id'],)).fetchone()
                o['courier']=dict(courier) if courier else None
        else:
            o.pop('buyer_id',None)
        return o

    def authenticate(self,db,b,admin=False):
        sid=str(b.get('student_id','')).strip()
        password=str(b.get('password',''))
        key=('admin:' if admin else 'student:')+sid
        check_attempts(key)
        u=db.execute('SELECT * FROM users WHERE student_id=?',(sid,)).fetchone()
        if (not u or not u['active'] or (admin and u['role'] not in ('admin','owner'))
                or (not admin and u['role']!='student')
                or not hmac.compare_digest(pass_hash(password,u['salt']),u['password_hash'])):
            failed_attempt(key)
            raise APIError(401,'Invalid credentials or account is disabled.')
        cleared_attempts(key)
        csrf,cookie=self.make_session(db,u['id'])
        audit(db,u['id'],'admin_login' if admin else 'student_login','user',u['id'])
        return self.send_json(200,{'user':self.user_json(u),'csrf':csrf},cookie)

    def api(self,method,route):
        try:
            if method=='POST':self.check_origin()
            with connect() as db:
                self._request_db=db
                if method=='GET' and route=='/api/menu':
                    return self.send_json(200,{'menu':self.public_menu(db),'categories':list(CATEGORIES)})
                if method=='GET' and route=='/api/config':
                    return self.send_json(200,{'config':settings_json(db)})
                if method=='GET' and route=='/api/me':
                    u=self.session(db)
                    return self.send_json(200,{'user':self.user_json(u) if u else None,'csrf':u['csrf'] if u else None,'mode':'server'})
                if method=='POST' and route=='/api/register':
                    b=self.read_json()
                    name=str(b.get('name','')).strip()[:70]
                    sid=str(b.get('student_id','')).strip()
                    phone=str(b.get('phone','')).strip()
                    pw=str(b.get('password',''))
                    if not 2<=len(name)<=70 or not re.fullmatch(r"[A-Za-zÀ-ÿ\u0980-\u09FF .'\-]+",name):
                        raise APIError(400,'Enter a valid full name.')
                    if not re.fullmatch(r'\d{6,15}',sid):
                        raise APIError(400,'Student ID must contain 6–15 digits.')
                    if not re.fullmatch(r'(?:\+?88)?01[3-9]\d{8}',phone):
                        raise APIError(400,'Enter a valid Bangladeshi phone number.')
                    if not 8<=len(pw)<=128:raise APIError(400,'Password must have 8–128 characters.')
                    salt=secrets.token_hex(16)
                    try:
                        cur=db.execute('''INSERT INTO users(name,student_id,phone,salt,password_hash,created_at,role)
                           VALUES(?,?,?,?,?,?,'student')''',(name,sid,phone,salt,pass_hash(pw,salt),utc_now()))
                    except sqlite3.IntegrityError:raise APIError(409,'Student ID already registered.')
                    csrf,cookie=self.make_session(db,cur.lastrowid)
                    audit(db,cur.lastrowid,'register','user',cur.lastrowid)
                    u=db.execute('SELECT * FROM users WHERE id=?',(cur.lastrowid,)).fetchone()
                    return self.send_json(201,{'user':self.user_json(u),'csrf':csrf},cookie)
                if method=='POST' and route in ('/api/login','/api/admin/login'):
                    return self.authenticate(db,self.read_json(),route=='/api/admin/login')
                if method=='POST' and route=='/api/logout':
                    u=self.require(db,method,'any')
                    audit(db,u['id'],'logout','user',u['id'])
                    db.execute('DELETE FROM sessions WHERE token=?',(u['token'],))
                    return self.send_json(200,{'ok':True},'gub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
                if route.startswith('/api/admin/'):
                    return self.admin_api(db,method,route)
                if method=='GET' and route=='/api/orders':
                    u=self.require(db,method)
                    rows=db.execute('''SELECT * FROM orders WHERE buyer_id=? OR courier_id=? ORDER BY id DESC LIMIT 100''',(u['id'],u['id'])).fetchall()
                    return self.send_json(200,{'orders':[self.full_order(db,r,True) for r in rows]})
                if method=='GET' and route=='/api/jobs':
                    u=self.require(db,method)
                    rows=db.execute('''SELECT * FROM orders WHERE status='placed' AND buyer_id<>? ORDER BY id ASC LIMIT 80''',(u['id'],)).fetchall()
                    return self.send_json(200,{'jobs':[self.full_order(db,r,False) for r in rows]})
                if method=='POST' and route=='/api/orders':
                    u=self.require(db,method)
                    b=self.read_json(); entries=b.get('items')
                    if not isinstance(entries,list) or not 1<=len(entries)<=30:
                        raise APIError(400,'Add food items first.')
                    clean={}
                    for entry in entries:
                        if not isinstance(entry,dict) or not isinstance(entry.get('id'),str):
                            raise APIError(400,'Invalid item.')
                        item_id=entry['id'];q=entry.get('quantity')
                        if type(q)!=int or not 1<=q<=20:raise APIError(400,'Item quantity must be 1–20.')
                        clean[item_id]=clean.get(item_id,0)+q
                    qty=sum(clean.values())
                    if qty>50:raise APIError(400,'Maximum 50 items per order.')
                    buildings=str(b.get('building','')).strip(); floor=str(b.get('floor','')).strip()
                    room=str(b.get('room','')).strip()[:40];notes=str(b.get('notes','')).strip()[:250]
                    if buildings not in VALID_BUILDINGS or not re.fullmatch(r'(?:G|[0-9]|1[0-9]|B[1-3])',floor) or not 1<=len(room)<=40:
                        raise APIError(400,'Enter a valid building, floor and room.')
                    db.execute('BEGIN IMMEDIATE')
                    items={r['id']:r for r in db.execute('SELECT * FROM menu_items WHERE available=1 AND archived=0')}
                    if any(i not in items for i in clean):raise APIError(409,'An item is no longer available. Refresh menu.')
                    food=sum(items[i]['price']*q for i,q in clean.items())
                    fee,platform,courier=cost_split(qty,db)
                    now=utc_now()
                    cur=db.execute('''INSERT INTO orders(buyer_id,status,building,floor,room,notes,
                      food_total,delivery_fee,platform_share,courier_share,total,quantity,created_at,updated_at)
                      VALUES(?,'placed',?,?,?,?,?,?,?,?,?,?,?,?)''',
                      (u['id'],buildings,floor,room,notes,food,fee,platform,courier,food+fee,qty,now,now))
                    oid=cur.lastrowid
                    for i,q in clean.items():
                        item=items[i]
                        db.execute('INSERT INTO order_items VALUES(?,?,?,?,?)',(oid,i,item['name'],item['price'],q))
                    audit(db,u['id'],'order_placed','order',oid,f'{qty} items; delivery {fee}; platform {platform}; rider {courier}')
                    return self.send_json(201,{'order':self.full_order(db,db.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone(),True)})
                m=re.fullmatch(r'/api/orders/(\d+)/cancel',route)
                if method=='POST' and m:
                    u=self.require(db,method);oid=int(m.group(1))
                    db.execute('BEGIN IMMEDIATE')
                    cur=db.execute('''UPDATE orders SET status='cancelled',updated_at=?
                        WHERE id=? AND buyer_id=? AND status='placed' ''',(utc_now(),oid,u['id']))
                    if cur.rowcount!=1:raise APIError(409,'Only your unaccepted orders can be cancelled.')
                    audit(db,u['id'],'order_cancelled','order',oid)
                    return self.send_json(200,{'ok':True})
                m=re.fullmatch(r'/api/jobs/(\d+)/(accept|pickup|deliver)',route)
                if method=='POST' and m:
                    u=self.require(db,method);oid=int(m.group(1));action=m.group(2)
                    db.execute('BEGIN IMMEDIATE')
                    if action=='accept':
                        cur=db.execute('''UPDATE orders SET status='accepted',courier_id=?,updated_at=?
                            WHERE id=? AND status='placed' AND buyer_id<>?''',(u['id'],utc_now(),oid,u['id']))
                    else:
                        old,new=('accepted','picked_up') if action=='pickup' else ('picked_up','delivered')
                        cur=db.execute('''UPDATE orders SET status=?,updated_at=? WHERE id=? AND courier_id=? AND status=?''',
                                       (new,utc_now(),oid,u['id'],old))
                    if cur.rowcount!=1:raise APIError(409,'This job is unavailable or action is not allowed.')
                    audit(db,u['id'],'delivery_'+action,'order',oid)
                    return self.send_json(200,{'order':self.full_order(db,db.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone(),True)})
                raise APIError(404,'API route not found.')
        except APIError as e:
            return self.send_json(e.status,{'error':e.message})
        except (BrokenPipeError, ConnectionResetError):
            return
        except sqlite3.Error as e:
            print('Database error:',e)
            return self.send_json(500,{'error':'Database error. Try again.'})

    def admin_api(self,db,method,route):
        u=self.require(db,method,'admin')
        params=parse_qs(urlparse(self.path).query)
        def paging(maxsize=200):
            try:
                limit=min(max(1,int(params.get('limit',['100'])[0])),maxsize)
                offset=max(0,int(params.get('offset',['0'])[0]))
            except ValueError:raise APIError(400,'Invalid pagination.')
            return limit,offset
        if method=='POST' and route=='/api/admin/change-password':
            b=self.read_json()
            old=str(b.get('current_password',''))
            pw=str(b.get('new_password',''))
            if len(pw)<12 or len(pw)>128:
                raise APIError(400,'New password must be 12–128 characters.')
            record=db.execute('SELECT salt,password_hash FROM users WHERE id=?',(u['id'],)).fetchone()
            if not hmac.compare_digest(pass_hash(old,record['salt']),record['password_hash']):
                raise APIError(403,'Current password is incorrect.')
            salt=secrets.token_hex(16)
            db.execute('UPDATE users SET salt=?,password_hash=? WHERE id=?',(salt,pass_hash(pw,salt),u['id']))
            db.execute('DELETE FROM sessions WHERE user_id=? AND token<>?',(u['id'],u['token']))
            audit(db,u['id'],'password_changed','user',u['id'])
            return self.send_json(200,{'ok':True})
        if method=='GET' and route=='/api/admin/summary':
            stats={}
            stats['users']=db.execute("SELECT count(*) FROM users WHERE role='student'").fetchone()[0]
            stats['online']=db.execute('''SELECT count(DISTINCT s.user_id) FROM sessions s JOIN users u ON s.user_id=u.id
                WHERE s.last_seen_at>=? AND s.expires_at>? AND u.active=1''',
                ((datetime.now(timezone.utc)-timedelta(minutes=5)).isoformat(),utc_now())).fetchone()[0]
            stats['orders']=db.execute('SELECT count(*) FROM orders').fetchone()[0]
            stats['live_orders']=db.execute("SELECT count(*) FROM orders WHERE status IN ('placed','accepted','picked_up')").fetchone()[0]
            stats['delivered']=db.execute("SELECT count(*) FROM orders WHERE status='delivered'").fetchone()[0]
            stats['cancelled']=db.execute("SELECT count(*) FROM orders WHERE status='cancelled'").fetchone()[0]
            stats['food_value']=db.execute("SELECT coalesce(sum(food_total),0) FROM orders WHERE status='delivered'").fetchone()[0]
            stats['platform_earned']=db.execute("SELECT coalesce(sum(platform_share),0) FROM orders WHERE status='delivered'").fetchone()[0]
            stats['rider_earned']=db.execute("SELECT coalesce(sum(courier_share),0) FROM orders WHERE status='delivered'").fetchone()[0]
            stats['today_logins']=db.execute("SELECT count(*) FROM audit_logs WHERE action IN ('student_login','admin_login') AND created_at>=?",
                (datetime.now(timezone.utc).date().isoformat(),)).fetchone()[0]
            stats['menu_active']=db.execute('SELECT count(*) FROM menu_items WHERE available=1 AND archived=0').fetchone()[0]
            stats['menu_draft']=db.execute('SELECT count(*) FROM menu_items WHERE available=0 AND archived=0').fetchone()[0]
            last=db.execute('''SELECT o.*,buyer.name AS buyer_name,courier.name AS courier_name
                FROM orders o JOIN users buyer ON buyer.id=o.buyer_id
                LEFT JOIN users courier ON courier.id=o.courier_id ORDER BY o.id DESC LIMIT 6''').fetchall()
            daily=db.execute('''SELECT substr(created_at,1,10) AS day,count(*) AS count
                FROM orders WHERE created_at>=? GROUP BY day ORDER BY day''',
                ((datetime.now(timezone.utc)-timedelta(days=6)).date().isoformat(),)).fetchall()
            return self.send_json(200,{'stats':stats,'recent_orders':[dict(r) for r in last],'daily':[dict(r) for r in daily]})
        if method=='GET' and route=='/api/admin/menu':
            rows=db.execute('''SELECT * FROM menu_items WHERE archived=0 ORDER BY category,sort_order,id''').fetchall()
            return self.send_json(200,{'menu':[dict(r) for r in rows],'categories':list(CATEGORIES)})
        if method=='POST' and route=='/api/admin/upload':
            b=self.read_json()
            data=b.get('data','')
            if not isinstance(data,str) or len(data)>2_850_000:raise APIError(413,'Image is too large (max 2MB).')
            try: raw=base64.b64decode(data,validate=True)
            except Exception:raise APIError(400,'Invalid image encoding.')
            if len(raw)>MAX_IMAGE_BYTES or len(raw)<20:raise APIError(413,'Choose an image between 20 bytes and 2MB.')
            ext=None
            if raw.startswith(b'\xff\xd8\xff'):ext='jpg'
            elif raw.startswith(b'\x89PNG\r\n\x1a\n'):ext='png'
            elif raw.startswith(b'RIFF') and raw[8:12]==b'WEBP':ext='webp'
            if not ext:raise APIError(400,'Only JPEG, PNG, or WebP images are supported.')
            filename=secrets.token_hex(16)+'.'+ext
            (UPLOAD_DIR/filename).write_bytes(raw)
            audit(db,u['id'],'image_uploaded','image',filename)
            return self.send_json(201,{'image':'/uploads/'+filename})
        m=re.fullmatch(r'/api/admin/menu/([a-z0-9_-]+)',route)
        if method=='POST' and (route=='/api/admin/menu' or m):
            b=self.read_json()
            name=str(b.get('name','')).strip()
            tag=str(b.get('tag','')).strip()
            category=str(b.get('category','')).strip()
            price=b.get('price')
            image=str(b.get('image','')).strip()
            available=b.get('available')
            if not 2<=len(name)<=85 or not 1<=len(category)<=35 or len(tag)>65:
                raise APIError(400,'Enter a valid name, category and short tag.')
            if type(price)!=int or not 0<=price<=100000:raise APIError(400,'Price must be a whole Taka amount.')
            if type(available)!=bool:raise APIError(400,'Availability must be true or false.')
            if image and not (re.fullmatch(r'/uploads/[a-f0-9]{32}\.(?:jpg|png|webp)',image) or
                re.fullmatch(r'[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)',image)):
                raise APIError(400,'Invalid image reference.')
            if image and not (BASE / image.lstrip('/') if image.startswith('/') else BASE/'images'/image).is_file():
                raise APIError(400,'Image file not found.')
            db.execute('BEGIN IMMEDIATE')
            now=utc_now()
            if m:
                ident=m.group(1)
                cur=db.execute('''UPDATE menu_items SET name=?,price=?,category=?,image=?,tag=?,available=?,updated_at=?
                    WHERE id=? AND archived=0''',(name,price,category,image,tag,int(available),now,ident))
                if not cur.rowcount:raise APIError(404,'Menu item not found.')
                action='menu_updated'
            else:
                ident='item-'+secrets.token_hex(6)
                order=db.execute('SELECT coalesce(max(sort_order),0)+1 FROM menu_items').fetchone()[0]
                db.execute('''INSERT INTO menu_items(id,name,price,category,image,tag,available,sort_order,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)''',(ident,name,price,category,image,tag,int(available),order,now,now))
                action='menu_created'
            audit(db,u['id'],action,'menu',ident,name)
            return self.send_json(200,{'item':dict(db.execute('SELECT * FROM menu_items WHERE id=?',(ident,)).fetchone())})
        m=re.fullmatch(r'/api/admin/menu/([a-z0-9_-]+)/delete',route)
        if method=='POST' and m:
            ident=m.group(1)
            cur=db.execute('UPDATE menu_items SET archived=1,available=0,updated_at=? WHERE id=? AND archived=0',(utc_now(),ident))
            if not cur.rowcount:raise APIError(404,'Menu item not found.')
            audit(db,u['id'],'menu_archived','menu',ident)
            return self.send_json(200,{'ok':True})
        if method=='GET' and route=='/api/admin/orders':
            limit,offset=paging()
            status=params.get('status',['all'])[0]
            find=params.get('q',[''])[0].strip()[:80]
            sql='SELECT o.* FROM orders o JOIN users b ON o.buyer_id=b.id WHERE 1=1'
            args=[]
            if status!='all':
                if status not in ('placed','accepted','picked_up','delivered','cancelled'):
                    raise APIError(400,'Unknown order status.')
                sql+=' AND o.status=?';args.append(status)
            if find:
                sql+=' AND (CAST(o.id AS TEXT) LIKE ? OR b.name LIKE ? OR b.student_id LIKE ?)'
                args.extend(['%'+find+'%']*3)
            total=db.execute('SELECT count(*) '+sql[sql.index('FROM orders'):],args).fetchone()[0]
            rows=db.execute(sql+' ORDER BY o.id DESC LIMIT ? OFFSET ?',args+[limit,offset]).fetchall()
            return self.send_json(200,{'orders':[self.full_order(db,r,True) for r in rows], 'total':total})
        m=re.fullmatch(r'/api/admin/orders/(\d+)/action',route)
        if method=='POST' and m:
            b=self.read_json();action=str(b.get('action',''))
            reason=str(b.get('reason','')).strip()[:160]
            oid=int(m.group(1))
            db.execute('BEGIN IMMEDIATE')
            o=db.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
            if not o:raise APIError(404,'Order not found.')
            if action=='cancel' and o['status'] in ('placed','accepted','picked_up'):
                if len(reason)<5:raise APIError(400,'Provide a reason for cancellation.')
                db.execute('UPDATE orders SET status=?,updated_at=? WHERE id=?',('cancelled',utc_now(),oid))
            elif action=='reopen' and o['status']=='cancelled':
                db.execute("UPDATE orders SET status='placed',courier_id=NULL,updated_at=? WHERE id=?",(utc_now(),oid))
            elif action=='unassign' and o['status']=='accepted':
                db.execute("UPDATE orders SET status='placed',courier_id=NULL,updated_at=? WHERE id=?",(utc_now(),oid))
            elif action=='assign' and o['status'] in ('placed','accepted'):
                try:rid=int(b.get('courier_id'))
                except (TypeError,ValueError):raise APIError(400,'Select a student courier.')
                courier=db.execute("SELECT * FROM users WHERE id=? AND role='student' AND active=1",(rid,)).fetchone()
                if not courier or rid==o['buyer_id']:raise APIError(400,'Choose an active student other than the buyer.')
                db.execute("UPDATE orders SET status='accepted',courier_id=?,updated_at=? WHERE id=?",(rid,utc_now(),oid))
            elif action=='complete' and o['status'] in ('accepted','picked_up') and o['courier_id']:
                if len(reason)<5:raise APIError(400,'Provide a reason for the delivery override.')
                db.execute("UPDATE orders SET status='delivered',updated_at=? WHERE id=?",(utc_now(),oid))
            else:
                raise APIError(409,'This action is not valid for the current order status.')
            audit(db,u['id'],'admin_order_'+action,'order',oid,reason or ('courier '+str(b.get('courier_id')) if action=='assign' else ''))
            return self.send_json(200,{'order':self.full_order(db,db.execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone(),True)})
        if method=='GET' and route=='/api/admin/users':
            limit,offset=paging()
            find=params.get('q',[''])[0].strip()[:80]
            args=[];where=' WHERE 1=1'
            if find:
                where+=' AND (u.name LIKE ? OR u.student_id LIKE ? OR u.phone LIKE ?)'
                args=['%'+find+'%']*3
            total=db.execute('SELECT count(*) FROM users u'+where,args).fetchone()[0]
            rows=db.execute('''SELECT u.id,u.name,u.student_id,u.phone,u.role,u.active,u.created_at,
              u.last_login_at,u.last_seen_at,(SELECT count(*) FROM orders WHERE buyer_id=u.id) AS orders_count,
              (SELECT count(*) FROM orders WHERE courier_id=u.id AND status='delivered') AS deliveries_count
              FROM users u'''+where+' ORDER BY u.id DESC LIMIT ? OFFSET ?',args+[limit,offset]).fetchall()
            return self.send_json(200,{'users':[dict(x) for x in rows],'total':total})
        m=re.fullmatch(r'/api/admin/users/(\d+)/(toggle|role)',route)
        if method=='POST' and m:
            uid=int(m.group(1));action=m.group(2)
            target=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
            if not target:raise APIError(404,'User not found.')
            if uid==u['id'] or target['role']=='owner':raise APIError(403,'Cannot change this account.')
            if action=='toggle':
                # Only owner may disable/promote a staff account.
                if target['role']=='admin' and u['role']!='owner':raise APIError(403,'Only owner can manage staff.')
                active=0 if target['active'] else 1
                db.execute('UPDATE users SET active=? WHERE id=?',(active,uid))
                if not active:db.execute('DELETE FROM sessions WHERE user_id=?',(uid,))
                audit(db,u['id'],'user_'+('enabled' if active else 'disabled'),'user',uid)
            else:
                if u['role']!='owner':raise APIError(403,'Only owner can manage staff roles.')
                b=self.read_json();role=b.get('role')
                if role not in ('student','admin'):raise APIError(400,'Role must be student or admin.')
                db.execute('UPDATE users SET role=? WHERE id=?',(role,uid))
                db.execute('DELETE FROM sessions WHERE user_id=?',(uid,))
                audit(db,u['id'],'user_role_changed','user',uid,role)
            return self.send_json(200,{'ok':True})
        if method=='GET' and route=='/api/admin/activity':
            limit,offset=paging(300)
            rows=db.execute('''SELECT l.id,l.actor_id,l.action,l.target_type,l.target_id,l.detail,l.created_at,
                u.name AS actor_name,u.student_id AS actor_student_id FROM audit_logs l
                LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.id DESC LIMIT ? OFFSET ?''',(limit,offset)).fetchall()
            total=db.execute('SELECT count(*) FROM audit_logs').fetchone()[0]
            return self.send_json(200,{'logs':[dict(x) for x in rows],'total':total})
        if route=='/api/admin/settings':
            if method=='GET':return self.send_json(200,{'config':settings_json(db)})
            self.require(db,method,'owner')
            b=self.read_json()
            vals={}
            for k,minimum,maximum in [('base_fee',0,1000),('step_fee',0,1000),('items_per_tier',1,20)]:
                v=b.get(k)
                if type(v)!=int or not minimum<=v<=maximum:raise APIError(400,'Invalid '+k)
                vals[k]=str(v)
            try:percent=Decimal(str(b.get('platform_percent')))
            except InvalidOperation:raise APIError(400,'Invalid commission percentage.')
            if not percent.is_finite() or not 0<=percent<=100:
                raise APIError(400,'Commission must be between 0 and 100%.')
            vals['platform_percent']=str(percent)
            for k,v in vals.items():
                db.execute('UPDATE settings SET value=? WHERE key=?',(v,k))
            audit(db,u['id'],'delivery_settings_updated','settings','delivery',json.dumps(vals))
            return self.send_json(200,{'config':settings_json(db)})
        m=re.fullmatch(r'/api/admin/export/(orders|users|activity)',route)
        if method=='GET' and m:
            kind=m.group(1)
            if kind=='orders':
                cols=['Order ID','Buyer ID','Rider ID','Status','Building','Floor','Meeting Point','Food (BDT)','Delivery (BDT)','Platform share (BDT)','Rider share (BDT)','Total (BDT)','Quantity','Created','Updated']
                q='''SELECT id,buyer_id,courier_id,status,building,floor,room,food_total,delivery_fee,
                  platform_share,courier_share,total,quantity,created_at,updated_at FROM orders ORDER BY id DESC'''
            elif kind=='users':
                cols=['ID','Name','Student ID','Phone','Role','Active','Created','Last login','Last seen']
                q='SELECT id,name,student_id,phone,role,active,created_at,last_login_at,last_seen_at FROM users ORDER BY id DESC'
            else:
                cols=['ID','Actor ID','Action','Target type','Target ID','Details','Created']
                q='SELECT id,actor_id,action,target_type,target_id,detail,created_at FROM audit_logs ORDER BY id DESC'
            # Prevent spreadsheet formula injection in exported free-text fields.
            safe=[]
            for r in db.execute(q):
                safe.append(["'"+v if isinstance(v,str) and v[:1] in ('=','+','-','@') else v for v in r])
            return self.send_csv('gub-'+kind+'.csv',cols,safe)
        raise APIError(404,'Admin API route not found.')


def create_owner():
    initialize()
    with connect() as db:
        if db.execute("SELECT 1 FROM users WHERE role='owner'").fetchone():
            print('An owner account already exists. Refusing to create a second owner.');return
        print('Set up the GUB Canteen OWNER. Never reuse your university password.')
        username=input('Owner login name [owner]: ').strip() or 'owner'
        if not re.fullmatch(r'[a-zA-Z0-9_-]{4,32}',username):
            print('Use 4-32 letters, digits, underscores or hyphens.');return
        display=input('Owner display name [Canteen Owner]: ').strip() or 'Canteen Owner'
        pw=getpass.getpass('Create password (minimum 12 characters): ')
        repeat=getpass.getpass('Confirm password: ')
        if len(pw)<12 or pw!=repeat:
            print('Password mismatch or too short; no account created.');return
        salt=secrets.token_hex(16)
        try:
            cur=db.execute('''INSERT INTO users(name,student_id,phone,salt,password_hash,created_at,role,active)
                VALUES(?,?,?,?,?,?,'owner',1)''',(display[:70],username,'',salt,pass_hash(pw,salt),utc_now()))
        except sqlite3.IntegrityError:
            print('Username already used. Choose another.');return
        audit(db,cur.lastrowid,'owner_created','user',cur.lastrowid)
        print('Owner created. Start server and visit http://127.0.0.1:8000/admin.html')


def reset_owner_password():
    initialize()
    with connect() as db:
        owner=db.execute("SELECT id,student_id FROM users WHERE role='owner'").fetchone()
        if not owner:
            print('No owner account exists. Use --create-owner first.');return
        print('Resetting password for owner',owner['student_id'])
        pw=getpass.getpass('New owner password (minimum 12 characters): ')
        repeat=getpass.getpass('Confirm password: ')
        if len(pw)<12 or pw!=repeat:
            print('Password mismatch or too short. Nothing changed.');return
        salt=secrets.token_hex(16)
        db.execute('UPDATE users SET salt=?,password_hash=?,active=1 WHERE id=?',
                   (salt,pass_hash(pw,salt),owner['id']))
        db.execute('DELETE FROM sessions WHERE user_id=?',(owner['id'],))
        audit(db,owner['id'],'owner_password_reset_locally','user',owner['id'])
        print('Owner password reset. Existing owner sessions were revoked.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description='GUB Canteen prototype server')
    parser.add_argument('--create-owner',action='store_true',help='One-time owner account setup')
    parser.add_argument('--reset-owner-password',action='store_true',help='Reset owner password from the server machine')
    args=parser.parse_args()
    if args.create_owner:
        create_owner()
    elif args.reset_owner_password:
        reset_owner_password()
    else:
        initialize()
        server=ThreadingHTTPServer((HOST,PORT),Handler)
        print(f'GUB Canteen: http://{HOST}:{PORT}')
        print(f'Owner dashboard: http://{HOST}:{PORT}/admin.html')
        if not connect().execute("SELECT 1 FROM users WHERE role='owner'").fetchone():
            print('IMPORTANT: Run "python server.py --create-owner" to create the owner account.')
        print('Ctrl+C to stop. SQLite file: canteen.db')
        try:server.serve_forever()
        except KeyboardInterrupt:print('\nStopping server.')
        finally:server.server_close()
