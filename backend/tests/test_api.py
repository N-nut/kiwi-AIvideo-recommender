import asyncio
import copy
import json
import os
import subprocess
import sys
import pytest
from fastapi.testclient import TestClient

from kiwi.config import ROOT, Settings
from kiwi.importer import import_works
from kiwi.main import create_app
from kiwi.providers import BaselineAI, ProviderError
from kiwi.schemas import WorkInput
from conftest import FakeAI


def test_health_and_blank_input(client):
    assert client.get('/health/live').status_code==200
    assert client.get('/health/ready').status_code==503
    for text in ['', '   ', 'a'*301]:
        assert client.post('/api/v1/preferences/parse',json={'text':text}).status_code==422
    assert client.post('/api/v1/preferences/parse',json={'text':'想看修仙'}).json()['preferences']['soft_preferences']['genres']==['修仙']


@pytest.mark.parametrize("limit", [0,4,True,"3"])
def test_invalid_limit(client,limit):
    assert client.post('/api/v1/recommendations',json={'preferences':{},'limit':limit}).status_code==422


async def test_catalog_paging_and_confirmed_edits(client,record):
    settings=client.app.state.settings
    await import_works([record],client.app.state.sessions,BaselineAI(),settings)
    assert client.get('/health/ready').status_code==200
    assert client.get('/api/v1/works?genre=修仙').json()['total']==1
    assert client.get('/api/v1/works?genre=都市').json()['total']==0
    assert client.get('/api/v1/works?page=2&page_size=1').json()['items']==[]
    assert client.get('/api/v1/works/work-a').status_code==200
    assert client.get('/api/v1/works/missing').status_code==404
    assert client.get('/api/v1/works?page_size=999').status_code==422
    # User has changed their original genre to 都市; do not reparse the old 修仙 request.
    data=client.post('/api/v1/recommendations',json={'preferences':{'soft_preferences':{'genres':['都市']}}}).json()
    assert data['status']=='empty'
    assert client.post('/api/v1/recommendations',json={'preferences':{'soft_preferences':{'genres':['修仙']}}}).json()['items'][0]['id']=='work-a'


def test_oversize_and_untrusted_fields(client):
    assert client.post('/api/v1/preferences/parse',content='x'*25000).status_code==413
    assert client.post('/api/v1/recommendations',json={'preferences':{'required':[{'field':'__dict__','value':'bad'}]}}).status_code==422
    assert client.post('/api/v1/preferences/parse',json={'text':'修仙','api_key':'secret'}).status_code==422


@pytest.mark.parametrize("exception,status", [(ProviderError(),503),(TimeoutError(),504)])
def test_errors_have_request_id_and_no_fake_results(exception,status):
    class Fail(FakeAI):
        async def parse(self,text): raise exception
    with TestClient(create_app(Settings(ai_mode='baseline',database_url='sqlite:///:memory:'),lambda:Fail())) as client:
        response=client.post('/api/v1/preferences/parse',json={'text':'修仙'})
        assert response.status_code==status
        assert response.json()['request_id'] and 'items' not in response.json()


def test_shared_timeout():
    class Slow(FakeAI):
        async def embed(self,texts): await asyncio.sleep(2)
    with TestClient(create_app(Settings(ai_mode='live',database_url='sqlite:///:memory:',request_timeout=1),lambda:Slow())) as client:
        response=client.post('/api/v1/recommendations',json={'preferences':{'soft_preferences':{'genres':['修仙']}}})
        assert response.status_code==504


def test_real_dataset_is_bounded_and_source_grounded():
    rows=json.loads((ROOT/'data/works.json').read_text(encoding='utf-8'))
    assert 30<=len(rows)<=50 and len({r['id'] for r in rows})==len(rows)
    for raw in rows:
        row=WorkInput.model_validate(raw)
        assert row.source_url.host=='www.bilibili.com'
        assert 'AI' in row.review_note and '人工' in row.review_note
        assert row.harem is None and row.pace is None


def test_packaged_install_can_find_external_project_data():
    external=ROOT/'.local/package-data-test'
    process=subprocess.run([sys.executable,'-X','utf8','-c','from kiwi.config import ROOT; print(ROOT)'],env={**os.environ,'KIWI_PROJECT_ROOT':str(external)},capture_output=True,text=True,encoding='utf-8',check=True)
    assert process.stdout.strip()==str(external.resolve())
