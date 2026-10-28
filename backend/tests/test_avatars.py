import base64
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Event

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from PIL import Image
import pytest
from sqlalchemy import event, inspect, select
from sqlalchemy.exc import OperationalError

from kiwi.auth import COOKIE
from kiwi.config import ROOT
from kiwi.database import UserAvatar, initialize, make_database
from test_accounts import accounts, register, login, HEADERS
from test_personal_space import password_body


def encoded_photo(format='PNG',size=(64,96),color='#8ebc63'):
    output=BytesIO();image=Image.new('RGB',size,color)
    if format=='JPEG':
        exif=Image.Exif();exif[270]='private fixture metadata';image.save(output,format,exif=exif)
    else:image.save(output,format)
    return base64.b64encode(output.getvalue()).decode()


@pytest.mark.parametrize('format',['JPEG','PNG','WEBP'])
def test_photo_persists_across_sessions_and_is_reencoded_private_versioned(accounts,format):
    user=register(accounts).json()['user'];assert user['avatar_url'] is None
    changed=accounts.patch('/api/v1/me/profile',json={'nickname':'照片用户','avatar_image':encoded_photo(format)})
    assert changed.status_code==200
    profile=changed.json()['profile'];url=profile['avatar_url'];assert url.startswith('/api/v1/me/avatar/')
    response=accounts.get(url);assert response.status_code==200 and response.headers['cache-control']=='no-store'
    assert response.headers['content-type']=='image/jpeg' and response.headers['x-content-type-options']=='nosniff'
    with Image.open(BytesIO(response.content)) as image:
        assert image.size==(256,256) and image.format=='JPEG' and not image.getexif()
    assert b'private fixture metadata' not in response.content
    assert accounts.get('/api/v1/auth/me').json()['user']['avatar_url']==url
    assert accounts.patch('/api/v1/me/profile',json={'nickname':'改名字'}).json()['profile']['avatar_url']==url
    with TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS) as second:
        assert second.get(url).status_code==401
        assert login(second).json()['user']['avatar_url']==url
        assert second.get(url).content==response.content
        register(second,'Other');assert second.get(url).status_code==404
        assert second.get('/api/v1/me/profile').json()['profile']['avatar_url'] is None
    newer=accounts.patch('/api/v1/me/profile',json={'avatar_image':encoded_photo(color='#ff9966')}).json()['profile']['avatar_url']
    assert newer!=url and accounts.get(url).status_code==404
    selected=accounts.patch('/api/v1/me/profile',json={'avatar_id':'kiwi-moon'}).json()['profile']
    assert selected['avatar_id']=='kiwi-moon' and selected['avatar_url'] is None and accounts.get(newer).status_code==404
    with accounts.app.state.sessions() as session:assert session.scalars(select(UserAvatar)).all()==[]


@pytest.mark.parametrize('body',[{'avatar_image':None},{'avatar_image':''},{'avatar_image':'bad!'},
    {'avatar_image':base64.b64encode(b'<svg onload="alert(1)"/>').decode()},
    {'avatar_image':encoded_photo('GIF')},{'avatar_image':encoded_photo(size=(1025,20))},
    {'avatar_image':encoded_photo(),'avatar_id':'kiwi-leaf'},
    {'avatar_image':encoded_photo(),'user_id':'other'},
    {'avatar_image':base64.b64encode(b'x'*16001).decode()}])
def test_invalid_image_is_rejected_without_modifying_profile(accounts,body):
    before=register(accounts).json()['user']
    response=accounts.patch('/api/v1/me/profile',json=body)
    assert response.status_code==422
    assert accounts.get('/api/v1/me/profile').json()['profile']==before


