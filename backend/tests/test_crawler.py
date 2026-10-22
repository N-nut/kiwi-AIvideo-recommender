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
from kiwi.crawler import SOURCES, CrawlError, collect_hongguo, normalize, source_rows
from kiwi.database import CatalogRefresh, Work, initialize
from kiwi.importer import import_works
from kiwi.main import create_app
from kiwi.schemas import WorkInput
from conftest import FakeAI


def category_row(sid="12345678"):
    return {"series_id": sid, "series_name": "采集测试作品", "series_intro": "少年穿越异界，一路修行与成长。",
            "series_cover": "https://p3-novel.byteimg.com/test.image", "tags": ["玄幻", "穿越", "修真"], "episode_cnt": 30}


def rank_row(sid="12345678"):
    row = category_row(sid)
    return {"seriesId": sid, "title": row["series_name"], "description": row["series_intro"], "tags": ["玄幻", "AI剧"],
            "cover": row["series_cover"], "rank": 1, "heatText": "123万热度"}


def page(rows, rank=False, style="resolved"):
    if not rank:
        return '<script>_ROUTER_DATA = '+json.dumps({"loaderData":{"category_$":{"recommendList":rows}}})+';</script>'
    content = {"isSuccess": True, "rankList": rows}
    if style == "direct":
        return '<script>_ROUTER_DATA = '+json.dumps({"loaderData":{"rank":{"content":content}}})+'</script>'
    if style == "promise":
        args = ["rank", [{"key":"content","routerDataFnName":"p","routerDataFnArgs":[json.dumps(content)]}]]
        return '<script data-fn-name="mergeLoaderData" data-fn-args="'+html.escape(json.dumps(args), quote=True)+'"></script>'
    # Modern.js can send a promise placeholder followed by a resolved payload.
    pending = ["rank", [{"key":"content","routerDataFnName":"s","routerDataFnArgs":['"rank"','"content"']}]]
    return '<script data-fn-name="mergeLoaderData" data-fn-args="'+html.escape(json.dumps(pending),quote=True)+'"></script><script data-script-src="modern-run-router-data-fn" data-fn-args="'+html.escape(json.dumps(["rank","content",content]),quote=True)+'"></script>'


@pytest.mark.parametrize("style", ["direct", "promise", "resolved"])
def test_public_stream_formats(style):
    rows = source_rows(page([rank_row()], True, style), SOURCES[1])
    work = WorkInput.model_validate(normalize(rows[0], SOURCES[1], "2026-10-22"))
    assert work.title == "采集测试作品" and work.source_meta.content_type == "AI剧"
    assert work.source_meta.rank == 1 and work.source_meta.heat == "123万热度"
    assert work.harem is None and work.tragic is None and work.pace is None
    assert all(e.quote in work.original_intro for e in work.evidence)


@pytest.mark.parametrize("body", ["<html>验证页面</html>", page([]), '<script>_ROUTER_DATA = bad()</script>'])
def test_empty_or_changed_page_is_an_error(body):
    with pytest.raises(CrawlError): source_rows(body, SOURCES[0])


@pytest.mark.parametrize("cover", ["http://p3-novel.byteimg.com/a", "https://evil.test/a", "file:///etc/passwd", "https://p3-novel.byteimg.com.evil.test/a"])
def test_untrusted_media_is_rejected(cover):
    row = category_row(); row["series_cover"] = cover
    with pytest.raises(CrawlError): normalize(row,SOURCES[0],"2026-10-22")


@pytest.mark.parametrize("duplicates", [1,2])
async def test_collection_uses_only_fixed_sources_and_merges_by_id(duplicates):
    visited = []
    def handle(request):
        visited.append(str(request.url))
        return httpx.Response(200,text=page([category_row()]*duplicates) if str(request.url)==SOURCES[0] else page([rank_row()],True))
    rows, counts = await collect_hongguo(transport=httpx.MockTransport(handle))
    assert visited == list(SOURCES) and len(rows) == 1
    assert rows[0]["source_meta"]["pages"] == list(SOURCES)
    assert rows[0]["source_meta"]["content_type"] == "真人剧"
    assert rows[0]["source_meta"]["rank"] == 1 and rows[0]["source_meta"]["episode_count"] == 30
    assert [c["works"] for c in counts] == [duplicates,1]
    assert rows[0]["genres"] == ["修仙","玄幻"] and rows[0]["themes"] == ["穿越"]


async def test_redirects_are_not_followed():
    visited = []
    def handle(request):
        visited.append(str(request.url)); return httpx.Response(302,headers={"Location":"http://127.0.0.1/private"})
    with pytest.raises(CrawlError): await collect_hongguo(transport=httpx.MockTransport(handle))
    assert visited == [SOURCES[0]]


