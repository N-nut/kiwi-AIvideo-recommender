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
            row=copy.deepcopy(record);row.update(id=f'work-{i}',title=f'Test {i}',harem=value)
            row['source_meta']={'provider':'hongguo','content_type':'漫画' if i%2 else '漫剧','tags':[],'pages':['https://hongguoduanju.com/category/comic']}
            rows.append(row)
        settings=Settings(ai_mode='live',database_url=url)
        await import_works(rows,sessions,FakeAI(),settings)
        with sessions() as session:
            found=retrieve(session,Preferences(excluded_features=['harem'],required=[{'field':'genres','value':'修仙'}],excluded_genres=['都市']),[1.0]+[0.0]*1023,settings)
            assert [w.id for w,_ in found]==['work-0']
            comics=session.scalars(select(Work).where(Work.source_meta['content_type'].as_string()=='漫画').order_by(Work.id).offset(0).limit(12))
            assert [w.id for w in comics]==['work-1']
        class Fail(FakeAI):
            async def embed(self,texts): raise RuntimeError('upstream failure')
        changed=copy.deepcopy(rows[0]);changed['title']='updated'
        with pytest.raises(RuntimeError): await import_works([changed],sessions,Fail(),settings,update=True)
        with sessions() as session: assert session.get(Work,'work-0').title=='Test 0'
        # Exercise the account migration, real session lookup, ON CONFLICT and FK
        # constraints over the same disposable PostgreSQL wire connection.
        from fastapi.testclient import TestClient
        from sqlalchemy.exc import IntegrityError
        from kiwi.main import create_app
        from kiwi.database import Favorite, User, UserSession, utc_now
        from test_accounts import FastPasswords, HEADERS, register, login
        from kiwi import auth as auth_module
        monkeypatch.setattr(auth_module,'passwords',FastPasswords())
        # PGlite has one backend; release the existing pool before opening the app.
        engine.dispose()
        with TestClient(create_app(Settings(ai_mode='baseline',database_url=url)),base_url='http://127.0.0.1:8000',headers=HEADERS) as client:
            assert client.get('/api/v1/works',params={'q':'TEST'}).json()['total']==3
            assert client.get('/api/v1/works',params={'q':'Test','content_type':'漫画'}).json()['total']==1
            with client.app.state.sessions.begin() as session:
                session.get(Work,'work-0').title='100% Kiwi_短剧'
            for query in ['kiwi_','%','_']:
                result=client.get('/api/v1/works',params={'q':query}).json()
                assert result['total']==1 and result['items'][0]['id']=='work-0'
            assert register(client).status_code==201
            assert register(client,'user_a').status_code==409
            assert client.get('/api/v1/auth/me').json()['user']['username']=='User_A'
            assert client.put('/api/v1/me/favorites/work-0').status_code==200
            assert client.put('/api/v1/me/favorites/work-0').status_code==200
            imported=client.post('/api/v1/me/favorites/import',json={'work_ids':['work-0','work-1','missing','work-1']}).json()
            assert imported=={'requested':4,'unique':3,'added':1,'already_saved':1,'skipped_unavailable':1}
            assert client.get('/api/v1/me/favorites?page_size=1').json()['total']==2
            assert len(client.get('/api/v1/me/favorites?page=2&page_size=1').json()['items'])==1
            assert client.get('/api/v1/me/favorites/ids').json()['relation_total']==2
            assert register(client,'User_B').status_code==201
            assert client.get('/api/v1/me/favorites').json()['total']==0
            assert client.delete('/api/v1/me/favorites/work-0').status_code==204
            assert login(client).status_code==200
            assert client.get('/api/v1/me/favorites').json()['total']==2
            assert client.post('/api/v1/auth/logout').status_code==204
            assert client.get('/api/v1/me/favorites').status_code==401
        # Catch the actual FK violation inside PostgreSQL. PGlite's socket shim
        # cannot recover psycopg's ROLLBACK after a statement-level error.
        from sqlalchemy import text
        with engine.begin() as connection:
            connection.execute(text("""DO $$ BEGIN
                BEGIN
                    INSERT INTO favorites(user_id,work_id,created_at) VALUES ('missing','work-0',now());
                    RAISE EXCEPTION 'Expected foreign key rejection';
                EXCEPTION WHEN foreign_key_violation THEN NULL;
                END;
            END $$"""))
        with sessions.begin() as session:session.execute(User.__table__.delete())
        with sessions() as session:
            assert session.scalars(select(Favorite)).all()==[]
            assert session.scalars(select(UserSession)).all()==[]
    finally:
        command.downgrade(migration,'base')
        engine.dispose()
