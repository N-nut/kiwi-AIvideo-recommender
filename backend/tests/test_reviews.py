"""Atomic publication, concurrency, revocation and protected ingestion."""
import asyncio
import copy
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from conftest import FakeAI
from kiwi.database import Work, WorkCorrection, WorkReviewEvent, WorkReviewState
from kiwi.importer import import_works
from kiwi.providers import ProviderError
from kiwi.reviews import Inflight, set_reviewer
from kiwi.reviewing import work_data
from test_accounts import accounts, register, login, HEADERS
from test_corrections import report, seed, submission


def reviewer(client):
    user=register(client,'Reviewer').json()['user']
    set_reviewer(client.app.state.sessions,client.app.state.settings,user['id'],True,'合成测试审核授权')
    return user


def action(client,row,**extra):
    current=client.get('/api/v1/me/review/corrections/'+row['id']).json()
    work=current['work'];body={'operation_id':uuid.uuid4().hex,'action':'approve',
        'expected_work_revision':work['review']['revision'],'expected_report_revision':current['correction']['revision'],
        'changes':[{'field':row['field'],'value':None,'basis':{'kind':'not_stated','source_url':work['source_url'],'source_text':work['original_intro'],'quote':None}}],
        'reason':'所核对资料未说明后宫，恢复未知',**extra}
    return body


def post(client,row,body):
    return client.post('/api/v1/me/review/corrections/'+row['id']+'/actions',json=body)


def test_approve_unknown_replay_audit_scope_and_private_result(accounts,record):
    submitter=register(accounts).json()['user'];seed(accounts,record);row=report(accounts);reviewer(accounts)
    body=action(accounts,row);response=post(accounts,row,body)
    assert response.status_code==200,response.text
    data=response.json();assert data['correction']['status']=='accepted' and data['work']['harem'] is None
    assert data['work']['review']=={'revision':2,'state':'partial','confirmed_fields':['harem'],'recheck_fields':[]}
    assert data['embedding']['calls']==0
    assert post(accounts,row,body).json()['replayed']
    assert post(accounts,row,{**body,'reason':'不同内容'}).status_code==409
    assert accounts.get('/api/v1/me/review/operations/'+body['operation_id']).status_code==200
    # Submission receipt endpoint cannot read a review action.
    assert accounts.get('/api/v1/me/corrections/operations/'+body['operation_id']).status_code==404
    login(accounts)
    mine=accounts.get('/api/v1/me/corrections/'+row['id']).json()['correction']
    assert mine['status']=='accepted' and 'actor_id' not in mine
    public=accounts.get('/api/v1/works/work-a').json()
    assert 'description' not in public and 'confirmed_fields' not in public
    with accounts.app.state.sessions() as s:
        events=list(s.scalars(select(WorkReviewEvent).where(WorkReviewEvent.kind=='approve')))
        assert len(events)==1 and events[0].payload['changes'][0]['before'] is False


def test_reject_proactive_rebase_and_terminal_links(accounts,record):
    register(accounts);seed(accounts,record);row=report(accounts);reviewer(accounts)
    reject={'operation_id':uuid.uuid4().hex,'action':'reject','expected_report_revision':row['revision'],'reason':'资料暂不足以确认，未修改作品'}
    assert post(accounts,row,reject).status_code==200
    assert accounts.get('/api/v1/works/work-a').json()['harem'] is False
    assert post(accounts,row,{**reject,'operation_id':uuid.uuid4().hex}).status_code==409
    new=submission(accounts,related_correction_id=row['id'],description='主动核对后补充资料')
    made=accounts.post('/api/v1/me/review/works/work-a/corrections',json=new)
    assert made.status_code==201 and made.json()['correction']['origin']=='reviewer'
    newrow=made.json()['correction']
    with accounts.app.state.sessions.begin() as s:
        from kiwi.corrections import bump,invalidate_reports
        state=s.get(WorkReviewState,'work-a');bump(s,state);invalidate_reports(s,'work-a')
    assert post(accounts,newrow,action(accounts,newrow)).status_code==409
    current=accounts.get('/api/v1/me/review/corrections/'+newrow['id']).json()
    reb={'operation_id':uuid.uuid4().hex,'action':'rebase','expected_report_revision':current['correction']['revision'],'expected_work_revision':2,'reason':'已重新阅读最新来源与差异'}
    assert post(accounts,newrow,reb).json()['correction']['status']=='pending'
    assert post(accounts,newrow,action(accounts,newrow)).status_code==200


