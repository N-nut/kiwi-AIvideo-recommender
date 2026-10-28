import asyncio
import copy
import json
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select

from kiwi.catalog import CatalogManager
from kiwi.config import Settings
from kiwi.database import Favorite, PreviewJob, User, Work, initialize, make_database, public_work, utc_now
from kiwi.preview_importer import MediaError
from kiwi.preview_jobs import PreviewManager, WorkerLock, source_key
from kiwi.preview_source import HongguoPreviewSource, source_identity, source_update, validate_media_url
from kiwi.schemas import RefreshRequest
from test_previews import ready


@pytest.fixture
def jobs(tmp_path,record,monkeypatch):
    engine,sessions=make_database(f"sqlite:///{(tmp_path/'jobs.db').as_posix()}")
    initialize(engine)
    settings=Settings(ai_mode='baseline',database_url=str(engine.url),media_root=tmp_path/'media',preview_auto_enabled=True,preview_workers=2,preview_attempts=2,preview_retry_seconds=1)
    import kiwi.preview_jobs as module
    monkeypatch.setattr(module,'run_tool',lambda *_: b'tool version')
    calls=[]
    def publish(manifest,sessions,settings,expected_work_versions=None):
        item=json.loads(Path(manifest).read_text())[0]
        calls.append(item['work_id'])
        ready(sessions,settings.media_root,work_id=item['work_id'],asset=uuid4().hex)
        return {'ready':1,'failed':0,'items':[]}
    monkeypatch.setattr(module,'import_previews',publish)
    def seed(identifier,kind='漫剧'):
        data=copy.deepcopy(record);data.update(id=identifier,title=identifier,source_meta={'provider':'hongguo','content_type':kind},content_hash='original')
        if identifier.startswith('hongguo-'):
            data['source_url']='https://hongguoduanju.com/detail?series_id='+identifier.removeprefix('hongguo-')
        with sessions.begin() as session:session.add(Work(**data))
    yield sessions,settings,seed,calls
    engine.dispose()


class Source:
    def __init__(self,settings):self.resolved=[]
    async def start(self):pass
    async def close(self):pass
    async def resolve(self,work):
        self.resolved.append(work['id'])
        return {'source_page_url':'https://example.org/first-episode','url':'unused'}
    async def download(self,info,target):Path(target).write_bytes(b'local fixture')


def renamed_info(identifier='hongguo-12345678'):
    sid=identifier.removeprefix('hongguo-')
    return {'series_id':sid,'title':'来源最新名称','episode_id':'23456789','first_episode_id':'23456789',
        'source_data':{'series_id':sid,'series_name':'来源最新名称','series_intro':'少年穿越末世，在异界冒险成长。',
            'series_cover':'https://p3-novel.byteimg.com/new.image','tags':['末世','穿越'],'episode_cnt':183,
            'rank_label':'热播漫剧榜第49名','heat':'5271万热度'}}


@pytest.mark.parametrize('change',['series','episode','metadata','cover'])
def test_rename_requires_matching_ids_first_episode_and_complete_source_data(change):
    work={'id':'hongguo-12345678','title':'旧名','source_url':'https://hongguoduanju.com/detail?series_id=12345678','source_meta':{'provider':'hongguo','content_type':'漫剧'}}
    info=renamed_info()
    row=source_update(work,info)
    assert row['id']==work['id'] and row['title']==info['title']
    assert row['source_meta']['episode_count']==183 and row['source_meta']['rank']==49
    info['source_data']['rank_label']='热播漫剧榜第100名'
    assert source_update(work,info)['source_meta']['rank']==100
    if change=='series':info['series_id']='87654321'
    elif change=='episode':info['episode_id']='87654321'
    elif change=='metadata':info['source_data']['series_id']='87654321'
    else:info['source_data']['series_cover']='https://attacker.test/cover'
    with pytest.raises(MediaError):source_update(work,info)


