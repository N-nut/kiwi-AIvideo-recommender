import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import hashlib
import sqlite3

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import delete, event, func, inspect, select, text
from sqlalchemy.exc import IntegrityError, OperationalError

from kiwi import auth as auth_module
from kiwi.auth import COOKIE, RateLimiter, token_digest
from kiwi.config import ROOT, Settings
from kiwi.database import Base, CatalogRefresh, Favorite, User, UserSession, Work, initialize, make_database, utc_now
from kiwi.main import create_app

HEADERS = {"Origin": "http://127.0.0.1:8000", "X-Kiwi-Request": "1"}
PASSWORD = "test password 123 "


class FastPasswords:
    """Deterministic test double; production and the real hash test use Argon2id."""
    def hash(self, password):
        return "test$" + hashlib.sha256(password.encode()).hexdigest()
    def verify(self, password, encoded):
        return self.hash(password) == encoded


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(auth_module, "passwords", FastPasswords())
    app = create_app(Settings(ai_mode="baseline", database_url=f"sqlite:///{(tmp_path/'accounts.db').as_posix()}"))
    with TestClient(app, base_url="http://127.0.0.1:8000", headers=HEADERS) as client:
        yield client


def register(client, username="User_A", password=PASSWORD):
    return client.post('/api/v1/auth/register', json={"username": username, "password": password, "confirm_password": password})


def login(client, username="User_A", password=PASSWORD):
    return client.post('/api/v1/auth/login', json={"username": username, "password": password})


def add_work(client, record, id="work-a", status="approved"):
    row = copy.deepcopy(record)
    row.update(id=id, review_status=status, content_hash="a"*64)
    with client.app.state.sessions.begin() as session:
        session.add(Work(**row))


def test_real_argon2id_and_cookie_without_plaintext(tmp_path):
    app = create_app(Settings(ai_mode="baseline", database_url=f"sqlite:///{(tmp_path/'real.db').as_posix()}"))
    with TestClient(app, base_url="http://127.0.0.1:8000", headers=HEADERS) as client:
        result = register(client, "  Test_User  ")
        assert result.status_code == 201
        assert set(result.json()["user"]) == {"id", "username", "nickname", "avatar_id", "avatar_url"}
        assert result.json()["user"]["username"] == "Test_User"
        cookie = result.headers['set-cookie']
        assert 'HttpOnly' in cookie and 'SameSite=lax' in cookie and 'Path=/' in cookie
        assert 'Max-Age=604800' in cookie and 'Domain=' not in cookie and 'Secure' not in cookie
        with app.state.sessions() as session:
            user = session.scalar(select(User))
            assert user.username_key == "test_user" and user.password_hash.startswith("$argon2id$")
            assert "m=65536,t=3,p=4" in user.password_hash
            assert auth_module.passwords.verify(PASSWORD, user.password_hash)
            assert not auth_module.passwords.verify(PASSWORD.strip(), user.password_hash)
            stored = session.scalar(select(UserSession))
            assert stored.token_hash == token_digest(client.cookies[COOKIE])
            assert client.cookies[COOKIE] not in stored.token_hash and PASSWORD not in user.password_hash
        assert PASSWORD not in result.text and 'password_hash' not in result.text


