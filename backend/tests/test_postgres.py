"""Run only against an explicitly supplied, disposable pgvector test database."""
import os
import copy
import pytest
from sqlalchemy import select
from alembic import command
from alembic.config import Config
from kiwi.config import ROOT, Settings
from kiwi.database import Base, Work, initialize, make_database
from kiwi.importer import import_works
from kiwi.repository import retrieve
from kiwi.schemas import Preferences
from conftest import FakeAI


@pytest.mark.skipif(not os.getenv('KIWI_TEST_DATABASE_URL'), reason='Requires isolated PostgreSQL + pgvector: KIWI_TEST_DATABASE_URL')
async def test_real_postgres_filter_and_vectors(record,monkeypatch):
    url=os.environ['KIWI_TEST_DATABASE_URL']
    assert 'test' in url.rsplit('/',1)[-1], 'Use a disposable database whose name contains test'
    engine,sessions=make_database(url)
    with engine.connect() as connection:
        assert not connection.dialect.has_table(connection,'works'), 'Test database must be empty'
    try:
        monkeypatch.setenv('DATABASE_URL',url)
        migration=Config(str(ROOT/'backend/alembic.ini'))
        command.upgrade(migration,'head')
        initialize(engine)
        rows=[]
        for i,value in enumerate([False,True,None]):
            row=copy.deepcopy(record);row.update(id=f'work-{i}',title=f'Test {i}',harem=value);rows.append(row)
        settings=Settings(ai_mode='live',database_url=url)
        await import_works(rows,sessions,FakeAI(),settings)
        with sessions() as session:
            found=retrieve(session,Preferences(excluded_features=['harem'],required=[{'field':'genres','value':'修仙'}],excluded_genres=['都市']),[1.0]+[0.0]*1023,settings)
            assert [w.id for w,_ in found]==['work-0']
        class Fail(FakeAI):
            async def embed(self,texts): raise RuntimeError('upstream failure')
        changed=copy.deepcopy(rows[0]);changed['title']='updated'
        with pytest.raises(RuntimeError): await import_works([changed],sessions,Fail(),settings,update=True)
        with sessions() as session: assert session.get(Work,'work-0').title=='Test 0'
    finally:
        command.downgrade(migration,'base')
        engine.dispose()
