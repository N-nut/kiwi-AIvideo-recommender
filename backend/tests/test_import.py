import copy
import math
import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from kiwi.config import Settings
from kiwi.database import Work
from kiwi.importer import import_works
from kiwi.providers import BaselineAI, ProviderError
from kiwi.schemas import WorkInput
from conftest import FakeAI


@pytest.mark.parametrize("field,value", [("title", " "), ("harem", "false"), ("harem", 0), ("romance", 1), ("tragic", "unknown"), ("pace", "随机"), ("source_url", "javascript:alert(1)"), ("collected_at", "bad-date")])
def test_invalid_records(record, field, value):
    record[field] = value
    with pytest.raises(ValidationError):
        WorkInput.model_validate(record)


def test_missing_and_fake_evidence(record):
    record.pop("original_intro")
    with pytest.raises(ValidationError): WorkInput.model_validate(record)


@pytest.mark.parametrize("kind", ["quote", "duplicate", "missing"])
def test_evidence_validation(record, kind):
    if kind == "quote": record["evidence"][0]["quote"] = "编造内容"
    if kind == "duplicate": record["evidence"][1]["id"] = record["evidence"][0]["id"]
    if kind == "missing": record["evidence"] = [e for e in record["evidence"] if e["field"] != "harem"]
    with pytest.raises(ValidationError): WorkInput.model_validate(record)


async def test_idempotency_and_duplicate_id(record, database, baseline_settings):
    result = await import_works([record, record], database, BaselineAI(), baseline_settings)
    assert result == {"imported": 1, "skipped": 0, "failed": 0}
    assert (await import_works([record], database, BaselineAI(), baseline_settings))["skipped"] == 1
    with database() as s: assert s.scalar(select(func.count()).select_from(Work)) == 1


async def test_conflicting_id_and_title_are_atomic(record, database, baseline_settings):
    other = copy.deepcopy(record); other["title"] = "不同作品"
    with pytest.raises(ValueError, match="ID 内容冲突"):
        await import_works([record, other], database, BaselineAI(), baseline_settings)
    other["id"] = "work-b"; other["title"] = record["title"]
    with pytest.raises(ValueError, match="同名"):
        await import_works([record, other], database, BaselineAI(), baseline_settings)
    with database() as s: assert s.scalar(select(func.count()).select_from(Work)) == 0


async def test_explicit_update(record, database, baseline_settings):
    await import_works([record], database, BaselineAI(), baseline_settings)
    record["title"] = "更新作品"
    with pytest.raises(ValueError, match="--update"):
        await import_works([record], database, BaselineAI(), baseline_settings)
    await import_works([record], database, BaselineAI(), baseline_settings, update=True)
    with database() as s: assert s.get(Work, record["id"]).title == "更新作品"


async def test_embedding_failure_rolls_back_entire_batch(record, database):
    class Fail(FakeAI):
        async def embed(self, texts): raise ProviderError()
    with pytest.raises(ProviderError):
        await import_works([record], database, Fail(), Settings(ai_mode="live"))
    with database() as s: assert s.scalar(select(func.count()).select_from(Work)) == 0


@pytest.mark.parametrize("vector", [[1.0], [0.0]*1024, [math.nan]*1024])
async def test_invalid_vectors_never_commit(record, database, vector):
    class Fail(FakeAI):
        async def embed(self, texts): return [vector for _ in texts]
    with pytest.raises(ValueError, match="向量"):
        await import_works([record], database, Fail(), Settings(ai_mode="live"))
    with database() as s: assert s.scalar(select(func.count()).select_from(Work)) == 0


async def test_vector_update_and_full_rebuild(record, database):
    settings = Settings(ai_mode="live")
    await import_works([record], database, FakeAI(), settings)
    old_hash = None
    with database() as s:
        work = s.get(Work, record["id"]); old_hash = work.content_hash
        assert work.embedding_dimension == len(work.embedding) == 1024
    record["title"] = "已更新"
    await import_works([record], database, FakeAI(), settings, update=True)
    with database() as s: assert s.get(Work, record["id"]).content_hash != old_hash
    with pytest.raises(ValueError, match="整库"):
        await import_works([], database, FakeAI(), settings, reembed=True)

