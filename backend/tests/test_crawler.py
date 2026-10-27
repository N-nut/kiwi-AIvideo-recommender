import asyncio
import copy
import html
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select, text

from kiwi.catalog import CatalogManager
from kiwi.config import Settings
from kiwi.crawler import CATEGORY_LABELS, SOURCE_URLS, CrawlError, collect_hongguo, normalize, page_url, parse_page
from kiwi.database import Work, initialize
from kiwi.importer import import_works
from kiwi.main import create_app
from kiwi.schemas import RefreshRequest, WorkInput
from conftest import FakeAI


def category_row(sid="12345678", title="采集测试作品"):
    return {"series_id": sid, "series_name": title, "series_intro": "少年穿越异界，一路修行与成长。",
            "series_cover": "https://p3-novel.byteimg.com/test.image", "tags": ["玄幻", "穿越", "修真"], "episode_cnt": 30}


def rank_row(sid="12345678"):
    row=category_row(sid)
    return {"seriesId":sid,"title":row["series_name"],"description":row["series_intro"],"tags":["玄幻","AI剧"],
            "cover":row["series_cover"],"rank":1,"heatText":"123万热度","episodeCount":30}


def page(rows, key="real-drama", number=1, total=1, style="resolved", pagination=None):
    pagination=pagination or {"pageNum":number,"totalPages":total,"total":len(rows) if total<=1 else 100}
    content={"isSuccess":True,"rankList" if key=="rank" else "recommendList":rows,"pagination":pagination}
    if key!="rank" or style=="direct":
        return '<script>_ROUTER_DATA = '+json.dumps({"loaderData":{"route":content}})+';</script>'
    if style=="promise":
        args=["rank",[{"key":"content","routerDataFnName":"p","routerDataFnArgs":[json.dumps(content)]}]]
        return '<script data-fn-name="mergeLoaderData" data-fn-args="'+html.escape(json.dumps(args),quote=True)+'"></script>'
    pending=["rank",[{"key":"content","routerDataFnName":"s","routerDataFnArgs":['"rank"','"content"']}]]
    return '<script data-fn-name="mergeLoaderData" data-fn-args="'+html.escape(json.dumps(pending),quote=True)+'"></script><script data-script-src="modern-run-router-data-fn" data-fn-args="'+html.escape(json.dumps(["rank","content",content]),quote=True)+'"></script>'


@pytest.fixture(autouse=True)
def no_real_delays(monkeypatch):
    sleep=asyncio.sleep
    async def fast(_): await sleep(0)
    monkeypatch.setattr('kiwi.crawler.asyncio.sleep',fast)


@pytest.mark.parametrize("style",["direct","promise","resolved"])
def test_public_stream_formats(style):
    rows,total=parse_page(page([rank_row()],"rank",style=style),"rank")
    work=WorkInput.model_validate(normalize(rows[0],"rank","2026-10-22"))
    assert total==1 and work.source_meta.rank==1 and work.source_meta.content_type=="AI剧"
    assert work.harem is None and work.tragic is None and work.pace is None
    assert all(e.quote in work.original_intro for e in work.evidence)


@pytest.mark.parametrize('key',CATEGORY_LABELS)
def test_all_category_types_and_comic_identity(key):
    work=normalize(category_row(),key,'2026-10-22')
    assert work['source_meta']['content_type']==CATEGORY_LABELS[key]
    if key=='comic':
        assert work['id']=='hongguo-comic-12345678' and work['source_url'].endswith('/comic/12345678')
        assert work['source_meta']['chapter_count']==30 and work['source_meta']['episode_count'] is None
    else: assert work['source_meta']['episode_count']==30


@pytest.mark.parametrize('body',['<html>验证页面</html>',page([],total=2),'<script>_ROUTER_DATA=bad()</script>'])
def test_missing_or_unexpected_empty_page_is_an_error(body):
    with pytest.raises(CrawlError): parse_page(body,'real-drama')


