import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Barrier, Event

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import event, inspect, select, text
from sqlalchemy.exc import OperationalError

from kiwi import auth as auth_module
from kiwi.auth import COOKIE
from kiwi.config import ROOT
from kiwi.database import Favorite, User, UserSession, Work, initialize, make_database, utc_now
from kiwi.personal_space import nickname_parts, summarize
from test_accounts import accounts, register, login, add_work, PASSWORD, HEADERS, FastPasswords

NEW_PASSWORD = "new test password 456 "


def password_body(current=PASSWORD, new=NEW_PASSWORD):
    return {"current_password": current, "new_password": new, "confirm_password": new}


def test_profile_persistence_unique_normalization_and_namespace(accounts):
    user = register(accounts).json()["user"]
    assert user["nickname"] is None and user["avatar_id"] == "kiwi-default"
    assert accounts.get('/api/v1/me/profile').json()['profile'] == user
    updated = accounts.patch('/api/v1/me/profile', json={"nickname": "  Ｋｉｗｉ  ", "avatar_id": "kiwi-moon"})
    assert updated.status_code == 200
    assert updated.json()['profile'] == {**user, 'nickname': 'Ｋｉｗｉ', 'avatar_id': 'kiwi-moon'}
    assert accounts.patch('/api/v1/me/profile', json={'nickname': 'kiwi'}).status_code == 200
    with accounts.app.state.sessions() as session:
        assert session.get(User, user['id']).nickname_key == 'kiwi'
    register(accounts, 'User_B')
    conflict = accounts.patch('/api/v1/me/profile', json={'nickname': 'Kiwi', 'avatar_id': 'kiwi-sun'})
    assert conflict.status_code == 409 and conflict.json()['error']['fields'] == ['nickname']
    assert accounts.get('/api/v1/me/profile').json()['profile']['avatar_id'] == 'kiwi-default'
    # Fallback username doesn't reserve a nickname, and login remains by username.
    assert accounts.patch('/api/v1/me/profile', json={'nickname': 'User_A'}).status_code == 200
    assert login(accounts).status_code == 200
    assert accounts.get('/api/v1/auth/me').json()['user']['nickname'] == 'kiwi'
    assert accounts.get('/api/v1/auth/me').json()['user']['avatar_id'] == 'kiwi-moon'


@pytest.mark.parametrize('body', [{}, {'nickname': None}, {'nickname': ''}, {'nickname': ' '}, {'nickname': 'a'*21},
    {'nickname': 'x\ny'}, {'nickname': 'x\ty'}, {'nickname': '\x00x'}, {'nickname': '\u2028'}, {'nickname': '\u200b'},
    {'avatar_id': None}, {'avatar_id': 'https://example.org/a.svg'}, {'avatar_id': '../x'}, {'nickname': 'ok', 'id': 'other'},
    {'user_id': 'other'}, {'username': 'changed'}, {'created_at': '2026'}])
def test_invalid_profile_is_atomic_and_safe(accounts, body):
    original = register(accounts).json()['user']
    response = accounts.patch('/api/v1/me/profile', json=body)
    assert response.status_code == 422
    assert accounts.get('/api/v1/me/profile').json()['profile'] == original
    assert 'input' not in response.json()['error']


def test_unicode_boundaries_and_nickname_concurrency(accounts):
    assert nickname_parts('  中文昵称！  ') == ('中文昵称！', '中文昵称!')
    assert nickname_parts('😀'*20)[0] == '😀'*20
    assert nickname_parts('Straße')[1] == nickname_parts('STRASSE')[1]
    assert nickname_parts('Ａ B')[1] != nickname_parts('A  B')[1]
    tokens = []
    for name in ('Race_A', 'Race_B'):
        accounts.cookies.clear()
        register(accounts, name);tokens.append(accounts.cookies[COOKIE])
    def compete(i):
        client = TestClient(accounts.app, base_url='http://127.0.0.1:8000', headers=HEADERS)
        try:
            client.cookies.set(COOKIE, tokens[i])
            return client.patch('/api/v1/me/profile', json={'nickname': ['KiWi', 'ＫＩＷＩ'][i]}).status_code
        finally:
            client.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(compete, range(2))) == [200, 409]