async def test_renamed_work_syncs_source_data_without_changing_id_or_favorites(jobs):
    sessions,settings,seed,calls=jobs;identifier='hongguo-12345678';seed(identifier)
    with sessions.begin() as session:
        session.add(User(id='fixture-user',username='fixture',username_key='fixture',password_hash='fixture-hash',created_at=utc_now()))
        session.flush();session.add(Favorite(user_id='fixture-user',work_id=identifier,created_at=utc_now()))
        work=session.get(Work,identifier);work.embedding=[1.0]+[0.0]*1023;work.embedding_model=settings.embedding_model;work.embedding_dimension=1024
    class Renamed(Source):
        async def resolve(self,work):
            info=await super().resolve(work);info['source_record']=source_update(work,renamed_info(identifier));return info
    manager=PreviewManager(sessions,settings,Renamed)
    try:
        await manager.start();assert (await idle(manager))['ready']==1
        with sessions() as session:
            work=session.get(Work,identifier)
            assert work.title=='来源最新名称' and work.cover_url.endswith('/new.image')
            assert work.source_meta['tags']==['末世','穿越'] and work.source_meta['episode_count']==183
            assert work.source_meta['heat']=='5271万热度' and work.source_meta['rank']==49
            assert work.embedding is None and work.embedding_model is None
            assert session.get(Favorite,('fixture-user',identifier)) is not None
            assert len(session.scalars(select(Work)).all())==1
            assert session.get(PreviewJob,identifier).source_key==source_key(work)
        assert manager.enqueue(retry_failed=True)==0 and calls==[identifier]
    finally:await manager.close()


async def test_404_keeps_existing_work_and_unavailable_state(jobs):
    sessions,settings,seed,calls=jobs;identifier='hongguo-12345678';seed(identifier)
    with sessions() as session:before=public_work(session.get(Work,identifier))
    class Missing(Source):
        async def resolve(self,work):raise MediaError('source','source_http_404')
    manager=PreviewManager(sessions,settings,Missing)
    try:
        await manager.start();assert (await idle(manager))['unavailable']==1
        assert manager.enqueue(retry_failed=True)==0 and calls==[]
        with sessions() as session:
            assert public_work(session.get(Work,identifier))==before
            assert session.get(PreviewJob,identifier).error_code=='source_http_404'
    finally:await manager.close()


async def test_source_sync_rebuilds_embeddings_and_rejects_a_concurrent_newer_record(jobs):
    from pydantic import SecretStr
    from conftest import FakeAI
    sessions,settings,seed,calls=jobs;identifier='hongguo-12345678';seed(identifier)
    settings.ai_mode='live';settings.dashscope_api_key=SecretStr('synthetic-fixture')
    with sessions() as session:work=public_work(session.get(Work,identifier))
    row=source_update(work,renamed_info(identifier));provider=FakeAI()
    manager=PreviewManager(sessions,settings,Source,lambda:provider)
    updated=await manager.sync_source(work,row)
    assert updated['title']==row['title'] and provider.calls==1
    with sessions() as session:assert session.get(Work,identifier).embedding==[1.0]+[0.0]*1023
    class Concurrent(FakeAI):
        async def embed(self,texts):
            with sessions.begin() as session:
                current=session.get(Work,identifier);current.title='并发保存的新资料';current.content_hash='newer'
            return await super().embed(texts)
    row['title']='再改名'
    other=PreviewManager(sessions,settings,Source,Concurrent)
    with pytest.raises(ValueError,match='同步期间已改变'):await other.sync_source(updated,row)
    with sessions() as session:assert session.get(Work,identifier).title=='并发保存的新资料'


async def idle(manager):
    return await asyncio.wait_for(manager.wait_idle(),8)


async def test_backfill_all_drama_types_reuses_ready_and_skips_comics(jobs):
    sessions,settings,seed,calls=jobs
    for identifier,kind in [('old','漫剧'),('new-a','AI剧'),('new-b','真人剧'),('comic','漫画')]:seed(identifier,kind)
    ready(sessions,settings.media_root,work_id='old')
    manager=PreviewManager(sessions,settings,Source)
    try:
        await manager.start();state=await idle(manager)
        assert state['total']==3 and state['ready']==3 and state['pending']==state['running']==0
        assert set(calls)=={'new-a','new-b'}
        assert manager.enqueue(retry_failed=True)==0
        assert not list(settings.media_root.parent.glob('.preview-source-*'))
    finally:await manager.close()


