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
async def test_real_postgres_filter_and_vectors(record,monkeypatch,tmp_path):
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
            # The same works and favorites must give identical SQLite/PostgreSQL
            # home responses, including JSONB filtering, stable order and prompts.
            from kiwi.database import public_work
            from kiwi.home_recommendations import home_recommendations
            from test_home_recommendations import home_work, seed
            seed(client, [home_work(record, 'home-favorite'), home_work(record, 'home-similar'),
                          home_work(record, 'home-public', genres=['都市'], themes=['经营']),
                          home_work(record, 'home-comic', kind='漫画'),
                          home_work(record, 'home-no-cover', cover_url='  '),
                          home_work(record, 'home-pending', review_status='pending')])
            assert client.put('/api/v1/me/favorites/home-favorite').status_code==200
            pg_home=client.get('/api/v1/me/home-recommendations').json()
            assert pg_home['carousel_mode']=='mixed' and pg_home['items'][0]['id']=='home-similar'
            assert pg_home['items'][1]['id']=='home-public' and pg_home['items'][1]['basis']=='public'
            sqlite_engine,sqlite_sessions=make_database('sqlite:///:memory:')
            initialize(sqlite_engine)
            try:
                parity_user_id=client.get('/api/v1/auth/me').json()['user']['id']
                with client.app.state.sessions() as session:
                    copies=[{**public_work(work),'review_status':work.review_status,'content_hash':work.content_hash} for work in session.scalars(select(Work))]
                    favorite_ids=session.scalars(select(Favorite.work_id).where(Favorite.user_id==parity_user_id)).all()
                with sqlite_sessions.begin() as session:
                    session.add(User(id='parity-user',username='parity',username_key='parity',password_hash='test-only',created_at=utc_now()))
                    session.add_all(Work(**row) for row in copies)
                with sqlite_sessions.begin() as session:
                    session.add_all(Favorite(user_id='parity-user',work_id=id,created_at=utc_now()) for id in favorite_ids)
                expected=home_recommendations(sqlite_sessions,pg_home['request_id'],'parity-user').model_dump(mode='json')
                assert pg_home==expected
                assert client.get('/api/v1/home/recommendations').json()['prompts_mode']=='default'
            finally:
                sqlite_engine.dispose()
            assert register(client,'User_B').status_code==201
            assert client.get('/api/v1/me/favorites').json()['total']==0
            assert client.delete('/api/v1/me/favorites/work-0').status_code==204
            assert login(client).status_code==200
            assert client.get('/api/v1/me/favorites').json()['total']==3
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
        # Media migration and public state/file checks over the independent DB.
        from test_previews import ready
        from kiwi.database import WorkPreview
        from fastapi.testclient import TestClient
        ready(sessions,tmp_path,work_id='work-0')
        media_settings=Settings(ai_mode='baseline',database_url=url,media_root=tmp_path)
        with TestClient(create_app(media_settings)) as media_client:
            preview=media_client.get('/api/v1/works/work-0/preview').json()
            assert preview['status']=='ready' and preview['preview']['duration_ms']==15000
            url=preview['preview']['video_url']
            assert media_client.get(url,headers={'Range':'bytes=0-9'}).content==b'0123456789'
            assert media_client.head(url).headers['content-length']=='100'
            assert media_client.get('/api/v1/works/work-1/preview').json()['status']=='not_applicable'
        with sessions() as session: assert session.get(WorkPreview,'work-0').status=='ready'
        from kiwi.preview_jobs import PreviewManager
        from kiwi.database import PreviewJob
        media_settings.preview_auto_enabled=True
        manager=PreviewManager(sessions,media_settings)
        queued=manager.enqueue()
        assert queued>0
        with sessions() as session:
            assert session.get(PreviewJob,'work-0') is None
            assert session.get(PreviewJob,'home-similar').status=='pending'
    finally:
        command.downgrade(migration,'base')
        engine.dispose()