def test_summary_uses_all_relations_with_matching_profile_counts(accounts, record):
    register(accounts)
    for i in range(16):
        row = copy.deepcopy(record)
        row.update(source_meta={'content_type': '漫画' if i == 14 else '漫剧'}, genres=['修仙', '修仙', '未知'], themes=['逆袭', '成长'])
        add_work(accounts, row, f'work-{i}')
    accounts.post('/api/v1/me/favorites/import', json={'work_ids': [f'work-{i}' for i in range(16)]})
    with accounts.app.state.sessions.begin() as session: session.get(Work, 'work-15').review_status = 'pending'
    response = accounts.get('/api/v1/me/space-summary')
    assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
    data = response.json()
    assert data['favorites'] == {'total': 16, 'available': 15, 'unavailable': 1}
    assert data['interest']['analyzed_count'] == 14
    assert data['interest']['genres'] == [{'label': '修仙', 'count': 14}]
    assert data['interest']['content_types'] == [{'label': '漫剧', 'count': 14}]
    favorites = accounts.get('/api/v1/me/favorites').json()
    assert favorites['total'] + favorites['unavailable_count'] == data['favorites']['total']
    register(accounts, 'Isolated')
    assert accounts.get('/api/v1/me/space-summary').json()['interest']['status'] == 'no_favorites'


def test_summary_empty_tags_order_and_duplicates():
    base = {'id': 'x', 'review_status': 'approved', 'source_meta': {'content_type': '漫画'}, 'genres': [], 'themes': []}
    assert summarize([base])['interest']['status'] == 'no_valid_favorites'
    base['source_meta']['content_type'] = 'AI剧'
    assert summarize([base])['interest']['status'] == 'no_tags'
    assert summarize([base])['interest']['content_types'] == [{'label': 'AI剧', 'count': 1}]
    base['genres'] = ['修仙', '修仙', '都市', '科幻', '悬疑', '玄幻', '末世', '未知']
    data = summarize([base, base])
    assert data['favorites']['total'] == 1
    assert len(data['interest']['genres']) == 5
    assert [tag['label'] for tag in data['interest']['genres']] == sorted(set(base['genres'])-{'未知'})[:5]
    assert all(tag['count'] == 1 for tag in data['interest']['genres'])


@pytest.mark.parametrize('path', ['/profile', '/space-summary', '/password'])
def test_ownership_extra_query_no_store_and_origin(accounts, path):
    url = '/api/v1/me' + path
    request = lambda **kw: accounts.post(url, json=password_body(), **kw) if path == '/password' else accounts.get(url, **kw)
    assert request().status_code == 401
    register(accounts)
    response = request(params={'nickname': 'other'})
    assert response.status_code == 422 and response.headers['cache-control'] == 'no-store'
    if path == '/profile':
        assert accounts.patch(url, json={'nickname': 'x'}, headers={'Origin': 'https://evil.example'}).status_code == 403


def test_password_atomic_failure_limits_and_all_session_revocation(accounts, record, monkeypatch):
    register(accounts);add_work(accounts, record);accounts.put('/api/v1/me/favorites/work-a')
    accounts.patch('/api/v1/me/profile', json={'nickname': '保存的资料', 'avatar_id': 'kiwi-star'})
    # A second browser's session exists concurrently.
    other = TestClient(accounts.app, base_url='http://127.0.0.1:8000', headers=HEADERS)
    assert login(other).status_code == 200
    wrong = accounts.post('/api/v1/me/password', json=password_body('incorrect password'))
    assert wrong.status_code == 400 and wrong.json()['error']['fields'] == ['current_password']
    assert accounts.get('/api/v1/me/profile').status_code == 200
    for body in [password_body(new=PASSWORD), {**password_body(), 'confirm_password': 'different password'}, password_body(new='short')]:
        response = accounts.post('/api/v1/me/password', json=body)
        assert response.status_code == 422 and PASSWORD not in response.text
    def fail_commit(_): raise OperationalError('commit', {}, Exception('private detail'))
    event.listen(accounts.app.state.sessions.class_, 'before_commit', fail_commit, once=True)
    assert accounts.post('/api/v1/me/password', json=password_body()).status_code == 503
    assert accounts.get('/api/v1/me/profile').status_code == 200 and other.get('/api/v1/me/profile').status_code == 200
    with accounts.app.state.auth.hashing(), accounts.app.state.auth.hashing():
        assert accounts.post('/api/v1/me/password', json=password_body()).status_code == 429
    # Ensure at least one real Argon2id change/verify in this suite.
    from pwdlib import PasswordHash
    real = PasswordHash.recommended()
    monkeypatch.setattr(auth_module, 'passwords', real)
    with accounts.app.state.sessions.begin() as session:
        user = session.scalar(select(User));user.password_hash = real.hash(PASSWORD)
    result = accounts.post('/api/v1/me/password', json=password_body())
    assert result.status_code == 204 and 'Max-Age=0' in result.headers['set-cookie']
    assert accounts.get('/api/v1/me/profile').status_code == 401
    assert other.get('/api/v1/me/profile').status_code == 401
    assert login(other, password=PASSWORD).status_code == 401
    assert login(other, password=NEW_PASSWORD).status_code == 200
    assert other.get('/api/v1/me/profile').json()['profile']['nickname'] == '保存的资料'
    assert other.get('/api/v1/me/favorites/ids').json()['relation_total'] == 1
    other.close()