def test_rotation_device_isolation_restart_expiry(accounts):
    assert accounts.get('/api/v1/auth/me').json() == {"user": None}
    user = register(accounts).json()["user"]
    first = accounts.cookies[COOKIE]
    with TestClient(accounts.app, base_url="http://127.0.0.1:8000", headers=HEADERS) as second:
        assert login(second, 'user_a').status_code == 200
        other = second.cookies[COOKIE]
        assert other != first
        assert login(accounts, 'USER_A').status_code == 200
        assert accounts.cookies[COOKIE] != first
        accounts.cookies.set(COOKIE, first, domain='127.0.0.1', path='/')
        assert accounts.get('/api/v1/auth/me').json()['user'] is None
        assert login(accounts).status_code == 200
        token = accounts.cookies[COOKIE]
        restarted = create_app(accounts.app.state.settings)
        with TestClient(restarted, base_url="http://127.0.0.1:8000", headers=HEADERS) as after_restart:
            after_restart.cookies.set(COOKIE, token)
            assert after_restart.get('/api/v1/auth/me').json()['user'] == user
            restarted.state.auth.now = lambda: utc_now()+timedelta(days=7, seconds=1)
            assert after_restart.get('/api/v1/auth/me').json()['user'] is None
            assert after_restart.get('/api/v1/me/favorites').status_code == 401
        result = accounts.post('/api/v1/auth/logout')
        assert result.status_code == 204 and not result.content
        assert 'Max-Age=0' in result.headers['set-cookie'] and 'HttpOnly' in result.headers['set-cookie']
        assert second.get('/api/v1/auth/me').json()['user'] == user
        assert accounts.post('/api/v1/auth/logout').status_code == 204


@pytest.mark.parametrize('name',['ab','a'*21,'中文名','abc-d','a b','ａｂｃ'])
def test_invalid_username(accounts,name):
    result=register(accounts,name)
    assert result.status_code==422 and 'username' in result.json()['error']['fields']


@pytest.mark.parametrize('password',['a'*7,'a'*65])
def test_password_bounds(accounts,password):
    assert register(accounts,password=password).status_code==422


@pytest.mark.parametrize('password',['a'*8,'a'*64,'😀'*8,' '*8])
def test_password_valid_unicode_and_whitespace(accounts,password):
    assert register(accounts,password=password).status_code==201
    assert login(accounts,password=password).status_code==200


def test_username_uniqueness_confirmation_and_safe_errors(accounts,caplog):
    assert register(accounts).status_code==201
    assert register(accounts,' user_a ').status_code==409
    body={'username':'Other','password':PASSWORD,'confirm_password':'different secret'}
    response=accounts.post('/api/v1/auth/register',json=body)
    assert response.status_code==422 and 'confirm_password' in response.json()['error']['fields']
    bad=login(accounts,password='wrong password')
    unknown=login(accounts,'Unknown_123',password='wrong password')
    assert bad.status_code==unknown.status_code==401
    assert bad.json()['error']==unknown.json()['error']
    response=accounts.post('/api/v1/auth/login',json={**body,'user_id':'other','password_hash':'secret'})
    assert response.status_code==422
    for result in [response,bad,unknown]:
        assert result.headers['cache-control']=='no-store' and result.json()['request_id']
        assert PASSWORD not in result.text and 'different secret' not in result.text
    assert PASSWORD not in caplog.text and accounts.cookies[COOKIE] not in caplog.text


WRITES=[('POST','/api/v1/auth/register',{'username':'New','password':PASSWORD,'confirm_password':PASSWORD}),
        ('POST','/api/v1/auth/login',{'username':'New','password':PASSWORD}),
        ('POST','/api/v1/auth/logout',None),('PUT','/api/v1/me/favorites/work-a',None),
        ('DELETE','/api/v1/me/favorites/work-a',None),('POST','/api/v1/me/favorites/import',{'work_ids':['work-a']})]


@pytest.mark.parametrize('method,path,body',WRITES)
@pytest.mark.parametrize('headers',[
    {'Origin':'https://evil.example','X-Kiwi-Request':'1'},
    {'Origin':'http://127.0.0.1.evil.example:8000','X-Kiwi-Request':'1'},
    {'Origin':'http://127.0.0.1:8001','X-Kiwi-Request':'1'},
    {'Origin':'null','X-Kiwi-Request':'1'},
    {'X-Kiwi-Request':'1'}, {'Origin':'http://127.0.0.1:8000'},
    {'Origin':'http://127.0.0.1:8000/path','X-Kiwi-Request':'1'},
    {'Origin':'https://127.0.0.1:8000','X-Kiwi-Request':'1'},
])
def test_every_write_rejects_untrusted_source(accounts,method,path,body,headers):
    accounts.headers.clear()
    response=accounts.request(method,path,json=body,headers=headers)
    assert response.status_code==403
    assert response.headers['cache-control']=='no-store'


