"""Create only synthetic fixtures in a new, explicitly supplied database."""
import asyncio
import json
import sys
import uuid
from pathlib import Path

from kiwi.auth import passwords
from kiwi.config import Settings
from kiwi.database import User, initialize, make_database, utc_now
from kiwi.importer import import_works
from kiwi.reviews import set_reviewer

target=Path(sys.argv[1]).resolve()
if target.exists():
    raise SystemExit('Refusing to overwrite an existing database')
target.parent.mkdir(parents=True,exist_ok=True)
settings=Settings(ai_mode='baseline',database_url=f'sqlite:///{target.as_posix()}',preview_auto_enabled=False)
engine,sessions=make_database(settings.database_url)
initialize(engine)
intro='少年修仙，逆袭成长。'
rows=[{'id':f'review-work-{i}','title':f'合成核对作品 {i}','original_intro':intro,'summary':intro,
    'genres':['修仙'],'themes':['逆袭','成长'],'pace':None,'harem':False,'romance':None,'tragic':None,
    'source_url':f'https://example.org/works/{i}','cover_url':None,
    'source_meta':{'provider':'hongguo','content_type':'漫剧','pages':[f'https://example.org/works/{i}'],'tags':['修仙','成长']},
    'collected_at':'2026-10-28','review_status':'approved','review_note':'合成测试资料',
    'evidence':[{'id':f'{field}-1','field':field,'quote':intro} for field in ['summary','genres','themes','harem']]}
    for i in range(3)]
asyncio.run(import_works(rows,sessions,None,settings))
users={}
with sessions.begin() as session:
    for name in ['Reporter','Reviewer','Other']:
        identifier=str(uuid.uuid4());users[name]=identifier
        session.add(User(id=identifier,username=name,username_key=name.lower(),password_hash=passwords.hash('Synthetic review password 123'),created_at=utc_now()))
set_reviewer(sessions,settings,users['Reviewer'],True,'Synthetic isolated browser validation')
print(json.dumps({'database':str(target),'synthetic_accounts':True,'users':users,'works':len(rows)},ensure_ascii=False))
engine.dispose()