def test_password_rate_limit(accounts):
    register(accounts)
    for _ in range(5): assert accounts.post('/api/v1/me/password', json=password_body('wrong password')).status_code == 400
    response = accounts.post('/api/v1/me/password', json=password_body())
    assert response.status_code == 429 and int(response.headers['retry-after']) > 0


def test_two_password_changes_cannot_overwrite_each_other(accounts, monkeypatch):
    register(accounts)
    barrier = Barrier(2)
    class SimultaneousPasswords(FastPasswords):
        def verify(self, password, encoded):
            valid = super().verify(password, encoded)
            barrier.wait(timeout=10)
            return valid
    monkeypatch.setattr(auth_module, 'passwords', SimultaneousPasswords())
    token = accounts.cookies[COOKIE]
    def change(index):
        client = TestClient(accounts.app, base_url='http://127.0.0.1:8000', headers=HEADERS)
        try:
            client.cookies.set(COOKIE, token)
            return client.post('/api/v1/me/password', json=password_body(new=NEW_PASSWORD + str(index))).status_code
        finally:
            client.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(change, range(2))) == [204, 401]
    with accounts.app.state.sessions() as session:
        assert session.scalars(select(UserSession)).all() == []
        assert session.scalar(select(User)).password_hash in {FastPasswords().hash(NEW_PASSWORD + str(i)) for i in range(2)}


def test_validated_old_login_cannot_issue_after_password_change(accounts, monkeypatch):
    register(accounts)
    ready, release = Event(), Event()
    original = auth_module.passwords
    class PausedPasswords(FastPasswords):
        def verify(self, password, encoded):
            valid = original.verify(password, encoded)
            if password == PASSWORD:
                ready.set();assert release.wait(10)
            return valid
    monkeypatch.setattr(auth_module, 'passwords', PausedPasswords())
    late = TestClient(accounts.app, base_url='http://127.0.0.1:8000', headers=HEADERS)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(login, late)
        assert ready.wait(10)
        monkeypatch.setattr(auth_module, 'passwords', original)
        assert accounts.post('/api/v1/me/password', json=password_body()).status_code == 204
        release.set()
        assert pending.result(10).status_code == 409
    assert late.get('/api/v1/me/profile').status_code == 401
    with accounts.app.state.sessions() as session: assert session.scalars(select(UserSession)).all() == []
    late.close()


@pytest.mark.parametrize('operation', ['profile', 'favorite', 'import', 'remove'])
def test_inflight_write_rechecks_session_after_revocation(accounts, record, monkeypatch, operation):
    register(accounts);add_work(accounts, record)
    ready, release = Event(), Event()
    auth = accounts.app.state.auth
    original = auth.write
    @contextmanager
    def paused(request, user_id, **kwargs):
        if request.url.path != '/api/v1/me/password':
            ready.set();assert release.wait(10)
        with original(request, user_id, **kwargs) as value: yield value
    monkeypatch.setattr(auth, 'write', paused)
    late = TestClient(accounts.app, base_url='http://127.0.0.1:8000', headers=HEADERS)
    late.cookies.set(COOKIE, accounts.cookies[COOKIE])
    operations = {'profile': lambda: late.patch('/api/v1/me/profile', json={'nickname': 'too late'}),
        'favorite': lambda: late.put('/api/v1/me/favorites/work-a'),
        'import': lambda: late.post('/api/v1/me/favorites/import', json={'work_ids': ['work-a']}),
        'remove': lambda: late.delete('/api/v1/me/favorites/work-a')}
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(operations[operation]);assert ready.wait(10)
        assert accounts.post('/api/v1/me/password', json=password_body()).status_code == 204
        release.set();assert pending.result(10).status_code == 401
    with auth.sessions() as session:
        assert session.scalar(select(User)).nickname is None
        assert session.scalars(select(Favorite)).all() == []
    late.close()


