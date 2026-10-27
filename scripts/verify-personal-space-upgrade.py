"""Validate the current SQLite upgrade on a copy; the source is opened read-only."""
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid
import sys

from kiwi.config import ROOT, Settings
from kiwi.database import initialize, make_database


def fingerprint(connection, tables):
    return {name: hashlib.sha256(repr(connection.execute(
        'SELECT ' + ','.join('"' + column.replace('"', '""') + '"' for column in columns)
        + ' FROM "' + name.replace('"', '""') + '" ORDER BY rowid').fetchall()).encode()).hexdigest()
        for name, columns in tables.items()}


def main():
    source_engine, _ = make_database(Settings().database_url)
    assert source_engine.dialect.name == 'sqlite', 'Use the SQLite copy validator only for local installations'
    source_path = Path(source_engine.url.database).resolve()
    source_engine.dispose()
    assert source_path.is_file(), 'Current SQLite database must exist'
    target = ROOT / '.local' / f'space-upgrade-{uuid.uuid4().hex[:12]}.db'
    target.parent.mkdir(parents=True, exist_ok=True)
    assert not target.exists()
    # SQLite's online backup API copies a consistent snapshot even with WAL.
    with sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True) as source, sqlite3.connect(target) as copy:
        source.backup(copy)
    with sqlite3.connect(target) as copy:
        tables = {name: [row[1] for row in copy.execute(f'PRAGMA table_info("{name}")')]
                  for (name,) in copy.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='alembic_version'").fetchall()}
        before = fingerprint(copy, tables)
    engine, _ = make_database(f'sqlite:///{target.as_posix()}')
    try:
        initialize(engine)
        initialize(engine)
    finally:
        engine.dispose()
    with sqlite3.connect(target) as copy:
        assert copy.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert copy.execute('PRAGMA foreign_key_check').fetchall() == []
        assert fingerprint(copy, tables) == before, 'Pre-existing values changed during upgrade'
        assert copy.execute('SELECT version_num FROM alembic_version').fetchone()[0] == '0007'
        assert any(row[1] == 'uq_users_nickname_key' and row[2] == 1 for row in copy.execute('PRAGMA index_list(users)'))
        assert [row[1] for row in copy.execute('PRAGMA table_info(user_work_feedback)') if row[5]] == ['user_id','work_id']
        assert len(copy.execute('PRAGMA foreign_key_list(user_work_feedback)').fetchall()) == 2
        assert 'ck_feedback_status' in copy.execute("SELECT sql FROM sqlite_master WHERE name='user_work_feedback'").fetchone()[0]
    report = {'source_opened_read_only': True, 'database_copy': str(target.relative_to(ROOT)),
              'original_values_preserved': True, 'integrity': 'ok', 'foreign_keys': 'ok', 'revision': '0007',
              'repeated_initialization': 'passed', 'unique_nickname_index': 'present', 'feedback_primary_key_foreign_keys_check': 'present', 'contains_private_data': True}
    output='feedback-upgrade-validation.json' if '--feedback' in sys.argv else 'personal-space-upgrade-validation.json'
    (ROOT/'docs'/output).write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