@pytest.mark.parametrize('method,path,body',WRITES)
def test_every_write_rejects_form_and_oversize(accounts,method,path,body):
    assert accounts.request(method,path,content='password=private',headers={'Content-Type':'application/x-www-form-urlencoded'}).status_code==403
    assert accounts.request(method,path,content='x'*24001,headers={'Content-Type':'application/json'}).status_code==413


def test_referer_fallback_and_origin_precedence(accounts):
    from kiwi.auth import origin_key
    assert origin_key('http://localhost')==origin_key('http://localhost:80')
    assert origin_key('http://localhost:0') is None
    assert origin_key('https://localhost')==origin_key('https://localhost:443')
    accounts.headers.clear()
    headers={'Referer':'http://127.0.0.1:8000/some/path?x=1','X-Kiwi-Request':'1'}
    assert accounts.post('/api/v1/auth/logout',headers=headers).status_code==204
    assert accounts.post('/api/v1/auth/logout',headers={**headers,'Origin':'null'}).status_code==403
    assert accounts.post('/api/v1/auth/logout',headers={**headers,'Referer':'http://127.0.0.1:8001/'}).status_code==403


def test_limiter_time_capacity_and_hash_bound(accounts):
    now=[100.0];limiter=RateLimiter(10,clock=lambda:now[0])
    for _ in range(5):limiter.take('pair',5,300)
    with pytest.raises(Exception) as exc:limiter.take('pair',5,300)
    assert exc.value.status_code==429 and exc.value.headers['Retry-After']=='300'
    now[0]+=301;limiter.take('pair',5,300)
    reservation=limiter.take('refunded',1,300);limiter.refund(reservation);limiter.take('refunded',1,300)
    for i in range(8):limiter.take(str(i),5,300)
    with pytest.raises(Exception):limiter.take('overflow',5,300)
    auth=accounts.app.state.auth
    with auth.hashing(),auth.hashing():
        response=register(accounts)
        assert response.status_code==429 and response.headers['retry-after']=='2'
    for _ in range(5):assert login(accounts,'nonexistent','wrongpass').status_code==401
    assert login(accounts,'NONEXISTENT','wrongpass').status_code==429
    # IP attempts and registration attempts are separate counters.
    auth.settings.auth_login_ip_limit=1;auth.limiter.entries.clear()
    assert login(accounts,'first','wrongpass').status_code==401
    assert login(accounts,'second','wrongpass').status_code==429
    auth.settings.auth_register_limit=1;auth.limiter.entries.clear()
    assert register(accounts).status_code==201
    assert register(accounts,'another').status_code==429