@pytest.mark.parametrize('versioned', [True, False, 'stale'])
def test_old_sqlite_upgrade_backup_and_repeat_preserve_all_rows(tmp_path, monkeypatch, record, versioned):
    path = tmp_path / 'old-profiles.db';url = f'sqlite:///{path.as_posix()}'
    monkeypatch.setenv('DATABASE_URL', url)
    config = Config(str(ROOT/'backend/alembic.ini'));command.upgrade(config, '0005')
    engine, _ = make_database(url)
    with engine.begin() as connection:
        connection.execute(Work.__table__.insert(), [{**record, 'content_hash': 'a'*64, 'embedding': [0.0]*1024}])
        connection.exec_driver_sql("INSERT INTO users VALUES ('u','User','user','preserved',CURRENT_TIMESTAMP)")
        connection.exec_driver_sql("INSERT INTO user_sessions VALUES ('token','u',CURRENT_TIMESTAMP,'2099-01-01')")
        connection.exec_driver_sql("INSERT INTO favorites VALUES ('u','work-a',CURRENT_TIMESTAMP)")
        if not versioned: connection.exec_driver_sql('DROP TABLE alembic_version')
        elif versioned == 'stale': connection.exec_driver_sql("UPDATE alembic_version SET version_num='0001'")
    tables = ['works', 'users', 'user_sessions', 'favorites']
    with engine.connect() as connection:
        before = {name: connection.exec_driver_sql(f'SELECT * FROM {name}').all() for name in tables}
    initialize(engine);initialize(engine)
    with engine.connect() as connection:
        for name in tables:
            columns = ','.join(c['name'] for c in inspect(connection).get_columns(name) if c['name'] not in {'nickname','nickname_key','avatar_id'})
            assert connection.exec_driver_sql(f'SELECT {columns} FROM {name}').all() == before[name]
        assert connection.exec_driver_sql('SELECT nickname,nickname_key,avatar_id FROM users').one() == (None, None, 'kiwi-default')
        assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar() == '0008'
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
    backups = list(tmp_path.glob('*.bak'));assert len(backups) == 1
    import sqlite3
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert len(backup.execute('PRAGMA table_info(users)').fetchall()) == 5
    engine.dispose()


def test_unknown_sqlite_structure_refused_before_stamp(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path/'unknown.db').as_posix()}";monkeypatch.setenv('DATABASE_URL', url)
    command.upgrade(Config(str(ROOT/'backend/alembic.ini')), '0005')
    engine, _ = make_database(url)
    with engine.begin() as connection: connection.exec_driver_sql('ALTER TABLE users ADD COLUMN unexpected TEXT')
    with pytest.raises(RuntimeError, match='未知'): initialize(engine)
    with engine.connect() as connection:
        assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar() == '0005'
        assert 'nickname' not in {c['name'] for c in inspect(connection).get_columns('users')}
    engine.dispose()


def test_failed_sqlite_migration_rolls_back_schema_and_can_retry(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path/'failed.db').as_posix()}";monkeypatch.setenv('DATABASE_URL', url)
    command.upgrade(Config(str(ROOT/'backend/alembic.ini')), '0005')
    engine, _ = make_database(url)
    def fail_index(connection, cursor, statement, parameters, context, many):
        if statement.startswith('CREATE UNIQUE INDEX uq_users_nickname_key'):
            raise OperationalError('migration', {}, Exception('synthetic failure'))
    event.listen(engine, 'before_cursor_execute', fail_index)
    with pytest.raises(OperationalError): initialize(engine)
    with engine.connect() as connection:
        assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar() == '0005'
        assert 'nickname' not in {c['name'] for c in inspect(connection).get_columns('users')}
    event.remove(engine, 'before_cursor_execute', fail_index)
    initialize(engine)
    assert 'nickname' in {c['name'] for c in inspect(engine).get_columns('users')}
    engine.dispose()
