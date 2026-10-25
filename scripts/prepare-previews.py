"""Back up SQLite and media together, verify a restored copy, then add local tables.

Stop the application and media imports before running this command.
No source, backup, or old media file is deleted.
"""
import hashlib
import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from kiwi.config import ROOT, Settings
from kiwi.database import initialize, make_database


def snapshot(connection):
    result = {}
    for table in ("works", "users", "user_sessions", "favorites", "catalog_refresh"):
        exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        if exists:
            rows = connection.execute(f'SELECT * FROM "{table}" ORDER BY 1,2').fetchall()
            result[table] = {"count":len(rows), "sha256":hashlib.sha256(json.dumps(rows,ensure_ascii=False,default=str).encode()).hexdigest()}
    return result


def main():
    settings = Settings()
    if not settings.database_url.startswith("sqlite:///") or ":memory:" in settings.database_url:
        raise SystemExit("此辅助脚本只处理现有 SQLite 文件；PostgreSQL 使用 Alembic 与数据库备份流程")
    source = Path(settings.database_url.removeprefix("sqlite:///")).resolve()
    if not source.is_file():
        raise SystemExit("原数据库不存在，请先核对配置")
    media = settings.media_root.resolve()
    if (media.parent / f".{media.name}.import.lock").exists():
        raise SystemExit("存在媒体导入锁，请先确认导入已停止")
    target = ROOT / ".local/backups" / f"previews-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{uuid4().hex[:8]}"
    target.mkdir(parents=True)
    with sqlite3.connect(source) as connection, sqlite3.connect(target / "kiwi.db") as saved:
        connection.backup(saved)
        before = snapshot(connection)
        assert saved.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert snapshot(saved) == before
    if media.is_dir():
        shutil.copytree(media, target / "media")
    # Restore into a separate directory, leaving the running database untouched.
    restore = target / "restore-check"
    restore.mkdir()
    shutil.copy2(target / "kiwi.db", restore / "kiwi.db")
    if (target / "media").is_dir():
        shutil.copytree(target / "media", restore / "media")
    verified = 0
    with sqlite3.connect(restore / "kiwi.db") as restored:
        assert restored.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert snapshot(restored) == before
        if restored.execute("SELECT 1 FROM sqlite_master WHERE name='work_previews'").fetchone():
            for relative, size, expected_hash in restored.execute("SELECT video_path,size_bytes,video_sha256 FROM work_previews WHERE status='ready'"):
                path = (restore / "media" / relative).resolve()
                assert path.is_relative_to((restore / "media").resolve()) and path.is_file()
                assert path.stat().st_size == size
                with path.open("rb") as stream:
                    assert hashlib.file_digest(stream, "sha256").hexdigest() == expected_hash
                verified += 1
    engine, _ = make_database(settings.database_url)
    try:
        initialize(engine)
    finally:
        engine.dispose()
    with sqlite3.connect(source) as connection:
        assert snapshot(connection) == before
    report = {"backup":str(target.relative_to(ROOT)), "integrity_check":"ok", "existing_data_unchanged":True,
              "restored_media_verified":verified, "restored_copy_verified":True}
    (target / "verification.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False))


if __name__ == "__main__":
    main()