@pytest.mark.parametrize('change',[
    {'value':False,'basis':{'kind':'not_stated','source_url':'https://example.org/works/a','source_text':'未说明','quote':None}},
    {'value':None,'basis':{'kind':'not_stated','source_url':'https://evil.example','source_text':'未说明','quote':None}},
    {'value':False,'basis':{'kind':'quoted','source_url':'https://example.org/works/a','source_text':'原文没有此句','quote':'伪造引文'}},
    {'field':'romance','value':None}, {'value':'false'}, {'trusted':True},
])
def test_invalid_or_unrelated_approval_cannot_publish(accounts,record,change):
    register(accounts);seed(accounts,record);row=report(accounts);reviewer(accounts)
    body=action(accounts,row);body['changes'][0].update(change)
    assert post(accounts,row,body).status_code==422
    assert accounts.get('/api/v1/me/review/corrections/'+row['id']).json()['correction']['status']=='pending'
    assert accounts.get('/api/v1/works/work-a').json()['harem'] is False


async def test_manual_null_survives_import_reembed_and_source_diffs(accounts,record):
    register(accounts);seed(accounts,record);row=report(accounts);reviewer(accounts)
    assert post(accounts,row,action(accounts,row)).status_code==200
    sessions=accounts.app.state.sessions;settings=accounts.app.state.settings
    with sessions() as s:
        original=copy.deepcopy(s.get(WorkReviewState,'work-a').source_snapshot['data'])
    original['summary']='少年修仙，踏上逆袭成长的新旅程。'
    result=await import_works([original],sessions,None,settings,update=True)
    assert result['imported']==1
    current=accounts.get('/api/v1/works/work-a').json()
    assert current['harem'] is None and current['review']['confirmed_fields']==['harem']
    # A change to supporting introduction also needs renewed human review.
    changed=copy.deepcopy(original);changed['original_intro']+='来源新增了一段说明。'
    await import_works([changed],sessions,None,settings,update=True)
    current=accounts.get('/api/v1/works/work-a').json()
    assert current['harem'] is None and current['review']['state']=='recheck'
    version=current['review']['revision']
    await import_works([changed],sessions,None,settings,update=True)
    assert accounts.get('/api/v1/works/work-a').json()['review']['revision']==version
    with sessions() as s:effective=work_data(s.get(Work,'work-a'))
    await import_works([effective],sessions,None,settings,reembed=True,update=True)
    assert accounts.get('/api/v1/works/work-a').json()['harem'] is None


def test_embedding_failure_timeout_invalid_vectors_and_baseline_clear(accounts,record):
    register(accounts);seed(accounts,record);row=report(accounts,category='basic',field='title',suggestion={'kind':'set','value':'核对新名称'})
    reviewer(accounts);body=action(accounts,row)
    body['changes']=[{'field':'title','value':'核对新名称','basis':{'kind':'quoted','source_url':'https://example.org/works/a','source_text':'核对新名称','quote':'核对新名称'}}]
    settings=accounts.app.state.settings;settings.ai_mode='live'
    class Fail(FakeAI):
        async def embed(self,texts):raise ProviderError()
    accounts.app.state.provider_factory=Fail
    assert post(accounts,row,body).status_code==503
    assert accounts.get('/api/v1/works/work-a').json()['title']==record['title']
    assert accounts.get('/api/v1/me/review/corrections/'+row['id']).json()['correction']['status']=='pending'
    class Invalid(FakeAI):
        async def embed(self,texts):return [[0.0]*1024]
    accounts.app.state.provider_factory=Invalid
    assert post(accounts,row,body).status_code==503
    class Timeout(FakeAI):
        async def embed(self,texts):raise TimeoutError()
    accounts.app.state.provider_factory=Timeout
    assert post(accounts,row,body).status_code==504
    settings.ai_mode='baseline'
    with accounts.app.state.sessions.begin() as s:
        w=s.get(Work,'work-a');w.embedding=[1.0]+[0.0]*1023;w.embedding_model=settings.embedding_model;w.embedding_dimension=1024
    accepted=post(accounts,row,body);assert accepted.status_code==200,accepted.text
    assert accepted.json()['embedding']['action']=='baseline_only'
    with accounts.app.state.sessions() as s:assert s.get(Work,'work-a').embedding is None


def test_two_native_sqlite_connections_one_publication(accounts,record):
    register(accounts);seed(accounts,record);row=report(accounts);reviewer(accounts)
    body=action(accounts,row)
    def run(operation):
        with TestClient(accounts.app,base_url='http://127.0.0.1:8000',headers=HEADERS) as second:
            login(second,'Reviewer')
            return post(second,row,{**body,'operation_id':operation}).status_code
    with ThreadPoolExecutor(2) as pool:
        statuses=list(pool.map(run,[uuid.uuid4().hex,uuid.uuid4().hex]))
    assert sorted(statuses)==[200,409]
    with accounts.app.state.sessions() as s:
        assert len(list(s.scalars(select(WorkReviewEvent).where(WorkReviewEvent.kind=='approve'))))==1
        assert s.get(WorkReviewState,'work-a').revision==2