def test_explicit_empty_source_is_valid_and_pagination_is_checked():
    assert parse_page(page([],total=0),'real-drama')==([],0)
    with pytest.raises(CrawlError): parse_page(page([category_row()]),'real-drama',2)
    with pytest.raises(CrawlError): parse_page(page([category_row()],pagination={'pageNum':1,'totalPages':False}),'real-drama')


@pytest.mark.parametrize('url',['https://evil.test/?page=2','http://hongguoduanju.com/category/real-drama?page=2',
    'https://hongguoduanju.com/category/comic?page=2','https://hongguoduanju.com/category/real-drama?page=1'])
def test_untrusted_next_page_is_not_followed(url):
    with pytest.raises(CrawlError):
        parse_page(page([category_row()],pagination={'pageNum':1,'totalPages':2,'nextUrl':url}),'real-drama')


@pytest.mark.parametrize('cover',['http://p3-novel.byteimg.com/a','https://evil.test/a','file:///etc/passwd','https://p3-novel.byteimg.com.evil.test/a'])
def test_untrusted_media_is_rejected(cover):
    row=category_row();row['series_cover']=cover
    with pytest.raises(CrawlError): normalize(row,'real-drama','2026-10-22')


@pytest.mark.parametrize('duplicates',[1,2])
async def test_fixed_sources_pagination_and_identity_merge(duplicates):
    visited=[];progress=[]
    def handle(request):
        url=str(request.url);visited.append(url)
        if request.url.path.startswith('/rank'):
            return httpx.Response(200,text=page([rank_row()],'rank'))
        number=int(request.url.params.get('page','1'))
        rows=[category_row('12345678' if number==1 else '87654321')]*duplicates
        return httpx.Response(200,text=page(rows,number=number,total=2))
    scope=RefreshRequest(categories=['real-drama'],include_hot_rank=True)
    rows,meta=await collect_hongguo(scope,progress.append,transport=httpx.MockTransport(handle))
    assert visited==[page_url('real-drama',1),page_url('real-drama',2),page_url('rank',1)]
    assert len(rows)==2 and meta['pages_done']==3 and meta['coverage']=='complete'
    assert meta['raw_count']==duplicates*2+1 and rows[0]['source_meta']['rank']==1
    assert rows[0]['source_meta']['content_type']=='真人剧' and rows[0]['source_meta']['pages']==[page_url('rank',1),page_url('real-drama',1)]
    assert progress[-1]['unique_count']==2


async def test_selecting_categories_changes_only_allowed_routes():
    visited=[]
    def handle(request):
        visited.append(request.url.path)
        return httpx.Response(200,text=page([category_row()],key=request.url.path.split('/')[-1]))
    rows,_=await collect_hongguo(RefreshRequest(categories=['comic','ai-drama']),transport=httpx.MockTransport(handle))
    assert visited==['/category/comic','/category/ai-drama'] and len(rows)==2
    assert rows[0]['id']!=rows[1]['id']


async def test_cleaning_discards_unknown_types_after_explicit_category_merge():
    ambiguous=rank_row('22222222');ambiguous['tags']=['玄幻','修真']
    known_same_id=rank_row();known_same_id['tags']=['玄幻']
    typed=rank_row('33333333')
    def handle(request):
        if request.url.path.startswith('/rank'):
            return httpx.Response(200,text=page([known_same_id,ambiguous,typed],'rank'))
        return httpx.Response(200,text=page([category_row()],'comic-drama'))
    rows,meta=await collect_hongguo(RefreshRequest(categories=['comic-drama'],include_hot_rank=True),transport=httpx.MockTransport(handle))
    assert {r['id'] for r in rows}=={'hongguo-12345678','hongguo-33333333'}
    assert meta['raw_count']==4 and meta['discovered_count']==3 and meta['unique_count']==2
    assert meta['filtered_unclassified']==1
    assert rows[0]['source_meta']['content_type']=='漫剧' and rows[0]['source_meta']['rank']==1