def test_favorites_auth_scoping_idempotence_pagination_and_import(accounts,record):
    assert accounts.get('/api/v1/me/favorites').status_code==401
    accounts.cookies.set(COOKIE,'forged',domain='127.0.0.1',path='/')
    assert accounts.get('/api/v1/me/favorites/ids').status_code==401
    user_a=register(accounts).json()['user']
    for i in range(14):add_work(accounts,record,f'work-{i:02}')
    add_work(accounts,record,'unavailable','pending')
    assert accounts.put('/api/v1/me/favorites/missing').status_code==404
    assert accounts.put('/api/v1/me/favorites/unavailable').status_code==404
    ids=[f'work-{i:02}' for i in range(14)]
    data=accounts.post('/api/v1/me/favorites/import',json={'work_ids':ids+['work-00','missing','unavailable']}).json()
    assert data=={'requested':17,'unique':16,'added':14,'already_saved':0,'skipped_unavailable':2}
    assert accounts.put('/api/v1/me/favorites/work-00').json()=={'saved':True}
    again=accounts.post('/api/v1/me/favorites/import',json={'work_ids':ids}).json()
    assert again['added']==0 and again['already_saved']==14
    with accounts.app.state.sessions.begin() as session:
        # Equal timestamps verify the stable secondary sort key across pages.
        session.execute(Favorite.__table__.update().values(created_at=utc_now()))
        session.get(Work,'work-13').review_status='pending'
    data=accounts.get('/api/v1/me/favorites').json()
    assert data['total']==13 and data['unavailable_count']==1 and len(data['items'])==12
    assert data['unavailable_ids']==['work-13']
    assert [w['id'] for w in data['items']]==ids[:12]
    assert accounts.get('/api/v1/me/favorites?page=2').json()['items'][0]['id']=='work-12'
    assert accounts.get('/api/v1/me/favorites/ids?page=2&page_size=12').json()['items']==ids[12:]
    assert accounts.get('/api/v1/me/favorites/ids').json()['relation_total']==14
    assert accounts.get('/api/v1/me/favorites?page_size=51').status_code==422
    assert accounts.get('/api/v1/me/favorites/ids?page_size=201').status_code==422
    token_a=accounts.cookies[COOKIE]
    register(accounts,'User_B')
    assert accounts.get('/api/v1/me/favorites').json()['total']==0
    assert accounts.delete('/api/v1/me/favorites/work-00').status_code==204
    assert accounts.put('/api/v1/me/favorites/work-00',json={'user_id':user_a['id']}).status_code==422
    assert accounts.get(f"/api/v1/me/favorites?user_id={user_a['id']}").status_code==422
    assert accounts.post('/api/v1/me/favorites/import',json={'work_ids':['work-01'],'user_id':user_a['id']}).status_code==422
    # Logging into B revoked the current A session, but A's records persist.
    accounts.cookies.set(COOKIE,token_a,domain='127.0.0.1',path='/')
    assert accounts.get('/api/v1/me/favorites').status_code==401
    assert login(accounts).status_code==200
    assert accounts.get('/api/v1/me/favorites').json()['total']==13
    assert accounts.delete('/api/v1/me/favorites/work-13').status_code==204
    assert accounts.delete('/api/v1/me/favorites/work-13').status_code==204
    assert accounts.get('/api/v1/me/favorites').json()['unavailable_count']==0


@pytest.mark.parametrize('ids',[[],['x']*101,['x'*81],[42]])
def test_import_input(accounts,ids):
    register(accounts)
    assert accounts.post('/api/v1/me/favorites/import',json={'work_ids':ids}).status_code==422


def test_database_errors_roll_back_registration_and_import(accounts,record):
    def fail_commit(session):
        raise OperationalError('commit',{},Exception('private database details'))
    event.listen(accounts.app.state.sessions.class_,'before_commit',fail_commit,once=True)
    response=register(accounts)
    assert response.status_code==503 and 'set-cookie' not in response.headers and 'private' not in response.text
    with accounts.app.state.sessions() as session:assert session.scalar(select(func.count()).select_from(User))==0
    register(accounts);add_work(accounts,record)
    event.listen(accounts.app.state.sessions.class_,'before_commit',fail_commit,once=True)
    assert accounts.post('/api/v1/me/favorites/import',json={'work_ids':['work-a']}).status_code==503
    assert accounts.get('/api/v1/me/favorites').json()['total']==0
    event.listen(accounts.app.state.sessions.class_,'do_orm_execute',lambda _: (_ for _ in ()).throw(OperationalError('read',{},Exception())),once=True)
    assert accounts.get('/api/v1/auth/me').status_code==503


