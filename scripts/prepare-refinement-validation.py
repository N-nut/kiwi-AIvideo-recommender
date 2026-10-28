"""Create synthetic public works in an isolated validation database."""
import asyncio
import json
import sys
from pathlib import Path

from kiwi.config import Settings
from kiwi.database import initialize, make_database
from kiwi.importer import import_works
from kiwi.providers import BaselineAI


async def main():
    target = Path(sys.argv[1]).resolve()
    if target.exists():
        raise ValueError("Validation target must be new")
    settings = Settings(ai_mode="baseline", database_url="sqlite:///" + target.as_posix(), preview_auto_enabled=False)
    engine, sessions = make_database(settings.database_url)
    initialize(engine)
    records = []
    for i in range(9):
        genre = "修仙" if i < 7 else "都市"
        intro = f"合成验证作品{i}：{genre}故事，重生穿越成长，节奏快。明确无后宫、无感情线、无虐心。"
        records.append({"id": f"refine-{i}", "title": f"连续调整验证 {i}", "original_intro": intro,
            "summary": intro, "genres": [genre], "themes": ["重生", "穿越", "成长"], "pace": "快",
            "harem": False, "romance": False, "tragic": False, "source_url": f"https://example.org/refine/{i}",
            "source_meta": {"content_type": "漫剧", "pages": [f"https://example.org/refine/{i}"]},
            "collected_at": "2026-10-28", "review_status": "approved", "review_note": "合成验证，不是真实作品资料",
            "evidence": [{"id": f"{field}-1", "field": field, "quote": intro} for field in ["summary", "genres", "themes", "pace", "harem", "romance", "tragic"]]})
    await import_works(records, sessions, BaselineAI(), settings)
    engine.dispose()
    print(json.dumps({"database": target.name, "synthetic_works": len(records)}))


asyncio.run(main())