async def test_ranking_only_does_not_guess_type_from_genre_or_title():
    row=rank_row();row['tags']=['修真','都市'];row['title']='像是AI剧的作品名称'
    transport=httpx.MockTransport(lambda request:httpx.Response(200,text=page([row],'rank')))
    rows,meta=await collect_hongguo(RefreshRequest(categories=[],include_hot_rank=True),transport=transport)
    assert rows==[] and meta['filtered_unclassified']==1 and meta['raw_count']==1


async def test_source_import_discards_untyped_rows_before_embedding_and_preserves_known_work(database):
    settings=Settings(ai_mode='live');provider=FakeAI()
    known=normalize(category_row(),'comic-drama','2026-10-22')
    await import_works([known],database,provider,settings,source_sync=True)
    raw=rank_row();raw['tags']=['玄幻'];untyped=normalize(raw,'rank','2026-10-22')
    result=await import_works([untyped],database,provider,settings,source_sync=True,update=True)
    assert result['filtered_unclassified']==1 and result['imported']==0 and provider.calls==1
    with database() as session: assert session.get(Work,known['id']).source_meta['content_type']=='漫剧'


@pytest.mark.parametrize('limit_kind',['source','pages','works'])
async def test_normal_limits_are_reported_without_claiming_full_sync(limit_kind):
    settings=Settings(crawl_pages_per_source=1 if limit_kind=='source' else 5,
        crawl_max_pages=1 if limit_kind=='pages' else 25,crawl_max_works=1 if limit_kind=='works' else 500)
    visited=[]
    def handle(request):
        visited.append(str(request.url));number=int(request.url.params.get('page','1'))
        return httpx.Response(200,text=page([category_row(str(10000000+number)),category_row(str(20000000+number))],number=number,total=3))
    rows,meta=await collect_hongguo(RefreshRequest(categories=['real-drama']),settings=settings,transport=httpx.MockTransport(handle))
    assert len(visited)==1 and meta['coverage']=='limited'
    assert len(rows)==(1 if limit_kind=='works' else 2)


async def test_repeated_pages_and_later_failures_abort_collection():
    def handle(request):
        number=int(request.url.params.get('page','1'))
        return httpx.Response(200,text=page([category_row()],number=number,total=2))
    with pytest.raises(CrawlError,match='重复'):
        await collect_hongguo(RefreshRequest(categories=['real-drama']),transport=httpx.MockTransport(handle))


async def test_redirects_are_not_followed():
    visited=[]
    def handle(request):
        visited.append(str(request.url));return httpx.Response(302,headers={'Location':'http://127.0.0.1/private'})
    with pytest.raises(CrawlError): await collect_hongguo(transport=httpx.MockTransport(handle))
    assert visited==[page_url('comic-drama',1)]


@pytest.mark.parametrize('status,expected',[(503,2),(429,2),(403,1)])
async def test_bounded_retries_and_access_rejection(status,expected):
    calls=[]
    def handle(request):
        calls.append(1)
        return httpx.Response(status,headers={'Retry-After':'0'}) if len(calls)==1 else httpx.Response(200,text=page([category_row()]))
    if status==403:
        with pytest.raises(CrawlError): await collect_hongguo(RefreshRequest(categories=['real-drama']),transport=httpx.MockTransport(handle))
    else: await collect_hongguo(RefreshRequest(categories=['real-drama']),transport=httpx.MockTransport(handle))
    assert len(calls)==expected


async def test_index_is_reused_when_only_heat_date_or_cover_changes(database):
    settings=Settings(ai_mode='live',database_url='sqlite:///:memory:');row=normalize(rank_row(),'rank','2026-10-22');provider=FakeAI()
    await import_works([row],database,provider,settings,update=True,source_sync=True)
    with database() as s: timestamp=s.get(Work,row['id']).embedded_at
    changed=copy.deepcopy(row);changed['collected_at']='2026-10-23';changed['source_meta']['heat']='200万热度'
    result=await import_works([changed],database,provider,settings,update=True,source_sync=True)
    assert provider.calls==1 and result['updated']==1 and result['embedded']==0
    with database() as s: assert s.get(Work,row['id']).embedded_at==timestamp
    assert (await import_works([changed],database,provider,settings,update=True,source_sync=True))['unchanged']==1