def test_concurrent_username_and_favorite_constraints(accounts,record):
    add_work(accounts,record)
    def create_user(i):
        with TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS) as client:
            return register(client,'Race_User' if i==0 else 'race_USER').status_code
    with ThreadPoolExecutor(max_workers=2) as pool:assert sorted(pool.map(create_user,range(2)))==[201,409]
    assert login(accounts,'Race_User').status_code==200
    cookie=accounts.cookies[COOKIE]
    def save(_):
        with TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS) as client:
            client.cookies.set(COOKIE,cookie)
            return client.put('/api/v1/me/favorites/work-a').status_code
    with ThreadPoolExecutor(max_workers=2) as pool:assert list(pool.map(save,range(2)))==[200,200]
    assert accounts.get('/api/v1/me/favorites').json()['total']==1


def test_sqlite_upgrade_preserves_old_data_and_matches_alembic(tmp_path,record,monkeypatch):
    url=f"sqlite:///{(tmp_path/'old.db').as_posix()}"
    monkeypatch.setenv('DATABASE_URL',url)
    migration=Config(str(ROOT/'backend/alembic.ini'))
    command.upgrade(migration,'0002')
    engine,sessions=make_database(url)
    with sessions.begin() as session:
        session.execute(Work.__table__.insert().values(**record,content_hash='a'*64,embedding=[0.0]*1024))
        session.add(CatalogRefresh(id='latest',payload={'status':'succeeded'}))
    with engine.connect() as conn:before=conn.execute(text('select * from works')).all()
    initialize(engine)
    with engine.connect() as conn:
        assert conn.execute(text('select * from works')).all()==before
        assert conn.execute(text('PRAGMA foreign_keys')).scalar()==1
    with sessions() as session:assert session.get(CatalogRefresh,'latest').payload=={'status':'succeeded'}
    with pytest.raises(IntegrityError):
        with sessions.begin() as session:session.add(Favorite(user_id='missing',work_id='work-a',created_at=utc_now()))
    # Compare local create_all with explicit migration on a second fresh DB.
    migrated_url=f"sqlite:///{(tmp_path/'migrated.db').as_posix()}"
    monkeypatch.setenv('DATABASE_URL',migrated_url);command.upgrade(migration,'head')
    migrated,_=make_database(migrated_url)
    for table in ['users','user_sessions','favorites']:
        left,right=inspect(engine),inspect(migrated)
        normalize=lambda rows:[{**row,'type':str(row['type'])} for row in rows]
        assert normalize(left.get_columns(table))==normalize(right.get_columns(table))
        assert left.get_indexes(table)==right.get_indexes(table)
        assert left.get_unique_constraints(table)==right.get_unique_constraints(table)
        assert left.get_foreign_keys(table)==right.get_foreign_keys(table)
    command.downgrade(migration,'0002');assert 'users' not in inspect(migrated).get_table_names()
    engine.dispose();migrated.dispose()


def test_cascade_and_secure_cookie(accounts,record):
    register(accounts);add_work(accounts,record);accounts.put('/api/v1/me/favorites/work-a')
    with pytest.raises(IntegrityError):
        with accounts.app.state.sessions.begin() as session:session.execute(delete(Work).where(Work.id=='work-a'))
    assert accounts.get('/api/v1/me/favorites/ids').json()['relation_total']==1
    with accounts.app.state.sessions.begin() as session:session.execute(delete(User))
    with accounts.app.state.sessions() as session:assert session.scalar(select(func.count()).select_from(UserSession))==0
    settings=Settings(ai_mode='baseline',database_url='sqlite:///:memory:',auth_cookie_secure=True,auth_allowed_origins='https://kiwi.example')
    with TestClient(create_app(settings),base_url='https://kiwi.example',headers={'Origin':'https://kiwi.example','X-Kiwi-Request':'1'}) as client:
        assert 'Secure' in register(client).headers['set-cookie']
        assert 'Secure' in client.post('/api/v1/auth/logout').headers['set-cookie']
    with pytest.raises(ValueError):Settings(auth_allowed_origins='https://kiwi.example',auth_cookie_secure=False)