def test_revocation_during_preparation_blocks_final_write(accounts,record):
    register(accounts);seed(accounts,record);row=report(accounts);user=reviewer(accounts)
    body=action(accounts,row);started=Event();release=Event()
    class Wait(FakeAI):
        async def embed(self,texts):
            started.set();await asyncio.to_thread(release.wait,10)
            return await super().embed(texts)
    accounts.app.state.provider_factory=Wait;accounts.app.state.settings.ai_mode='live'
    with ThreadPoolExecutor(1) as pool:
        future=pool.submit(post,accounts,row,body)
        try:
            assert started.wait(5)
            set_reviewer(accounts.app.state.sessions,accounts.app.state.settings,user['id'],False,'合成撤权竞争')
        finally:release.set()
        assert future.result().status_code==403
    assert accounts.get('/api/v1/works/work-a').json()['harem'] is False
    assert accounts.get('/api/v1/me/review/operations/'+body['operation_id']).status_code==403


def test_pause_restore_preserves_relations_and_media_hold(accounts,record):
    register(accounts);seed(accounts,record);accounts.put('/api/v1/me/favorites/work-a');row=report(accounts);reviewer(accounts)
    body=action(accounts,row);assert post(accounts,row,body).status_code==200
    endpoint='/api/v1/me/review/works/work-a/availability'
    paused=accounts.post(endpoint,json={'operation_id':uuid.uuid4().hex,'action':'pause','expected_work_revision':2,'reason':'来源对应需要核对','media_hold':True})
    assert paused.status_code==200,paused.text
    assert accounts.get('/api/v1/works/work-a').status_code==404
    assert accounts.get('/api/v1/works/work-a/preview').status_code==404
    restored=accounts.post(endpoint,json={'operation_id':uuid.uuid4().hex,'action':'restore','expected_work_revision':3,'reason':'已核对资料，恢复作品展示'})
    assert restored.status_code==200,restored.text
    assert accounts.get('/api/v1/works/work-a/preview').json()['status']=='unavailable'
    login(accounts)
    assert accounts.get('/api/v1/me/favorites/ids').json()['relation_total']==1


def test_receipt_insert_failure_rolls_back_work_state_and_report(accounts,record):
    from sqlalchemy import event
    from sqlalchemy.exc import OperationalError
    register(accounts);seed(accounts,record);row=report(accounts);reviewer(accounts);body=action(accounts,row)
    def fail(connection,cursor,statement,parameters,context,many):
        if statement.startswith('INSERT INTO work_review_events'):raise OperationalError('synthetic',{},Exception('receipt failed'))
    event.listen(accounts.app.state.engine,'before_cursor_execute',fail)
    try:assert post(accounts,row,body).status_code==503
    finally:event.remove(accounts.app.state.engine,'before_cursor_execute',fail)
    current=accounts.get('/api/v1/works/work-a').json()
    assert current['harem'] is False and current['review']['revision']==1
    assert accounts.get('/api/v1/me/review/corrections/'+row['id']).json()['correction']['status']=='pending'
    assert post(accounts,row,body).status_code==200


def test_existing_vector_reused_for_hard_fact_only_and_external_evidence_context(accounts,record):
    register(accounts);seed(accounts,record);row=report(accounts);reviewer(accounts)
    settings=accounts.app.state.settings;settings.ai_mode='live'
    with accounts.app.state.sessions.begin() as s:
        w=s.get(Work,'work-a');w.embedding=[1.0]+[0.0]*1023;w.embedding_model=settings.embedding_model;w.embedding_dimension=1024
    class NoEmbed(FakeAI):
        async def embed(self,texts):raise AssertionError('Hard fact with a current vector needs no embedding')
    accounts.app.state.provider_factory=NoEmbed
    body=action(accounts,row);body['changes'][0].update(value=True,basis={'kind':'quoted','source_url':'https://example.org/works/a','source_text':'本作确有后宫情节。','quote':'确有后宫情节'})
    accepted=post(accounts,row,body);assert accepted.status_code==200,accepted.text
    assert accepted.json()['embedding']=={'action':'reused','calls':0}
    with accounts.app.state.sessions() as s:
        w=s.get(Work,'work-a');assert w.harem is True
        data=work_data(w)
    from kiwi.schemas import WorkInput
    from pydantic import ValidationError
    with pytest.raises(ValidationError):WorkInput.model_validate(data)
    # Ordinary callers cannot forge the server-only evidence channel in JSON.
    with pytest.raises(ValidationError):WorkInput.model_validate({**data,'trusted':True})


