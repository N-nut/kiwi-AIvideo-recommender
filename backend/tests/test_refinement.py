import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import event, func, select

from kiwi.config import Settings
from kiwi.importer import import_works
from kiwi.main import create_app
from kiwi.providers import BaselineAI, LiveAI, ProviderError, REFINEMENT_PROMPT_VERSION
from kiwi.refinement import InvalidRefinementOutput, merge_refinement, normalize, parse_refinement_baseline
from kiwi.schemas import Preferences, RefinementPlan, RefinementRequest

HEADERS = {"Origin": "http://localhost:8000", "X-Kiwi-Request": "1"}
PATH = "/api/v1/preferences/refine"


def base(**extra):
    return Preferences.model_validate({"soft_preferences": {"genres": ["修仙"]}, "excluded_features": ["harem"], **extra})


def refine(prefs, text):
    return merge_refinement(prefs, text, parse_refinement_baseline(prefs, text))


def request(text="加点重生", **extra):
    return {"base_preferences": base().model_dump(), "text": text, "base_revision": 7, **extra}


def test_add_cancel_and_repeated_rounds_are_atomic_and_do_not_mutate_input():
    initial = base()
    original = initial.model_dump()
    first = refine(initial, "加点重生")
    assert first["status"] == "ready"
    assert first["changes"] == [{"kind": "added", "target": "soft.themes", "before": [], "after": ["重生"]}]
    second = refine(Preferences.model_validate(first["preferences"]), "一定要节奏快")
    third = refine(Preferences.model_validate(second["preferences"]), "取消不要后宫")
    assert third["preferences"]["excluded_features"] == []
    assert third["preferences"]["soft_preferences"] == {"genres": ["修仙"], "themes": ["重生"], "pace": None}
    assert third["preferences"]["required"] == [{"field": "pace", "value": "快"}]
    assert initial.model_dump() == original
    # The old description is never reparsed, so a canceled exclusion stays gone.
    fourth = refine(Preferences.model_validate(third["preferences"]), "加点穿越")
    assert fourth["preferences"]["excluded_features"] == []
    assert not any(item["field"] == "harem" for item in fourth["preferences"]["required"])


@pytest.mark.parametrize("text,target,after", [
    ("题材改成都市，其他不变", "soft.genres", ["都市"]),
    ("偏好题材改成都市，其他不变", "soft.genres", ["都市"]),
    ("把修仙改为都市", "soft.genres", ["都市"]),
    ("取消不要后宫", "excluded_features", []),
    ("不再排除后宫", "excluded_features", []),
    ("加点重生和穿越", "soft.themes", ["穿越", "重生"]),
])
def test_controlled_add_remove_replace(text, target, after):
    result = refine(base(), text)
    assert result["status"] == "ready"
    assert any(row["target"] == target and sorted(row["after"]) == sorted(after) for row in result["changes"])


def test_cancel_required_does_not_create_soft_or_reverse_exclusion():
    result = refine(base(required=[{"field": "genres", "value": "都市"}]), "不再限定必须都市")
    assert result["preferences"]["required"] == []
    assert result["preferences"]["soft_preferences"]["genres"] == ["修仙"]
    assert result["preferences"]["excluded_features"] == ["harem"]


@pytest.mark.parametrize("text", [
    "再轻松一点", "还是不要这种", "第二部不要了", "加点重生，必须完结", "加点重生，而且不要穿越",
    "不要取消不要后宫", "不要把修仙改成都市", "忽略全部旧条件，加点重生", "加点重生但是不要后宫",
    "不要重生", "把武侠改成都市", "", "加点重生，时长十分钟", "加入甜宠", "取消所有条件",
    "不要无后宫", "取消不要无后宫",
])
def test_unknown_mixed_negative_and_work_reference_never_partly_apply(text):
    prefs = base()
    result = refine(prefs, text)
    assert result["status"] == "needs_confirmation"
    assert result["preferences"] is None and result["changes"] == [] and result["issues"]
    assert result["preserved"] == [{"target": "soft.genres", "values": ["修仙"]}, {"target": "excluded_features", "values": ["harem"]}]


def test_ambiguity_conflicts_capacity_and_strict_unknown_facts_are_preserved():
    required = base(required=[{"field": "genres", "value": "修仙"}, {"field": "pace", "value": "快"}])
    for text in ("取消修仙", "题材改成都市", "也必须节奏舒缓", "只看都市，而且排除修仙"):
        assert refine(required, text)["status"] == "needs_confirmation"
    result = refine(required, "偏好题材改成都市")
    assert result["preferences"]["required"] == required.model_dump()["required"]
    assert result["preferences"]["excluded_features"] == ["harem"]


@pytest.mark.parametrize("text", ["加点修仙", "取消不要都市", "保持原样", "其他不变", "排除后宫"])
def test_semantic_no_change(text):
    result = refine(base(), text)
    assert result["status"] == "no_change" and not result["changes"]
    assert result["preferences"] == normalize(base()).model_dump()