async def test_incremental_updates_never_delete_unseen_works_and_fail_atomically(database,record):
    settings=Settings(ai_mode='live',database_url='sqlite:///:memory:')
    old=normalize(rank_row(),'rank','2026-10-22');await import_works([old,record],database,FakeAI(),settings)
    new=normalize(category_row('98765432',title='新的测试作品'),'comic','2026-10-22')
    class Fail(FakeAI):
        async def embed(self,texts): raise RuntimeError('failed')
    with pytest.raises(RuntimeError): await import_works([new],database,Fail(),settings,update=True,source_sync=True)
    with database() as s: assert set(s.scalars(select(Work.id)))=={old['id'],record['id']}
    result=await import_works([new],database,FakeAI(),settings,update=True,source_sync=True)
    with database() as s: assert set(s.scalars(select(Work.id)))=={old['id'],record['id'],new['id']}
    assert result['new']==1 and result['removed']==0
    await import_works([],database,FakeAI(),settings,update=True,source_sync=True)
    with database() as s: assert len(list(s.scalars(select(Work.id))))==3


async def test_same_title_comic_and_video_coexist_and_rejected_status_survives(database,baseline_settings):
    video=normalize(category_row(),'comic-drama','2026-10-22');comic=normalize(category_row(),'comic','2026-10-22')
    result=await import_works([video,comic],database,None,baseline_settings,source_sync=True)
    assert result['new']==2 and result['same_title_groups']==1
    with database.begin() as s:
        work=s.get(Work,video['id']);work.review_status='rejected';work.review_note='人工拒绝'
    result=await import_works([video],database,None,baseline_settings,update=True,source_sync=True)
    with database() as s: assert s.get(Work,video['id']).review_status=='rejected' and s.get(Work,video['id']).review_note=='人工拒绝'
    assert result['review_held']==1


async def test_ranking_refresh_preserves_category_evidence_and_provenance(database):
    settings=Settings(ai_mode='live');provider=FakeAI()
    category=category_row();category['tags'].append('成长')
    original=normalize(category,'comic-drama','2026-10-22')
    await import_works([original],database,provider,settings,source_sync=True)
    rank=normalize(rank_row(),'rank','2026-10-23')
    await import_works([rank],database,provider,settings,update=True,source_sync=True)
    with database() as s:
        work=s.get(Work,original['id']);assert work.source_meta['content_type']=='漫剧' and work.source_meta['rank']==1
        assert set(work.source_meta['pages'])=={page_url('comic-drama',1),page_url('rank',1)}
        assert work.original_intro==original['original_intro'] and '成长' in work.themes
    assert provider.calls==1


async def test_existing_sqlite_upgrade_removes_only_retired_seed(record,tmp_path,monkeypatch):
    # Build an actual historical 0001 installation; a current schema with
    # arbitrarily removed tables must be rejected by the upgrade validator.
    from alembic import command
    from alembic.config import Config
    from kiwi.database import make_database
    from kiwi.config import ROOT
    url=f"sqlite:///{(tmp_path/'legacy.db').as_posix()}";monkeypatch.setenv('DATABASE_URL',url)
    command.upgrade(Config(str(ROOT/'backend/alembic.ini')),'0001')
    engine,database=make_database(url)
    legacy=copy.deepcopy(record);legacy.update(id='bili-45128',title='旧种子作品')
    with engine.begin() as c:
        values={**record,'content_hash':'a'*64}
        c.execute(text('INSERT INTO works (id,title,original_intro,summary,genres,themes,pace,harem,romance,tragic,source_url,collected_at,evidence,review_status,review_note,content_hash) VALUES (:id,:title,:original_intro,:summary,:genres,:themes,:pace,:harem,:romance,:tragic,:source_url,:collected_at,:evidence,:review_status,:review_note,:content_hash)'),
            [{**values,**{key:json.dumps(value) for key,value in values.items() if key in ('genres','themes','evidence')}},
             {**values,'id':legacy['id'],'title':legacy['title'],**{key:json.dumps(value) for key,value in values.items() if key in ('genres','themes','evidence')}}])
    initialize(engine);initialize(engine)
    assert {'cover_url','source_meta'}<={c['name'] for c in inspect(engine).get_columns('works')}
    with database() as s: assert list(s.scalars(select(Work.id)))==[record['id']]
    engine.dispose()