def test_photo_nickname_conflict_and_database_failure_are_atomic(accounts):
    register(accounts);url=accounts.patch('/api/v1/me/profile',json={'nickname':'原资料','avatar_image':encoded_photo()}).json()['profile']['avatar_url']
    register(accounts,'Other');accounts.patch('/api/v1/me/profile',json={'nickname':'被占用'})
    login(accounts)
    assert accounts.patch('/api/v1/me/profile',json={'nickname':'被占用','avatar_image':encoded_photo(color='red')}).status_code==409
    assert accounts.get('/api/v1/me/profile').json()['profile']['avatar_url']==url
    original=accounts.get(url).content
    def fail(connection,cursor,statement,parameters,context,many):
        if statement.startswith('UPDATE user_avatars'):raise OperationalError('synthetic',{},Exception('failed'))
    event.listen(accounts.app.state.engine,'before_cursor_execute',fail)
    try:assert accounts.patch('/api/v1/me/profile',json={'avatar_image':encoded_photo(color='red')}).status_code==503
    finally:event.remove(accounts.app.state.engine,'before_cursor_execute',fail)
    assert accounts.get(url).content==original
    assert accounts.get(url+'?user_id=other').status_code==422
    assert accounts.get(url+'?extra=1').status_code==422
    assert accounts.patch('/api/v1/me/profile',json={'avatar_image':encoded_photo()},headers={'Origin':'https://evil.example'}).status_code==403
    assert accounts.patch('/api/v1/me/profile',content='x'*24001,headers={'Content-Type':'application/json'}).status_code==413


def test_animated_image_is_not_accepted(accounts):
    register(accounts);output=BytesIO()
    frames=[Image.new('RGB',(64,64),color) for color in ('red','blue')]
    frames[0].save(output,'WEBP',save_all=True,append_images=frames[1:],duration=100,loop=0)
    assert accounts.patch('/api/v1/me/profile',json={'avatar_image':base64.b64encode(output.getvalue()).decode()}).status_code==422


def test_inflight_photo_cannot_commit_after_password_revocation(accounts,monkeypatch):
    register(accounts);ready,release=Event(),Event();original=accounts.app.state.auth.write
    @contextmanager
    def paused(request,user_id,**kwargs):
        if request.url.path.endswith('/profile'):ready.set();assert release.wait(10)
        with original(request,user_id,**kwargs) as value:yield value
    monkeypatch.setattr(accounts.app.state.auth,'write',paused)
    late=TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS);late.cookies.set(COOKIE,accounts.cookies[COOKIE])
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending=pool.submit(late.patch,'/api/v1/me/profile',json={'avatar_image':encoded_photo()});assert ready.wait(10)
            assert accounts.post('/api/v1/me/password',json=password_body()).status_code==204
            release.set();assert pending.result(10).status_code==401
        with accounts.app.state.sessions() as session:assert session.scalars(select(UserAvatar)).all()==[]
    finally:release.set();late.close()


def test_0007_to_0008_backup_repeat_and_failure_rollback(tmp_path,monkeypatch):
    path=tmp_path/'photo-upgrade.db';url=f'sqlite:///{path.as_posix()}';monkeypatch.setenv('DATABASE_URL',url)
    config=Config(str(ROOT/'backend/alembic.ini'));command.upgrade(config,'0007');engine,_=make_database(url)
    def fail(connection,cursor,statement,parameters,context,many):
        if 'CREATE TABLE user_avatars' in statement:raise OperationalError('synthetic',{},Exception('failed'))
    event.listen(engine,'before_cursor_execute',fail)
    try:
        with pytest.raises(OperationalError):initialize(engine)
    finally:event.remove(engine,'before_cursor_execute',fail)
    with engine.connect() as connection:assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar()=='0007'
    assert not inspect(engine).has_table('user_avatars');initialize(engine);initialize(engine)
    with engine.connect() as connection:
        assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar()=='0010'
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all()==[]
    assert inspect(engine).get_pk_constraint('user_avatars')['constrained_columns']==['user_id']
    assert all(fk['options']['ondelete']=='CASCADE' for fk in inspect(engine).get_foreign_keys('user_avatars'))
    assert list(tmp_path.glob('*.bak'));engine.dispose()