async def test_retries_only_transient_errors():
    counts = {}
    def handle(request):
        url = str(request.url); counts[url] = counts.get(url,0)+1
        if counts[url] == 1: return httpx.Response(503)
        return httpx.Response(200,text=page([category_row()]) if url==SOURCES[0] else page([rank_row()],True))
    rows,_ = await collect_hongguo(transport=httpx.MockTransport(handle))
    assert len(rows)==1 and list(counts.values()) == [2,2]


async def test_index_is_reused_when_only_heat_date_or_cover_changes(database):
    settings = Settings(ai_mode="live", database_url="sqlite:///:memory:")
    row = normalize(rank_row(), SOURCES[1], "2026-10-22")
    provider = FakeAI()
    await import_works([row], database, provider, settings, update=True, replace_hongguo=True)
    with database() as s: timestamp = s.get(Work,row['id']).embedded_at
    changed = copy.deepcopy(row); changed['collected_at']='2026-10-23'; changed['source_meta']['heat']='200万热度'
    result = await import_works([changed], database, provider, settings, update=True, replace_hongguo=True)
    assert provider.calls == 1 and result['imported'] == 1
    with database() as s:
        work=s.get(Work,row['id']); assert work.source_meta['heat']=='200万热度' and work.embedded_at==timestamp
    again=await import_works([changed],database,provider,settings,update=True,replace_hongguo=True)
    assert again['skipped']==1 and provider.calls==1


async def test_failed_indexing_keeps_old_snapshot_and_success_replaces_only_source(database,record):
    settings=Settings(ai_mode='live',database_url='sqlite:///:memory:')
    old=normalize(rank_row(),SOURCES[1],'2026-10-22')
    await import_works([old,record],database,FakeAI(),settings)
    new=normalize(rank_row('98765432'),SOURCES[1],'2026-10-22');new['title']='新的测试作品'
    class Fail(FakeAI):
        async def embed(self,texts): raise RuntimeError('failed')
    with pytest.raises(RuntimeError): await import_works([new],database,Fail(),settings,update=True,replace_hongguo=True)
    with database() as s: assert set(s.scalars(select(Work.id)))=={old['id'],record['id']}
    result=await import_works([new],database,FakeAI(),settings,update=True,replace_hongguo=True)
    with database() as s: assert set(s.scalars(select(Work.id)))=={new['id'],record['id']}
    assert result['removed']==1


async def test_existing_sqlite_upgrade_removes_only_retired_seed(database,baseline_settings,record):
    legacy=copy.deepcopy(record);legacy.update(id='bili-45128',title='旧种子作品')
    await import_works([record,legacy],database,None,baseline_settings)
    engine=database.kw['bind']
    with engine.begin() as connection:
        connection.execute(text('DROP TABLE catalog_refresh'))
        connection.execute(text('ALTER TABLE works DROP COLUMN cover_url'))
        connection.execute(text('ALTER TABLE works DROP COLUMN source_meta'))
    initialize(engine); initialize(engine)
    assert {'cover_url','source_meta'} <= {c['name'] for c in inspect(engine).get_columns('works')}
    with database() as s: assert list(s.scalars(select(Work.id)))==[record['id']]


async def test_shared_job_failure_recovery_and_success_without_model_keys(database):
    ready = asyncio.Event(); calls=[]
    async def collector(progress):
        calls.append(1); progress('读取中'); await ready.wait()
        return [normalize(category_row(),SOURCES[0],'2026-10-22')],[]
    settings=Settings(ai_mode='live',database_url='sqlite:///:memory:',dashscope_api_key='',deepseek_api_key='')
    manager=CatalogManager(database,settings,lambda:None,collector)
    assert manager.start()['status']=='running'
    assert manager.start()['status']=='running'
    await asyncio.sleep(0);assert calls==[1]
    ready.set();await manager.task
    state=manager.state();assert state['status']=='succeeded' and state['result']['total']==1 and not state['result']['indexed']
    assert manager.start()['cooldown']
    manager.save(status='running'); manager.recover()
    assert manager.state()['status']=='failed' and manager.state()['last_success_at']==state['last_success_at']
    async def fail(progress): raise CrawlError('来源页面未返回作品')
    manager.collector=fail; await manager.run()
    assert manager.state()['status']=='failed'
    with database() as s: assert len(list(s.scalars(select(Work))))==1


def test_refresh_api_reports_state_and_rejects_foreign_origin():
    async def collector(progress):
        return [normalize(category_row(),SOURCES[0],'2026-10-22')],[]
    with TestClient(create_app(Settings(ai_mode='baseline',database_url='sqlite:///:memory:'),collector=collector)) as client:
        assert client.get('/api/v1/catalog/refresh').json()['status']=='idle'
        assert client.post('/api/v1/catalog/refresh',json={},headers={'Origin':'https://evil.test'}).status_code==403
        response=client.post('/api/v1/catalog/refresh',json={})
        assert response.status_code==202 and response.json()['status']=='running'
        # All requests are to server-owned sources; arbitrary client URLs have no effect.
        assert client.post('/api/v1/catalog/refresh',json={'url':'http://127.0.0.1/private'}).status_code==202