async def test_import_does_not_overwrite_review_during_embedding(accounts,record):
    register(accounts);seed(accounts,record);row=report(accounts);reviewer(accounts)
    settings=accounts.app.state.settings;settings.ai_mode='live';sessions=accounts.app.state.sessions
    with sessions() as s:data=work_data(s.get(Work,'work-a'))
    data['title']='采集等待中的旧稿'
    body=action(accounts,row)
    class Race(FakeAI):
        async def embed(self,texts):
            # Review runs on the server's native connection while preparation
            # deliberately holds no application-data write lock.
            settings.ai_mode='baseline'
            assert post(accounts,row,body).status_code==200
            settings.ai_mode='live'
            return await super().embed(texts)
    with pytest.raises(ValueError,match='同步期间已改变'):
        await import_works([data],sessions,Race(),settings,update=True)
    current=accounts.get('/api/v1/works/work-a').json()
    assert current['harem'] is None and current['title']==record['title']


def test_media_hold_blocks_old_get_head_and_offline_or_inflight_publication(accounts,record,tmp_path):
    from test_previews import ready,ASSET
    from kiwi.preview_importer import publishing,MediaError
    register(accounts);seed(accounts,record);reviewer(accounts)
    accounts.app.state.settings.media_root=tmp_path
    with accounts.app.state.sessions.begin() as s:
        s.get(Work,'work-a').source_meta={'provider':'hongguo','content_type':'漫剧','pages':['https://example.org/works/a']}
    ready(accounts.app.state.sessions,tmp_path)
    url='/api/v1/media/previews/'+ASSET+'/video'
    assert accounts.get(url).status_code==200 and accounts.head(url).status_code==200
    endpoint='/api/v1/me/review/works/work-a/availability'
    result=accounts.post(endpoint,json={'operation_id':uuid.uuid4().hex,'action':'pause','expected_work_revision':1,'reason':'确认预览对应错误，停止使用','media_hold':True})
    assert result.status_code==200
    assert accounts.get(url).status_code==404 and accounts.head(url).status_code==404
    with pytest.raises(MediaError):
        with publishing(accounts.app.state.sessions,'work-a',1):
            raise AssertionError('A stale publisher must not enter its write section')


async def test_recommendation_rejects_revision_change_even_when_content_hash_equal(database,record,baseline_settings):
    from kiwi.service import recommend
    from kiwi.schemas import RecommendationRequest
    from kiwi.corrections import bump
    from fastapi import HTTPException
    settings=baseline_settings.model_copy(update={'ai_mode':'live'})
    await import_works([record],database,FakeAI(),settings)
    class Race(FakeAI):
        async def reasons(self,prefs,works):
            with database.begin() as s:bump(s,s.get(WorkReviewState,'work-a'))
            return await super().reasons(prefs,works)
    body=RecommendationRequest(preferences={'soft_preferences':{'genres':['修仙']}})
    with pytest.raises(HTTPException) as exc:await recommend(body,database,Race(),settings,'revision-test')
    assert exc.value.status_code==409 and exc.value.detail['code']=='catalog_changed'


@pytest.mark.parametrize('field',['preview_mapping','source_link','work_identity'])
def test_mapping_adoption_pauses_content_atomically_without_replacing_identity(accounts,record,field):
    register(accounts);seed(accounts,record);row=report(accounts,category='mapping',field=field,suggestion={'kind':'issue'})
    reviewer(accounts);body=action(accounts,row)
    body['changes']=[{'field':field,'value':'unavailable','basis':{'kind':'quoted','source_url':record['source_url'],
        'source_text':'经人工核对，当前对应关系有误。','quote':'当前对应关系有误'}}]
    response=post(accounts,row,body);assert response.status_code==200,response.text
    data=response.json();assert data['correction']['status']=='accepted' and data['work']['id']=='work-a'
    assert data['work']['source_url']==record['source_url']
    with accounts.app.state.sessions() as s:
        state=s.get(WorkReviewState,'work-a')
        assert state.media_hold if field=='preview_mapping' else state.manual_hold
    if field!='preview_mapping':
        restore=accounts.post('/api/v1/me/review/works/work-a/availability',json={'action':'restore','operation_id':uuid.uuid4().hex,
            'expected_work_revision':2,'reason':'尚未修复对应问题，不能仅写理由恢复'})
        assert restore.status_code==422
