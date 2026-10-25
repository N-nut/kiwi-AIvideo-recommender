"""Copy public works only into a new, disposable browser-validation database."""
import json
from pathlib import Path
import sys

from sqlalchemy import select
from kiwi.config import ROOT, Settings
from kiwi.database import Work, WorkPreview, initialize, make_database

target = Path(sys.argv[1]).resolve()
assert target.parent == (ROOT / '.local').resolve() and not target.exists(), 'Use a new file inside .local'
source, _ = make_database(Settings().database_url)
engine, _ = make_database(f'sqlite:///{target.as_posix()}')
try:
    initialize(engine)
    with source.connect() as read:
        rows = [dict(row) for row in read.execute(select(Work.__table__)).mappings()]
        previews = [dict(row) for row in read.execute(select(WorkPreview.__table__)).mappings()] if '--with-previews' in sys.argv else []
    with engine.begin() as write:
        if rows:
            write.execute(Work.__table__.insert(), rows)
        if previews:
            write.execute(WorkPreview.__table__.insert(), previews)
    print(json.dumps({'public_works': len(rows), 'database': str(target.relative_to(ROOT)), 'ready_work_ids':[p['work_id'] for p in previews if p['status']=='ready']}))
finally:
    source.dispose()
    engine.dispose()
