"""Read-only media audit, optionally comparing business tables with a SQLite backup."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from sqlalchemy import select

from kiwi.config import ROOT, Settings
from kiwi.database import Work, WorkPreview, make_database
from kiwi.preview_importer import probe
from kiwi.preview_jobs import PreviewManager
from kiwi.previews import ready_file


def business_snapshot(path):
    result = {}
    with sqlite3.connect(f'{Path(path).resolve().as_uri()}?mode=ro', uri=True) as connection:
        for table in ('works', 'users', 'user_sessions', 'favorites'):
            rows = connection.execute(f'SELECT * FROM "{table}" ORDER BY 1,2').fetchall()
            result[table] = {'count': len(rows), 'sha256': hashlib.sha256(
                json.dumps(rows, ensure_ascii=False, default=str).encode()).hexdigest()}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    settings = Settings()
    engine, sessions = make_database(settings.database_url)
    report = {'checked_at': datetime.now(timezone.utc).isoformat(), 'read_only': True,
              'state': PreviewManager(sessions, settings).state(), 'content_types': {},
              'verified_files': 0, 'audio_files': 0, 'media_bytes': 0, 'failures': []}
    try:
        with sessions() as session:
            rows = session.execute(select(Work, WorkPreview).outerjoin(WorkPreview, Work.id == WorkPreview.work_id)
                                   .where(Work.review_status == 'approved')).all()
            report['content_types'] = dict(Counter((work.source_meta or {}).get('content_type') for work, _ in rows))
            report['audited_assets'] = sum(bool(row and row.status == 'ready') for _, row in rows)
            for work, row in rows:
                if not row or row.status != 'ready':
                    continue
                try:
                    path = ready_file(row, settings)
                    assert path, 'invalid_ready_file'
                    with path.open('rb') as stream:
                        assert hashlib.file_digest(stream, 'sha256').hexdigest() == row.video_sha256, 'hash_mismatch'
                    info = probe(path, settings)
                    assert info['video']['codec_name'] == 'h264', 'video_codec'
                    assert 10000 <= round(info['duration'] * 1000) <= 20200, 'duration'
                    assert info['video']['pix_fmt'] == 'yuv420p', 'pixel_format'
                    assert all(track['codec_name'] == 'aac' for track in info['audio']), 'audio_codec'
                    pattern = rf'https://hongguoduanju\.com/player/{re.escape(work.id.removeprefix("hongguo-"))}(?:/\d+)?'
                    assert re.fullmatch(pattern, row.source_page_url), 'source_identity'
                    assert (settings.media_root / row.poster_path).is_file(), 'poster_missing'
                    report['verified_files'] += 1
                    report['audio_files'] += bool(info['audio'])
                    report['media_bytes'] += path.stat().st_size
                except Exception as exc:
                    report['failures'].append({'work_id': work.id, 'error': str(exc) if isinstance(exc, AssertionError) else type(exc).__name__})
        if args.baseline:
            assert settings.database_url.startswith('sqlite:///'), 'SQLite baseline comparison only'
            before = business_snapshot(args.baseline)
            after = business_snapshot(settings.database_url.removeprefix('sqlite:///'))
            report['business_tables'] = {name: {'count': value['count'], 'unchanged': value == before[name]}
                                         for name, value in after.items()}
            report['business_data_unchanged'] = before == after
            assert before == after, 'business_data_changed'
        with sessions() as session:
            from kiwi.database import PreviewJob
            report['unavailable_reasons'] = dict(Counter(session.scalars(
                select(PreviewJob.error_code).where(PreviewJob.status == 'unavailable')).all()))
            report['unavailable_works'] = [
                {'work_id': work.id, 'title': work.title, 'error_code': job.error_code}
                for work, job in session.execute(select(Work, PreviewJob).join(PreviewJob)
                    .where(PreviewJob.status == 'unavailable')).all()]
        report['passed'] = not report['failures'] and report['verified_files'] == report['audited_assets']
        (ROOT / 'docs/preview-library-validation.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
        raise SystemExit(0 if report['passed'] else 1)
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()