async def test_new_catalogue_records_are_queued_after_successful_commit(jobs,record):
    sessions,settings,seed,calls=jobs
    manager=PreviewManager(sessions,settings,Source)
    row=copy.deepcopy(record);row.update(id='hongguo-12345678',title='新增作品',source_meta={'provider':'hongguo','content_type':'AI剧','pages':['https://hongguoduanju.com/category/ai-drama']})
    async def collector(scope,progress,settings):
        return [row],{'sources':[],'coverage':'complete','pages_done':1,'raw_count':1,'unique_count':1}
    catalog=CatalogManager(sessions,settings,lambda:None,collector,manager)
    try:
        await catalog.start(RefreshRequest(categories=['ai-drama']));await catalog.task
        assert catalog.state()['status']=='succeeded' and catalog.state()['result']['previews_queued']==1
        state=await idle(manager)
        assert state['ready']==1 and calls==['hongguo-12345678']
        with sessions() as session:assert session.get(Work,'hongguo-12345678') is not None
    finally:await catalog.close();await manager.close()


async def test_refresh_failure_never_queues_uncommitted_records(jobs):
    sessions,settings,seed,calls=jobs
    manager=PreviewManager(sessions,settings,Source)
    async def collector(*args,**kwargs):raise RuntimeError('failed source')
    catalog=CatalogManager(sessions,settings,lambda:None,collector,manager)
    try:
        await catalog.start();await catalog.task
        assert catalog.state()['status']=='failed'
        with sessions() as session:assert session.scalars(select(PreviewJob)).all()==[]
        assert calls==[]
    finally:await catalog.close();await manager.close()


async def test_transient_failure_retries_and_terminal_failure_can_be_requeued(jobs):
    sessions,settings,seed,calls=jobs;seed('retry')
    class Retry(Source):
        async def resolve(self,work):
            if not self.resolved:
                self.resolved.append(work['id']);raise MediaError('download','download_failed')
            return await super().resolve(work)
    manager=PreviewManager(sessions,settings,Retry)
    try:
        await manager.start();assert (await idle(manager))['ready']==1
        with sessions() as session:assert session.get(PreviewJob,'retry').attempts==2
    finally:await manager.close()
    seed('unavailable')
    class Unsupported(Source):
        async def resolve(self,work):raise MediaError('source','unsupported_source')
    manager=PreviewManager(sessions,settings,Unsupported)
    try:
        await manager.start();state=await idle(manager)
        assert state['unavailable']==1 and state['ready']==1
        assert manager.enqueue(retry_failed=True)==1
        with sessions() as session:
            job=session.get(PreviewJob,'unavailable');assert job.status=='pending' and job.attempts==0
    finally:await manager.close()


async def test_restart_recovers_running_work_without_losing_original_work(jobs):
    sessions,settings,seed,calls=jobs;seed('interrupted')
    entered=asyncio.Event()
    class Blocked(Source):
        async def resolve(self,work):entered.set();await asyncio.Event().wait()
    first=PreviewManager(sessions,settings,Blocked)
    await first.start();await asyncio.wait_for(entered.wait(),3);await first.close()
    with sessions() as session:
        assert session.get(PreviewJob,'interrupted').status=='pending'
        assert session.get(Work,'interrupted').content_hash=='original'
    second=PreviewManager(sessions,settings,Source)
    try:
        await second.start();assert (await idle(second))['ready']==1
    finally:await second.close()


async def test_disabled_runtime_and_missing_tools_do_not_fake_success(jobs,monkeypatch):
    sessions,settings,seed,calls=jobs;seed('pending')
    settings.preview_auto_enabled=False
    manager=PreviewManager(sessions,settings,Source)
    await manager.start();assert not manager.tasks and not (await idle(manager))['enabled']
    await manager.close()
    settings.preview_auto_enabled=True
    import kiwi.preview_jobs as module
    def missing(*args):raise MediaError('tools','tool_missing')
    monkeypatch.setattr(module,'run_tool',missing)
    manager=PreviewManager(sessions,settings,Source)
    try:
        await manager.start();state=await idle(manager)
        assert state['error_code']=='tool_missing' and state['ready']==0 and state['pending']==1
    finally:await manager.close()


