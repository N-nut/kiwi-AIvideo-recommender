"""Copy public works only into a new, disposable browser-validation database."""
import json
from pathlib import Path
import sys

from sqlalchemy import inspect, select
from kiwi.config import ROOT, Settings
from kiwi.database import Work, WorkPreview, WorkReviewState, initialize, make_database, utc_now
from kiwi.schemas import WorkInput

target = Path(sys.argv[1]).resolve()
assert target.parent == (ROOT / '.local').resolve() and not target.exists(), 'Use a new file inside .local'
source, _ = make_database(Settings().database_url)
engine, _ = make_database(f'sqlite:///{target.as_posix()}')
try:
    initialize(engine)
    with source.connect() as read:
        rows = [dict(row) for row in read.execute(select(Work.__table__)).mappings()]
        previews = [dict(row) for row in read.execute(select(WorkPreview.__table__)).mappings()] if '--with-previews' in sys.argv else []
        states = [dict(row) for row in read.execute(select(WorkReviewState.__table__)).mappings()] if inspect(read).has_table('work_review_state') else [
            {'work_id':row['id'],'revision':1,'source_snapshot':{'kind':'legacy_snapshot','data':{k:v for k,v in row.items() if k in WorkInput.model_fields}},
             'confirmed_fields':{},'recheck_fields':[],'manual_hold':False,'hold_reason':None,'media_hold':False,'updated_at':utc_now()} for row in rows]
    with engine.begin() as write:
        if rows:
            write.execute(Work.__table__.insert(), rows)
            write.execute(WorkReviewState.__table__.insert(), states)
        if previews:
            write.execute(WorkPreview.__table__.insert(), previews)
    print(json.dumps({'public_works': len(rows), 'database': str(target.relative_to(ROOT)), 'ready_work_ids':[p['work_id'] for p in previews if p['status']=='ready']}))
finally:
    source.dispose()
    engine.dispose()
