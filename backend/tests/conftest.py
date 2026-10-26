import copy
import pytest
from fastapi.testclient import TestClient

from kiwi.config import Settings
from kiwi.database import initialize, make_database
from kiwi.main import create_app
from kiwi.providers import BaselineAI
from kiwi.rules import parse_baseline
from kiwi.schemas import ReasonBatch


@pytest.fixture(autouse=True)
def disable_live_preview_jobs(monkeypatch):
    # Integration tests opt into a deterministic source explicitly.
    monkeypatch.setenv("PREVIEW_AUTO_ENABLED", "false")


@pytest.fixture
def record():
    intro = "少年修仙，逆袭成长。明确无后宫，无感情线，无虐心情节。"
    return {"id": "work-a", "title": "测试作品 A", "original_intro": intro, "summary": "少年修仙，逆袭成长。",
            "genres": ["修仙"], "themes": ["逆袭", "成长"], "pace": None, "harem": False, "romance": False, "tragic": False,
            "source_url": "https://example.org/works/a", "collected_at": "2026-10-21", "review_status": "approved",
            "review_note": "测试替身，不是真实作品",
            "evidence": [{"id": f"{field}-1", "field": field, "quote": intro} for field in ["summary", "genres", "themes", "harem", "romance", "tragic"]]}


@pytest.fixture
def database():
    engine, sessions = make_database("sqlite:///:memory:")
    initialize(engine)
    yield sessions
    engine.dispose()


@pytest.fixture
def baseline_settings():
    return Settings(ai_mode="baseline", database_url="sqlite:///:memory:")


class FakeAI:
    calls = 0
    tokens = 0
    async def parse(self, text):
        return parse_baseline(text)
    async def embed(self, texts):
        self.calls += 1
        return [[1.0] + [0.0]*1023 for _ in texts]
    async def reasons(self, prefs, works):
        self.calls += 1
        return ReasonBatch(items=[{"work_id": w["id"], "reason": "资料支持修仙主题。", "caveats": [],
            "evidence_ids": [w["evidence"][0]["id"]], "quotes": [w["evidence"][0]["quote"]]} for w in works])


@pytest.fixture
def client():
    app = create_app(Settings(ai_mode="baseline", database_url="sqlite:///:memory:"))
    with TestClient(app) as client:
        yield client