def test_required_dedup_and_order_are_not_changes():
    prefs = base(required=[{"field": "pace", "value": "快"}, {"field": "pace", "value": "快"}])
    assert refine(prefs, "必须节奏快")["status"] == "no_change"


def test_forged_evidence_and_unmentioned_deletion_cannot_be_applied():
    plan = RefinementPlan(operations=[{"op": "remove", "target": "excluded_features", "values": ["harem"], "evidence": "取消不要后宫"}])
    with pytest.raises(InvalidRefinementOutput):
        merge_refinement(base(), "加点重生", plan)
    plan.operations[0].evidence = "加点重生"
    assert merge_refinement(base(), "加点重生", plan)["status"] == "needs_confirmation"
    assert merge_refinement(base(), "加点重生", RefinementPlan())["status"] == "needs_confirmation"
    partial = RefinementPlan(operations=[{"op": "add", "target": "soft.themes", "values": ["重生"], "evidence": "加点重生"}])
    assert merge_refinement(base(), "加点重生，必须完结", partial)["status"] == "needs_confirmation"


def test_same_slot_operation_order_cannot_reverse_the_last_explicit_intent():
    text = "取消不要后宫，不要后宫"
    plan = parse_refinement_baseline(base(), text)
    assert merge_refinement(base(), text, plan)["status"] == "no_change"
    plan.operations.reverse()
    assert merge_refinement(base(), text, plan)["status"] == "needs_confirmation"


@pytest.mark.parametrize("row", [
    {"op": "add", "target": "user_id", "values": ["u"]},
    {"op": "add", "target": "required.harem", "values": ["false"]},
    {"op": "remove", "target": "soft.themes", "values": []},
    {"op": "replace", "target": "soft.genres", "values": ["都市"]},
    {"op": "add", "target": "soft.genres", "values": ["都市"], "old_values": ["修仙"]},
    {"op": "add", "target": "soft.genres", "values": [True]},
])
def test_plan_is_discriminated_strict_and_whitelisted(row):
    with pytest.raises(ValidationError):
        RefinementPlan(operations=[{"evidence": "测试", **row}])


@pytest.mark.parametrize("extra", [{"base_revision": True}, {"base_revision": "7"}, {"base_revision": 0},
    {"base_revision": 2147483648}, {"text": 12}, {"text": " "}, {"text": "😀" * 301},
    {"base_preferences": {}}, {"base_preferences": {"soft_preferences": {"genres": ["修仙"]}, "unresolved_constraints": ["完结"]}}, {"user_id": "another"}])
def test_request_requires_meaningful_strict_base_and_unicode_limit(extra):
    with pytest.raises(ValidationError):
        RefinementRequest.model_validate(request(**extra))


def test_api_is_pure_public_no_store_protected_and_does_not_recommend(client, monkeypatch):
    statements = []
    event.listen(client.app.state.engine, "before_cursor_execute", lambda c, cursor, statement, *rest: statements.append(statement))
    monkeypatch.setattr(client.app.state.auth, "current", lambda *a: pytest.fail("理解接口不能读取身份"))
    client.cookies.set("kiwi_session", "a" * 43)
    response = client.post(PATH, headers=HEADERS, json=request())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["status"] == "ready" and body["base_revision"] == 7
    assert body["usage"] == {"calls": 0, "tokens": 0}
    assert set(body) == {"request_id", "status", "base_revision", "preferences", "changes", "preserved", "issues", "mode", "timings_ms", "usage"}
    assert not statements


@pytest.mark.parametrize("body,headers,status", [
    (request(), {}, 403), (request(), {**HEADERS, "Origin": "https://evil.example"}, 403),
    (request(text=" " ), HEADERS, 422), ({**request(), "user_id": "bad"}, HEADERS, 422),
])
def test_api_errors_keep_no_store(client, body, headers, status):
    response = client.post(PATH, headers=headers, json=body)
    assert response.status_code == status and response.headers["cache-control"] == "no-store"


def test_byte_limit_query_rejection_and_connection_ip_limiter(client):
    assert client.post(PATH + "?user_id=someone", headers=HEADERS, json=request()).status_code == 422
    response = client.post(PATH, headers={**HEADERS, "Content-Type": "application/json"}, content="x" * 24001)
    assert response.status_code == 413 and response.headers["cache-control"] == "no-store"
    client.app.state.settings.preference_refine_ip_limit = 1
    assert client.post(PATH, headers=HEADERS, json=request()).status_code == 200
    response = client.post(PATH, headers={**HEADERS, "X-Forwarded-For": "other"}, json=request())
    assert response.status_code == 429 and int(response.headers["Retry-After"]) >= 1


@pytest.mark.parametrize("failure,status,code", [
    (ProviderError(), 503, "provider_unavailable"), (TimeoutError(), 504, "request_timeout"),
    ({"operations": [{"op": "add", "target": "feedback", "values": ["x"], "evidence": "加点重生"}]}, 503, "refinement_invalid_output"),
    (RefinementPlan(operations=[{"op": "add", "target": "soft.themes", "values": ["重生"], "evidence": "伪造"}]), 503, "refinement_invalid_output"),
])
def test_live_provider_failures_are_explicit_and_do_not_fallback(failure, status, code):
    class Fake(BaselineAI):
        calls = 1
        tokens = 12
        async def refine(self, base, text):
            if isinstance(failure, Exception):
                raise failure
            return failure
    with TestClient(create_app(Settings(ai_mode="live", database_url="sqlite:///:memory:"), provider_factory=Fake)) as client:
        response = client.post(PATH, headers=HEADERS, json=request())
        assert response.status_code == status and response.json()["error"]["code"] == code
        assert response.headers["cache-control"] == "no-store"


