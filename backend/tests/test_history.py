"""Server snapshots, isolated sessions and migration safety."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import delete, event, inspect, select
from sqlalchemy.exc import OperationalError

from kiwi.auth import COOKIE
from kiwi.config import ROOT
from kiwi.database import RecommendationHistory, User, Work, initialize, make_database
from test_accounts import accounts, add_work, login, register, HEADERS
from test_personal_space import password_body


def generate(client, **extra):
    return client.post('/api/v1/me/recommendations', json={
        'preferences': {'soft_preferences': {'genres': ['修仙']}}, 'query': '想看修仙，不要后宫', **extra})


def test_auto_save_exact_result_across_cookies_no_provider_on_read(accounts, record):
    user=register(accounts).json()['user'];add_work(accounts,record)
    response=generate(accounts);assert response.status_code==200
    result=response.json();id=result['history']['id'];assert result['history']['status']=='saved'
    with TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS) as second:
        assert second.get('/api/v1/me/history').status_code==401
        login(second)
        listing=second.get('/api/v1/me/history');assert listing.headers['cache-control']=='no-store'
        assert listing.json()['total']==1 and listing.json()['items'][0]['id']==id
        detail=second.get('/api/v1/me/history/'+id);assert detail.status_code==200
        assert detail.headers['cache-control']=='no-store'
        saved=detail.json()['history'];assert saved['query']=='想看修仙，不要后宫'
        assert saved['preferences']==result['preferences'] and saved['warnings']==result['warnings']
        assert saved['items'][0]['work']==result['items'][0] and not saved['items'][0]['changed']
        assert 'catalog_hash' not in saved['items'][0]['work']
        register(second,'Other')
        assert second.get('/api/v1/me/history').json()['total']==0
        assert second.get('/api/v1/me/history/'+id).status_code==404
        assert second.delete('/api/v1/me/history/'+id).status_code==404
    with accounts.app.state.sessions() as session:
        row=session.get(RecommendationHistory,id);assert row.user_id==user['id']
        assert set(row.snapshot)=={'preferences','items','warnings','mode'}


def test_public_empty_and_unconfirmed_are_not_saved(accounts,record):
    register(accounts);add_work(accounts,record)
    body={'preferences':{'soft_preferences':{'genres':['修仙']}}}
    assert accounts.post('/api/v1/recommendations',json=body).json()['status']=='success'
    assert generate(accounts,preferences={}).json()['status']=='needs_confirmation'
    assert generate(accounts,exclude_work_ids=['work-a']).json()['status']=='empty'
    assert accounts.get('/api/v1/me/history').json()['total']==0
    assert accounts.post('/api/v1/me/history',json={'snapshot':body,'user_id':'other'}).status_code==405


def test_batch_saved_separately_and_newest_first_paginated(accounts,record):
    register(accounts)
    for i in range(5):add_work(accounts,record,f'work-{i}')
    first=generate(accounts).json();second=generate(accounts,exclude_work_ids=[w['id'] for w in first['items']]).json()
    assert len(first['items'])==3 and len(second['items'])==2
    assert first['history']['id']!=second['history']['id']
    response=accounts.get('/api/v1/me/history?page_size=1').json()
    assert response['total']==2 and response['items'][0]['id']==second['history']['id'] and response['items'][0]['count']==2
    assert accounts.get('/api/v1/me/history?page=2&page_size=1').json()['items'][0]['id']==first['history']['id']


def test_snapshots_survive_changed_deleted_and_withdrawn_works(accounts,record):
    register(accounts)
    for i in range(3):add_work(accounts,record,f'work-{i}')
    result=generate(accounts).json();id=result['history']['id']
    with accounts.app.state.sessions.begin() as session:
        changed=session.get(Work,'work-0');changed.summary='现有资料已经更新';changed.content_hash='b'*64
        session.get(Work,'work-1').review_status='pending'
        session.delete(session.get(Work,'work-2'))
    detail=accounts.get('/api/v1/me/history/'+id).json()['history']
    assert detail['count']==3
    assert detail['items'][0]['changed'] and detail['items'][0]['work']['summary']==record['summary']
    assert detail['items'][1]['work'] is None and not detail['items'][1]['available']
    assert detail['items'][2]['work'] is None and not detail['items'][2]['available']
    with accounts.app.state.sessions() as session:
        assert len(session.get(RecommendationHistory,id).snapshot['items'])==3


def test_delete_keeps_favorites_and_feedback(accounts,record):
    register(accounts);add_work(accounts,record);result=generate(accounts).json();id=result['history']['id']
    accounts.put('/api/v1/me/favorites/work-a')
    accounts.patch('/api/v1/me/feedback/work-a',json={'status':'watched','expected_revision':None})
    assert accounts.delete('/api/v1/me/history/'+id).status_code==204
    assert accounts.get('/api/v1/me/history/'+id).status_code==404
    assert accounts.get('/api/v1/me/favorites').json()['total']==1
    assert accounts.get('/api/v1/me/feedback/state').json()['items'][0]['status']=='watched'


@pytest.mark.parametrize('suffix',['?user_id=x','?username=x','?q=x','?page=0','?page_size=51'])
def test_history_rejects_extra_or_invalid_params(accounts,suffix):
    register(accounts);assert accounts.get('/api/v1/me/history'+suffix).status_code==422


def test_query_body_and_origin_guards(accounts,record):
    register(accounts);add_work(accounts,record);id=generate(accounts).json()['history']['id']
    assert accounts.delete('/api/v1/me/history/'+id,headers={'Origin':'https://wrong.example'}).status_code==403
    assert accounts.request('DELETE','/api/v1/me/history/'+id,json={'user_id':'x'}).status_code==422
    assert accounts.get('/api/v1/me/history/'+id+'?page=1').status_code==422
    assert accounts.get('/api/v1/me/history/invalid').status_code==422
    assert generate(accounts,query='字'*301).status_code==422
    assert generate(accounts,query=True).status_code==422
    assert generate(accounts,user_id='other').status_code==422
    assert accounts.get('/api/v1/me/history').json()['total']==1


def test_history_insert_failure_keeps_successful_recommendation_and_rolls_back(accounts,record):
    register(accounts);add_work(accounts,record)
    engine=accounts.app.state.engine
    def fail(connection,cursor,statement,parameters,context,many):
        if statement.startswith('INSERT INTO recommendation_history'):raise OperationalError(statement,parameters,RuntimeError('test unavailable'))
    event.listen(engine,'before_cursor_execute',fail)
    try:response=generate(accounts)
    finally:event.remove(engine,'before_cursor_execute',fail)
    assert response.status_code==200 and response.json()['status']=='success'
    assert response.json()['history']=={'status':'failed'} and response.json()['items']
    assert '未保存到历史' in response.json()['warnings'][-1]
    assert accounts.get('/api/v1/me/history').json()['total']==0
    assert generate(accounts).json()['history']['status']=='saved'


def test_failed_delete_retains_record(accounts,record):
    register(accounts);add_work(accounts,record);id=generate(accounts).json()['history']['id']
    engine=accounts.app.state.engine
    def fail(connection,cursor,statement,parameters,context,many):
        if statement.startswith('DELETE FROM recommendation_history'):raise OperationalError(statement,parameters,RuntimeError('test unavailable'))
    event.listen(engine,'before_cursor_execute',fail)
    try:assert accounts.delete('/api/v1/me/history/'+id).status_code==503
    finally:event.remove(engine,'before_cursor_execute',fail)
    assert accounts.get('/api/v1/me/history/'+id).status_code==200


def test_retention_and_account_cascade(accounts,record):
    user=register(accounts).json()['user'];add_work(accounts,record)
    first=generate(accounts).json()['history']['id']
    with accounts.app.state.sessions.begin() as session:
        row=session.get(RecommendationHistory,first)
        for i in range(104):session.add(RecommendationHistory(id=f'{i:032x}',user_id=user['id'],query='旧片单',snapshot=copy.deepcopy(row.snapshot),created_at=row.created_at))
    latest=generate(accounts).json()['history']['id']
    listing=accounts.get('/api/v1/me/history').json()
    assert listing['total']==100 and listing['items'][0]['id']==latest and listing['retention_limit']==100
    with accounts.app.state.sessions.begin() as session:session.execute(delete(User).where(User.id==user['id']))
    with accounts.app.state.sessions() as session:assert session.scalars(select(RecommendationHistory)).all()==[]


def test_password_revocation_during_save_cannot_create_history(accounts,record):
    register(accounts);add_work(accounts,record);token=accounts.cookies.get(COOKIE)
    reached,release=Event(),Event();auth=accounts.app.state.auth;original=auth.write
    @contextmanager
    def delayed(request,user_id,**kw):
        if request.url.path.endswith('/recommendations'):
            reached.set();assert release.wait(10)
        with original(request,user_id,**kw) as value:yield value
    auth.write=delayed
    with ThreadPoolExecutor() as pool:
        task=pool.submit(generate,accounts);assert reached.wait(10)
        with TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS) as other:
            other.cookies.set(COOKIE,token)
            assert other.post('/api/v1/me/password',json=password_body()).status_code==204
        release.set();assert task.result(10).status_code==401
    with accounts.app.state.sessions() as session:assert session.scalars(select(RecommendationHistory)).all()==[]


def test_0008_upgrade_backup_repeat_and_failure_rollback(tmp_path,monkeypatch):
    path=tmp_path/'history-upgrade.db';url=f'sqlite:///{path.as_posix()}';monkeypatch.setenv('DATABASE_URL',url)
    config=Config(str(ROOT/'backend/alembic.ini'));command.upgrade(config,'0008');engine,_=make_database(url)
    with engine.begin() as connection:
        connection.exec_driver_sql("INSERT INTO users(id,username,username_key,password_hash,avatar_id,created_at) VALUES ('legacy','old','old','unchanged','kiwi-sun','2026-10-27')")
    def fail(connection,cursor,statement,parameters,context,many):
        if statement.startswith('CREATE INDEX ix_history_user_created'):raise RuntimeError('test migration failure')
    event.listen(engine,'before_cursor_execute',fail)
    with pytest.raises(RuntimeError,match='migration failure'):initialize(engine)
    event.remove(engine,'before_cursor_execute',fail)
    with engine.connect() as connection:assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar()=='0008'
    assert not inspect(engine).has_table('recommendation_history')
    assert list(tmp_path.glob('*.before-profiles-*.bak'))
    initialize(engine);initialize(engine)
    with engine.connect() as connection:
        assert connection.exec_driver_sql('SELECT version_num FROM alembic_version').scalar()=='0009'
        assert connection.exec_driver_sql('SELECT password_hash,avatar_id FROM users').one()==('unchanged','kiwi-sun')
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all()==[]
    engine.dispose()