def summary(rows):
    return {'sources':[],'coverage':'limited','pages_done':2,'raw_count':len(rows),'unique_count':len(rows)}


async def test_job_lock_progress_recovery_and_missing_model_keys(database):
    ready=asyncio.Event();entered=asyncio.Event();calls=[]
    async def collector(scope,progress,settings):
        calls.append(scope.model_dump());progress({'message':'读取中','pages_done':1});entered.set();await ready.wait()
        rows=[normalize(category_row(),'comic-drama','2026-10-22')];return rows,summary(rows)
    settings=Settings(ai_mode='live',database_url='sqlite:///:memory:',dashscope_api_key='',deepseek_api_key='')
    manager=CatalogManager(database,settings,lambda:None,collector)
    first,second=await asyncio.gather(manager.start(RefreshRequest(categories=['comic-drama'])),manager.start(RefreshRequest(categories=['comic'])))
    await entered.wait();assert len(calls)==1 and first['run_id']==second['run_id'] and second['reused']
    assert second['scope']['categories']==['comic-drama']
    ready.set();await manager.task
    state=manager.state();assert state['status']=='succeeded' and state['result']['coverage']=='limited'
    assert not state['result']['indexing_enabled'] and state['result']['catalog_total']==1
    assert (await manager.start())['cooldown']
    manager.save(status='running');manager.recover();assert manager.state()['status']=='failed'
    assert manager.state()['last_success_at']==state['last_success_at']


async def test_task_failure_and_shutdown_preserve_old_data(database,record,baseline_settings):
    await import_works([record],database,None,baseline_settings)
    async def fail(scope,progress,settings): raise CrawlError('页面无法读取')
    manager=CatalogManager(database,baseline_settings,lambda:None,fail)
    await manager.start();await manager.task
    assert manager.state()['status']=='failed' and manager.state()['result'] is None
    with database() as s: assert s.get(Work,record['id']) is not None
    manager.save(finished_at=None)
    async def wait(scope,progress,settings): await asyncio.Event().wait()
    manager.collector=wait;await manager.start();await manager.close()
    # If cancelled before the coroutine starts, close must still clear running.
    assert manager.state()['status']=='failed'


def test_refresh_api_scope_validation_foreign_origin_and_content_filter():
    async def collector(scope,progress,settings):
        rows=[normalize(category_row(),scope.categories[0],'2026-10-22')];return rows,summary(rows)
    with TestClient(create_app(Settings(ai_mode='baseline',database_url='sqlite:///:memory:'),collector=collector)) as client:
        assert client.get('/api/v1/catalog/refresh').json()['status']=='idle'
        assert client.post('/api/v1/catalog/refresh',json={},headers={'Origin':'https://evil.test'}).status_code==403
        for body in [{'url':'http://127.0.0.1/private'},{'categories':[]},{'categories':['evil']},{'include_hot_rank':'true'}]:
            assert client.post('/api/v1/catalog/refresh',json=body).status_code==422
        response=client.post('/api/v1/catalog/refresh',json={'categories':['comic']})
        assert response.status_code==202 and response.json()['scope']['categories']==['comic']
        assert client.get('/api/v1/works?content_type=evil').status_code==422


async def test_catalog_content_type_filter_with_pagination(client):
    rows=[normalize(category_row(str(12345000+i)),'comic' if i%2 else 'comic-drama','2026-10-22') for i in range(15)]
    await import_works(rows,client.app.state.sessions,None,client.app.state.settings,source_sync=True)
    response=client.get('/api/v1/works?content_type=漫画&page_size=3&page=2').json()
    assert response['total']==7 and len(response['items'])==3
    assert all(w['source_meta']['content_type']=='漫画' for w in response['items'])
