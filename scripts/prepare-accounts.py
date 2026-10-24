"""Back up the local SQLite database, upgrade, and prove public data is unchanged."""
import hashlib
import json
from pathlib import Path
import sqlite3
import time

from kiwi.config import ROOT, Settings
from kiwi.database import initialize, make_database


def public_fingerprint(connection):
    snapshot = {}
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in ['works','catalog_refresh']:
        rows = connection.execute(f'SELECT * FROM {table} ORDER BY id').fetchall() if table in tables else []
        snapshot[table] = {'count':len(rows),'sha256':hashlib.sha256(json.dumps(rows,ensure_ascii=False,default=str).encode()).hexdigest()}
    return snapshot


def main():
    settings=Settings()
    if not settings.database_url.startswith('sqlite:///') or ':memory:' in settings.database_url:
        raise SystemExit('This helper is only for local file SQLite; use Alembic and pg_dump for PostgreSQL.')
    path=Path(settings.database_url.removeprefix('sqlite:///')).resolve()
    if not path.is_file():raise SystemExit('Local database does not exist.')
    backup=path.with_name(f'{path.stem}-before-accounts-{time.strftime("%Y%m%d-%H%M%S")}.db')
    with sqlite3.connect(path) as original, sqlite3.connect(backup) as copy:
        before=public_fingerprint(original);original.backup(copy)
        assert copy.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert public_fingerprint(copy)==before
    engine,_=make_database(settings.database_url)
    try:initialize(engine)
    finally:engine.dispose()
    with sqlite3.connect(path) as connection:
        after=public_fingerprint(connection)
        assert after==before,'Public data changed during upgrade; retain the backup for inspection.'
        assert connection.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    report={'backup':str(backup.relative_to(ROOT)), 'public_data_unchanged':True,'before':before,'after':after}
    (ROOT/'.local/account-upgrade.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