def test_only_one_worker_process_can_own_the_media_root(tmp_path):
    first=WorkerLock(tmp_path/'worker.lock');second=WorkerLock(tmp_path/'worker.lock')
    try:
        assert first.acquire();assert not second.acquire();first.close();assert second.acquire()
    finally:first.close();second.close()


def test_terminated_process_does_not_leave_the_importer_locked(tmp_path):
    path=tmp_path/'import.lock'
    code="from pathlib import Path; import sys,os; from kiwi.file_lock import FileLock; lock=FileLock(Path(sys.argv[1])); assert lock.acquire(); os._exit(0)"
    assert subprocess.run([sys.executable,'-c',code,str(path)],check=False).returncode==0
    assert path.exists()
    lock=WorkerLock(path)
    try:assert lock.acquire()
    finally:lock.close()


@pytest.mark.parametrize('value',['http://v3-hgweb.qznovelvod.com/video','https://127.0.0.1/private','https://v3-hgweb.qznovelvod.com.attacker.test/video','https://user:secret@v3-hgweb.qznovelvod.com/video','https://hongguoduanju.com/admin'])
def test_media_hosts_and_public_paths_are_restricted(value):
    with pytest.raises(MediaError):validate_media_url(value)


def test_source_requires_exact_work_and_source_ids():
    work={'id':'hongguo-12345678','source_url':'https://hongguoduanju.com/detail?series_id=12345678','source_meta':{'provider':'hongguo'}}
    assert source_identity(work)=='12345678'
    for changes in [{'source_url':'https://hongguoduanju.com/detail?series_id=87654321'},{'id':'work-a'},{'source_url':'https://hongguoduanju.com.attacker.test/detail?series_id=12345678'}]:
        with pytest.raises(MediaError):source_identity({**work,**changes})


def test_cdn_redirect_target_is_allowed_only_for_the_observed_hash_host():
    assert validate_media_url('https://'+'a'*48+'.v.smtcdns.com/video')
    with pytest.raises(MediaError):validate_media_url('https://attacker.v.smtcdns.com/video')


async def test_download_rejects_redirect_escape_and_oversized_content(tmp_path):
    settings=Settings(preview_source_max_bytes=5)
    source=HongguoPreviewSource(settings);await source.client.aclose()
    info={'url':'https://v3-hgweb.qznovelvod.com/video','source_page_url':'https://hongguoduanju.com/player/12345678'}
    try:
        source.client=httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(302,headers={'Location':'http://127.0.0.1/secret'})))
        with pytest.raises(MediaError,match='media_host_rejected'):await source.download(info,tmp_path/'source.mp4')
        await source.client.aclose()
        source.client=httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,content=b'123456')))
        with pytest.raises(MediaError,match='source_size_limit'):await source.download(info,tmp_path/'source.mp4')
    finally:await source.close()


async def test_normal_cdn_redirect_preserves_browser_headers_and_streams_to_disk(tmp_path):
    source=HongguoPreviewSource(Settings());await source.client.aclose()
    visits=[]
    def handler(request):
        visits.append(request)
        assert request.headers['user-agent']=='browser-test' and request.headers['referer']=='https://hongguoduanju.com/player/12345678'
        return httpx.Response(302,headers={'Location':'https://'+'a'*48+'.v.smtcdns.com/clip'}) if len(visits)==1 else httpx.Response(200,content=b'video')
    source.client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result=await source.download({'url':'https://v3-hgweb.qznovelvod.com/video','source_page_url':'https://example.org','referer':'https://hongguoduanju.com/player/12345678','user_agent':'browser-test'},tmp_path/'source.mp4')
        assert result==5 and (tmp_path/'source.mp4').read_bytes()==b'video' and len(visits)==2
    finally:await source.close()