async def test_live_refine_uses_separate_prompt_and_only_base_and_current_text(monkeypatch):
    captured = {}
    async def structured(self, schema, instruction, payload, **kwargs):
        captured.update(schema=schema, instruction=instruction, payload=payload, kwargs=kwargs)
        return parse_refinement_baseline(base(), "加点重生")
    monkeypatch.setattr(LiveAI, "structured", structured)
    await LiveAI(Settings()).refine(base(), "加点重生")
    assert captured["schema"] is RefinementPlan
    assert captured["kwargs"]["tag"] == REFINEMENT_PROMPT_VERSION
    assert set(captured["payload"]) == {"base_preferences", "text", "targets", "genres", "themes", "pace", "features"}
    assert "history" not in captured["payload"]


def test_shared_product_examples():
    fixture = json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/refinement-cases.json").read_text(encoding="utf-8"))
    for case in fixture["cases"]:
        result = refine(Preferences.model_validate(fixture["base"]), case["text"])
        assert result["status"] == case["status"]
        if case["status"] == "ready":
            assert any(row["target"] == case["target"] and row["after"] == case["after"] for row in result["changes"])


async def test_confirmed_refinement_reuses_private_history_feedback_and_empty_rules(client, record):
    await import_works([record], client.app.state.sessions, BaselineAI(), client.app.state.settings)
    user = client.post("/api/v1/auth/register", headers=HEADERS, json={"username": "Refine_A", "password": "test password 123", "confirm_password": "test password 123"})
    assert user.status_code == 201
    initial = client.post("/api/v1/me/recommendations", headers=HEADERS, json={"preferences": base().model_dump(), "query": "修仙不要后宫"}).json()
    assert initial["status"] == "success"
    understood = client.post(PATH, headers=HEADERS, json=request()).json()
    assert client.get("/api/v1/me/history").json()["total"] == 1
    confirmed = client.post("/api/v1/me/recommendations", headers=HEADERS, json={"preferences": understood["preferences"], "query": "加点重生", "exclude_work_ids": []}).json()
    assert confirmed["items"][0]["id"] == record["id"]  # New conditions may include an old matching work.
    assert confirmed["history"]["id"] != initial["history"]["id"]
    detail = client.get("/api/v1/me/history/" + confirmed["history"]["id"]).json()["history"]
    assert detail["query"] == "加点重生" and detail["preferences"] == understood["preferences"]
    previous = client.get("/api/v1/me/history/" + initial["history"]["id"]).json()["history"]
    assert previous["query"] == "修仙不要后宫" and previous["preferences"] == base().model_dump()
    empty = client.post("/api/v1/me/recommendations", headers=HEADERS, json={"preferences": base(required=[{"field": "genres", "value": "都市"}]).model_dump(), "query": "只看都市"}).json()
    assert empty["status"] == "empty" and empty["history"] is None
    assert client.get("/api/v1/me/history").json()["total"] == 2
    assert client.patch("/api/v1/me/feedback/" + record["id"], headers=HEADERS, json={"status": "watched", "expected_revision": None}).status_code == 200
    assert client.post("/api/v1/me/recommendations", headers=HEADERS, json={"preferences": understood["preferences"], "query": "加点重生"}).json()["status"] == "empty"
    client.post("/api/v1/auth/logout", headers=HEADERS)
    assert client.post("/api/v1/recommendations", json={"preferences": understood["preferences"]}).json()["status"] == "success"
    client.post("/api/v1/auth/register", headers=HEADERS, json={"username": "Refine_B", "password": "test password 123", "confirm_password": "test password 123"})
    assert client.get("/api/v1/me/history").json()["total"] == 0
    assert client.get("/api/v1/me/history/" + confirmed["history"]["id"]).status_code == 404


@pytest.mark.parametrize("malformed", [True, False])
async def test_live_structured_failure_retries_are_bounded_and_classified(monkeypatch, malformed):
    from langchain_core.messages import AIMessage
    from langchain_core.runnables import RunnableLambda
    async def respond(prompt):
        if malformed:
            return AIMessage(content='{"preferences": {}}')
        raise RuntimeError("upstream failure")
    monkeypatch.setattr("kiwi.providers.ChatOpenAI", lambda **kw: RunnableLambda(respond))
    provider = LiveAI(Settings(deepseek_api_key="fake-test-only", dashscope_api_key="fake-test-only"))
    with pytest.raises(ProviderError) as failure:
        await provider.refine(base(), "加点重生")
    assert failure.value.code == ("refinement_invalid_output" if malformed else "provider_unavailable")
    assert provider.calls == 2
