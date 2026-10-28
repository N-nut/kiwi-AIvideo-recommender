"""Report privacy, strict inputs, durable aliases and migration rollback."""
import copy
import uuid

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import event, inspect, select
from sqlalchemy.exc import IntegrityError, OperationalError

from kiwi.config import ROOT
from kiwi.database import Work, WorkCorrection, WorkReviewEvent, WorkReviewState, initialize, make_database
from test_accounts import accounts, add_work, login, register


def submission(client, **extra):
    current = client.get('/api/v1/works/work-a').json()
    return {"operation_id":uuid.uuid4().hex,"work_id":"work-a","base_revision":current["review"]["revision"],
        "category":"plot_fact","field":"harem","suggestion":{"kind":"unknown"},
        "description":"  简介没有说明后宫情况，建议恢复未知。  ","source_hint":None,"related_correction_id":None,**extra}


def report(client, **extra):
    response = client.post('/api/v1/me/corrections',json=submission(client,**extra))
    assert response.status_code in (200,201), response.text
    return response.json()['correction']


def seed(client, record):
    data=copy.deepcopy(record)
    data['original_intro']='少年修仙，逆袭成长。'
    data['evidence']=[{**e,'quote':data['original_intro']} for e in data['evidence']]
    add_work(client,data)


def test_default_no_role_private_ownership_and_no_public_change(accounts,record):
    assert accounts.get('/api/v1/me/corrections').status_code==401
    user=register(accounts).json()['user'];seed(accounts,record)
    assert accounts.get('/api/v1/me/review-access').json()=={'can_review':False}
    assert accounts.get('/api/v1/me/review/corrections').status_code==403
    before=accounts.get('/api/v1/works/work-a').json()
    row=report(accounts)
    assert row['status']=='pending' and row['current_value'] is False
    assert row['description']==row['description'].strip()
    assert accounts.get('/api/v1/works/work-a').json()==before
    assert 'description' not in str(before) and 'is_reviewer' not in user
    listing=accounts.get('/api/v1/me/corrections')
    assert listing.headers['cache-control']=='no-store' and listing.json()['total']==1
    assert accounts.get('/api/v1/me/corrections/'+row['id']).json()['correction']==row
    register(accounts,'Another')
    assert accounts.get('/api/v1/me/corrections').json()['total']==0
    assert accounts.get('/api/v1/me/corrections/'+row['id']).status_code==404
    assert accounts.get('/api/v1/me/corrections?user_id='+user['id']).status_code==422
    assert accounts.post('/api/v1/auth/register',json={'username':'RoleFake','password':'abcdefgh123','confirm_password':'abcdefgh123','is_reviewer':True}).status_code==422


@pytest.mark.parametrize('extra',[
    {'field':'password_hash'}, {'category':'tags'}, {'base_revision':True}, {'base_revision':'1'}, {'base_revision':0},
    {'base_revision':2147483648}, {'suggestion':{'kind':'unknown','value':False}}, {'suggestion':{'kind':'set','value':'false'}},
    {'suggestion':{'kind':'set','value':0}}, {'suggestion':{'kind':'issue'}}, {'description':'   '}, {'description':'字'*501},
    {'source_hint':{'url':'file:///a'}}, {'source_hint':{'url':'https://user:pass@example.org'}},
    {'source_hint':{'url':'javascript:alert(1)'}}, {'source_hint':{'quote':'a'*1001}}, {'trusted':True},
    {'user_id':'other'}, {'status':'accepted'}, {'operation_id':'bad'},
    {'category':'mapping','field':'preview_mapping','suggestion':{'kind':'set','value':'https://example.org/movie.mp4'}},
])
def test_strict_submission_rejects_forged_values(accounts,record,extra):
    register(accounts);seed(accounts,record)
    response=accounts.post('/api/v1/me/corrections',json=submission(accounts,**extra))
    assert response.status_code==422,response.text
    assert response.headers['cache-control']=='no-store'
    assert accounts.get('/api/v1/me/corrections').json()['total']==0


