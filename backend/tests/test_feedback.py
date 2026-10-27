"""Disposable accounts and catalogues; no production feedback is modified."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event

from alembic import command
from alembic.config import Config
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import delete, event, inspect, select
from sqlalchemy.exc import IntegrityError, OperationalError

from kiwi.auth import COOKIE
from kiwi.config import ROOT, Settings
from kiwi.database import Favorite, UserWorkFeedback, Work, initialize, make_database, utc_now
from kiwi.importer import import_works
from kiwi.providers import BaselineAI, ProviderError
from kiwi.schemas import Preferences, RecommendationRequest
from kiwi.service import recommend
from conftest import FakeAI
from test_accounts import accounts, add_work, login, register, HEADERS
from test_personal_space import password_body


def save(client, id='work-a', status='not_interested', revision=None):
    return client.patch('/api/v1/me/feedback/'+id, json={'status': status, 'expected_revision': revision})


def test_save_change_conditional_undo_and_two_cookie_contexts(accounts, record):
    register(accounts);add_work(accounts, record)
    assert accounts.put('/api/v1/me/favorites/work-a').status_code == 200
    first = save(accounts).json()['feedback']
    assert len(first['revision']) == 32 and set(first) == {'work_id','status','revision','updated_at'}
    assert save(accounts).json()['feedback'] == first  # Exact target is idempotent.
    with TestClient(accounts.app, base_url='http://127.0.0.1:8000', headers=HEADERS) as second:
        login(second)
        assert second.get('/api/v1/me/feedback/state').json()['items'] == [first]
        assert save(second, status='watched').status_code == 409
        current = save(second, status='watched', revision=first['revision']).json()['feedback']
        assert current['revision'] != first['revision']
        assert accounts.delete('/api/v1/me/feedback/work-a', headers={'If-Match':'"'+first['revision']+'"'}).status_code == 412
        assert accounts.get('/api/v1/me/feedback/work-a').json()['feedback'] == current
        assert accounts.delete('/api/v1/me/feedback/work-a', headers={'If-Match':'"'+current['revision']+'"'}).status_code == 204
        assert accounts.delete('/api/v1/me/feedback/work-a', headers={'If-Match':'"'+current['revision']+'"'}).status_code == 204
    assert accounts.get('/api/v1/me/feedback/work-a').json()['feedback'] is None
    assert accounts.get('/api/v1/me/favorites').json()['total'] == 1


@pytest.mark.parametrize('body', [{}, {'status':'dislike','expected_revision':None}, {'status':'watched'},
    {'status':'watched','expected_revision':'stale'}, {'status':True,'expected_revision':None},
    {'status':'watched','expected_revision':None,'user_id':'someone'}, {'status':'watched','expected_revision':42}])
def test_strict_feedback_input(accounts, record, body):
    register(accounts);add_work(accounts, record)
    assert accounts.patch('/api/v1/me/feedback/work-a', json=body).status_code == 422


@pytest.mark.parametrize('etag', [None, 'a'*32, 'W/"'+'a'*32+'"', '"BAD"', '*'])
def test_delete_requires_strict_if_match(accounts, etag):
    register(accounts)
    assert accounts.delete('/api/v1/me/feedback/work-a', headers={} if etag is None else {'If-Match':etag}).status_code == 422


def test_private_boundaries_pagination_snapshot_unavailable_and_cascade(accounts, record):
    assert accounts.get('/api/v1/me/feedback').status_code == 401
    register(accounts)
    for i in range(4): add_work(accounts, record, f'work-{i}')
    for i in range(4): assert save(accounts, f'work-{i}', 'watched' if i%2 else 'not_interested').status_code == 200
    assert accounts.get('/api/v1/me/feedback?status=watched&page_size=1&page=2').json()['total'] == 2
    assert len(accounts.get('/api/v1/me/feedback?status=watched&page_size=1&page=2').json()['items']) == 1
    accounts.app.state.settings.feedback_state_limit = 2
    state = accounts.get('/api/v1/me/feedback/state')
    assert state.headers['cache-control'] == 'no-store' and state.json()['complete'] is False
    assert len(state.json()['items']) == 2
    for path in ['/feedback','/feedback/state','/feedback/work-0','/recommendations']:
        response = accounts.get('/api/v1/me'+path+'?username=other') if path != '/recommendations' else accounts.post('/api/v1/me'+path+'?nickname=other',json={'preferences':{}})
        assert response.status_code == 422
    assert save(accounts, 'missing').status_code == 404
    add_work(accounts, record, 'pending', 'pending');assert save(accounts,'pending').status_code == 404
    with accounts.app.state.sessions.begin() as session:
        session.get(Work,'work-0').review_status = 'pending'
    items = accounts.get('/api/v1/me/feedback').json()['items']
    item = next(item for item in items if item['work_id'] == 'work-0')
    assert item['work'] is None and item['available'] is False and 'original_intro' not in str(item)
    assert accounts.delete('/api/v1/me/feedback/work-0',headers={'If-Match':'"'+item['revision']+'"'}).status_code == 204
    register(accounts,'User_B');assert accounts.get('/api/v1/me/feedback').json()['total'] == 0
    login(accounts);assert accounts.get('/api/v1/me/feedback').json()['total'] == 3
    assert save(accounts,'work-1',status='watched',revision=None).status_code == 200
    with accounts.app.state.sessions.begin() as session:session.execute(delete(Work).where(Work.id=='work-1'))
    assert accounts.get('/api/v1/me/feedback').json()['total'] == 2


def test_feedback_write_protection_limits_and_database_rollback(accounts, record):
    register(accounts);add_work(accounts, record)
    assert accounts.patch('/api/v1/me/feedback/work-a',json={'status':'watched','expected_revision':None},headers={'Origin':'https://evil.test'}).status_code == 403
    assert accounts.request('DELETE','/api/v1/me/feedback/work-a',json={},headers={'If-Match':'"'+'a'*32+'"'}).status_code == 422
    def fail(connection,cursor,statement,parameters,context,many):
        if statement.startswith('INSERT INTO user_work_feedback'):raise OperationalError('synthetic',{},Exception('failed'))
    event.listen(accounts.app.state.engine,'before_cursor_execute',fail)
    try:assert save(accounts).status_code == 503
    finally:event.remove(accounts.app.state.engine,'before_cursor_execute',fail)
    assert accounts.get('/api/v1/me/feedback/work-a').json()['feedback'] is None
    accounts.app.state.settings.feedback_write_limit = 1
    accounts.app.state.auth.limiter.entries.clear()
    assert save(accounts).status_code == 200
    limited = save(accounts);assert limited.status_code == 429 and int(limited.headers['retry-after']) >= 1


def test_private_filter_before_limit_and_public_cookie_purity(accounts, record):
    register(accounts)
    for i in range(15):
        row=copy.deepcopy(record);row['cover_url']='https://example.org/a.jpg'
        row['source_meta']={'provider':'hongguo','content_type':'漫画' if i==13 else '漫剧','tags':[], 'pages':['https://example.org/a']}
        add_work(accounts,row,f'work-{i:02}')
    for i in range(11):assert save(accounts,f'work-{i:02}','watched' if i%2 else 'not_interested').status_code == 200
    body={'preferences':{'soft_preferences':{'genres':['修仙']}},'exclude_work_ids':['work-11']}
    private=accounts.post('/api/v1/me/recommendations',json=body)
    assert private.headers['cache-control'] == 'no-store'
    assert [w['id'] for w in private.json()['items']] == ['work-12','work-13','work-14']
    assert private.json()['batch'] == {'state':'exhausted','has_more':False}
    assert [w['id'] for w in accounts.post('/api/v1/recommendations',json=body).json()['items']] == ['work-00','work-01','work-02']
    private_home=accounts.get('/api/v1/me/home-recommendations').json()
    assert [w['id'] for w in private_home['items']] == ['work-11','work-12','work-14']
    public=accounts.get('/api/v1/home/recommendations').json()
    assert len(public['items']) == 6 and public['items'][0]['id'] == 'work-00'
    body['exclude_work_ids'] += ['work-12','work-13','work-14']
    assert accounts.post('/api/v1/me/recommendations',json=body).json()['status'] == 'empty'
    assert accounts.get('/api/v1/works').json()['total'] == 15


def test_concurrent_changes_only_one_expected_version_wins(accounts, record):
    register(accounts);add_work(accounts,record)
    cookie=accounts.cookies[COOKIE]
    def write(status):
        with TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS) as client:
            client.cookies.set(COOKIE,cookie);return save(client,status=status).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(write,['watched','not_interested'])) == [200,409]


def test_feedback_write_rechecks_revoked_session(accounts,record,monkeypatch):
    register(accounts);add_work(accounts,record)
    ready,release=Event(),Event();auth=accounts.app.state.auth;original=auth.write
    @contextmanager
    def paused(request,user_id,**kwargs):
        if request.url.path.endswith('/feedback/work-a'):ready.set();assert release.wait(10)
        with original(request,user_id,**kwargs) as result:yield result
    monkeypatch.setattr(auth,'write',paused)
    late=TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS);late.cookies.set(COOKIE,accounts.cookies[COOKIE])
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending=pool.submit(save,late);assert ready.wait(10)
            assert accounts.post('/api/v1/me/password',json=password_body()).status_code == 204
            release.set();assert pending.result(10).status_code == 401
        with auth.sessions() as session:assert session.scalars(select(UserWorkFeedback)).all() == []
    finally:release.set();late.close()


@pytest.mark.parametrize('size,limit,state,count', [(7,500,'ready',3),(2,500,'exhausted',2),(0,500,'exhausted',0)])
async def test_batch_contract_and_no_repeat(record,database,baseline_settings,size,limit,state,count):
    rows=[{**copy.deepcopy(record),'id':f'row-{i}','title':f'测试 {i}'} for i in range(size)]
    if rows:await import_works(rows,database,BaselineAI(),baseline_settings)
    prefs=Preferences(soft_preferences={'genres':['修仙']});ids=[]
    first=await recommend(RecommendationRequest(preferences=prefs),database,BaselineAI(),baseline_settings,'r')
    assert len(first['items']) == count and first['batch']['state'] == state
    while first['items']:
        current=[w['id'] for w in first['items']];assert not set(ids)&set(current);ids+=current
        first=await recommend(RecommendationRequest(preferences=prefs,exclude_work_ids=ids),database,BaselineAI(),baseline_settings,'r')
    assert len(ids) == size and first['batch'] == {'state':'exhausted','has_more':False}


async def test_refill_past_first_window_and_incomplete_is_not_exhaustion(record,database,baseline_settings):
    await import_works([{**copy.deepcopy(record),'id':f'row-{i:02}','title':f'作品 {i}'} for i in range(18)],database,BaselineAI(),baseline_settings)
    with database.begin() as session:
        for i in range(12):session.get(Work,f'row-{i:02}').evidence=[]
    baseline_settings.recommendation_scan_batch=5
    req=RecommendationRequest(preferences=Preferences(soft_preferences={'genres':['修仙']}))
    result=await recommend(req,database,BaselineAI(),baseline_settings,'r')
    assert [w['id'] for w in result['items']] == ['row-12','row-13','row-14']
    baseline_settings.recommendation_scan_limit=8
    with pytest.raises(ProviderError,match='检索尚未完成') as exc:await recommend(req,database,BaselineAI(),baseline_settings,'r')
    assert exc.value.code == 'search_incomplete'


@pytest.mark.parametrize('change',['feedback','catalog','vector'])
async def test_live_changed_state_and_provider_failure(record,database,change):
    settings=Settings(ai_mode='live');await import_works([record],database,FakeAI(),settings)
    from kiwi.database import User
    with database.begin() as session:session.add(User(id='u',username='test',username_key='test',password_hash='synthetic',created_at=utc_now()))
    class ChangedAI(FakeAI):
        async def embed(self,texts):
            if change=='vector':raise ProviderError('vector_failed','vector failed')
            return await super().embed(texts)
        async def reasons(self,prefs,works):
            with database.begin() as session:
                if change=='feedback':session.add(UserWorkFeedback(user_id='u',work_id='work-a',status='watched',revision='a'*32,updated_at=utc_now()))
                else:session.get(Work,'work-a').content_hash='b'*64
            return await super().reasons(prefs,works)
    req=RecommendationRequest(preferences=Preferences(soft_preferences={'genres':['修仙']}))
    if change=='vector':
        with pytest.raises(ProviderError):await recommend(req,database,ChangedAI(),settings,'r',user_id='u')
    else:
        with pytest.raises(HTTPException) as exc:await recommend(req,database,ChangedAI(),settings,'r',user_id='u')
        assert exc.value.status_code == 409 and exc.value.detail['code'] == ('feedback_changed' if change=='feedback' else 'catalog_changed')


@pytest.mark.parametrize('versioned',[True,False])
def test_0006_upgrade_backup_repeat_constraints_and_original_values(tmp_path,monkeypatch,record,versioned):
    path=tmp_path/'feedback-upgrade.db';url=f'sqlite:///{path.as_posix()}';monkeypatch.setenv('DATABASE_URL',url)
    config=Config(str(ROOT/'backend/alembic.ini'));command.upgrade(config,'0006');engine,sessions=make_database(url)
    with sessions.begin() as session:session.add(Work(**record,content_hash='a'*64,embedding=[0.0]*1024))
    with engine.begin() as connection:
        before=connection.exec_driver_sql('SELECT * FROM works').all()
        if not versioned:connection.exec_driver_sql('DROP TABLE alembic_version')
    initialize(engine);initialize(engine)
    with engine.connect() as connection:
        assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar() == '0007'
        assert connection.exec_driver_sql('SELECT * FROM works').all() == before
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
    schema=inspect(engine)
    assert schema.get_pk_constraint('user_work_feedback')['constrained_columns'] == ['user_id','work_id']
    assert len(schema.get_foreign_keys('user_work_feedback')) == 2 and schema.get_check_constraints('user_work_feedback')
    assert len(list(tmp_path.glob('*.bak'))) == 1
    engine.dispose()


def test_0007_failed_upgrade_rolls_back_and_unknown_structure_refused(tmp_path,monkeypatch):
    url=f"sqlite:///{(tmp_path/'failed.db').as_posix()}";monkeypatch.setenv('DATABASE_URL',url)
    config=Config(str(ROOT/'backend/alembic.ini'));command.upgrade(config,'0006');engine,_=make_database(url)
    def fail(connection,cursor,statement,parameters,context,many):
        if statement.startswith('CREATE INDEX ix_feedback_'):raise OperationalError('synthetic',{},Exception('failed'))
    event.listen(engine,'before_cursor_execute',fail)
    try:
        with pytest.raises(OperationalError):initialize(engine)
    finally:event.remove(engine,'before_cursor_execute',fail)
    with engine.connect() as connection:assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar() == '0006'
    assert not inspect(engine).has_table('user_work_feedback');initialize(engine)
    with engine.begin() as connection:connection.exec_driver_sql('ALTER TABLE user_work_feedback ADD COLUMN unknown TEXT')
    with pytest.raises(RuntimeError,match='未知'):initialize(engine)
    engine.dispose()


@pytest.mark.parametrize('missing',['users','preview_jobs','user_sessions'])
def test_partially_applied_0006_is_never_stamped_or_repaired(tmp_path,monkeypatch,missing):
    url=f"sqlite:///{(tmp_path/'partial.db').as_posix()}";monkeypatch.setenv('DATABASE_URL',url)
    command.upgrade(Config(str(ROOT/'backend/alembic.ini')),'0006');engine,_=make_database(url)
    with engine.begin() as connection:connection.exec_driver_sql(f'DROP TABLE {missing}')
    with pytest.raises(RuntimeError,match='部分升级|不完整'):initialize(engine)
    with engine.connect() as connection:assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar() == '0006'
    assert not inspect(engine).has_table('user_work_feedback');engine.dispose()


@pytest.mark.parametrize('ids', [['same']*201, [''], ['x'*81], [42]])
def test_batch_input_raw_length_and_strict_ids(client,ids):
    assert client.post('/api/v1/recommendations',json={'preferences':{},'exclude_work_ids':ids}).status_code == 422