def test_idempotency_aliases_survive_terminal_status(accounts,record):
    register(accounts);seed(accounts,record)
    body=submission(accounts);first=accounts.post('/api/v1/me/corrections',json=body)
    assert first.status_code==201
    alias={**body,'operation_id':uuid.uuid4().hex}
    second=accounts.post('/api/v1/me/corrections',json=alias)
    assert second.status_code==200 and second.json()['deduplicated']
    identifier=first.json()['correction']['id'];assert second.json()['correction']['id']==identifier
    with accounts.app.state.sessions.begin() as session:
        row=session.get(WorkCorrection,identifier);row.status='rejected';row.active_key=None;row.decision='合成处理结果'
    replay=accounts.post('/api/v1/me/corrections',json=alias)
    assert replay.status_code==200 and replay.json()['correction']['status']=='rejected'
    receipt=accounts.get('/api/v1/me/corrections/operations/'+alias['operation_id'])
    assert receipt.json()['correction']['status']=='rejected'
    assert accounts.post('/api/v1/me/corrections',json={**body,'description':'不同内容'}).status_code==409
    assert accounts.get('/api/v1/me/corrections').json()['total']==1
    assert accounts.get('/api/v1/me/corrections/operations/'+'f'*32).status_code==404


def test_source_hint_text_only_limits_and_write_protection(accounts,record):
    register(accounts);seed(accounts,record)
    row=report(accounts,source_hint={'url':'https://example.org/clue','quote':'<script>not public</script>'},description='😀'*500)
    assert row['source_hint']['quote'].startswith('<script>')
    stale=submission(accounts,base_revision=2)
    assert accounts.post('/api/v1/me/corrections',json=stale).status_code==409
    assert accounts.post('/api/v1/me/corrections',json=submission(accounts),headers={'Origin':'https://evil.example'}).status_code==403
    assert accounts.get('/api/v1/me/corrections?sort=private').status_code==422
    assert accounts.post('/api/v1/me/corrections',content=b' '*24001,headers={'Content-Type':'application/json'}).status_code==413
    for i in range(9):
        assert accounts.post('/api/v1/me/corrections',json=submission(accounts,description=f'不同问题{i}')).status_code==201
    limited=accounts.post('/api/v1/me/corrections',json=submission(accounts,description='超过速率'))
    assert limited.status_code==429 and int(limited.headers['retry-after'])>0


def test_0009_to_0010_backup_atomic_retry_preserves_old_rows(tmp_path,monkeypatch,record):
    path=tmp_path/'review-upgrade.db';url=f'sqlite:///{path.as_posix()}';monkeypatch.setenv('DATABASE_URL',url)
    config=Config(str(ROOT/'backend/alembic.ini'));command.upgrade(config,'0009')
    engine,_=make_database(url)
    with engine.begin() as c:
        c.execute(Work.__table__.insert().values(**record,content_hash='a'*64,embedding=[1.0]+[0.0]*1023))
        c.exec_driver_sql("INSERT INTO users(id,username,username_key,password_hash,created_at,avatar_id) VALUES ('u','Old','old','preserved',CURRENT_TIMESTAMP,'kiwi-default')")
        c.exec_driver_sql("INSERT INTO favorites VALUES ('u','work-a',CURRENT_TIMESTAMP)")
        before={name:c.exec_driver_sql('SELECT * FROM '+name).all() for name in ('works','users','favorites')}
    def fail(connection,cursor,statement,parameters,context,many):
        if 'CREATE TABLE work_corrections' in statement:raise OperationalError('synthetic',{},Exception('failed'))
    event.listen(engine,'before_cursor_execute',fail)
    try:
        with pytest.raises(OperationalError):initialize(engine)
    finally:event.remove(engine,'before_cursor_execute',fail)
    with engine.connect() as c:
        assert c.exec_driver_sql('SELECT version_num FROM alembic_version').scalar()=='0009'
        assert 'is_reviewer' not in {i['name'] for i in inspect(c).get_columns('users')}
    initialize(engine);initialize(engine)
    with engine.connect() as c:
        assert c.exec_driver_sql('SELECT version_num FROM alembic_version').scalar()=='0010'
        assert c.exec_driver_sql('SELECT * FROM works').all()==before['works']
        assert c.exec_driver_sql('SELECT * FROM favorites').all()==before['favorites']
        assert c.exec_driver_sql('SELECT is_reviewer FROM users').scalar()==0
        assert c.exec_driver_sql('PRAGMA foreign_key_check').all()==[]
        assert c.exec_driver_sql('SELECT source_snapshot FROM work_review_state').scalar().find('legacy_snapshot')>=0
        with pytest.raises(IntegrityError):c.exec_driver_sql("DELETE FROM works WHERE id='work-a'")
    assert list(tmp_path.glob('*.bak'));engine.dispose()
