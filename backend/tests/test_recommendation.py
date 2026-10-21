import copy
import pytest
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from kiwi.config import Settings
from kiwi.importer import import_works
from kiwi.providers import BaselineAI, ProviderError
from kiwi.repository import constrained_query, retrieve
from kiwi.rules import parse_baseline, satisfies
from kiwi.schemas import Preferences, RecommendationRequest, Requirement
from kiwi.service import recommend, validate_reasons, retrieval_text
from conftest import FakeAI


def request(**kwargs):
    return RecommendationRequest(preferences=Preferences(**kwargs))


def test_preference_negation_required_and_reset():
    p = parse_baseline("只看修仙，想看逆袭，不要后宫，不要都市，必须快节奏")
    assert p.required == [Requirement(field="genres",value="修仙"), Requirement(field="pace",value="快")]
    assert p.excluded_features == ["harem"] and p.excluded_genres == ["都市"]
    assert p.soft_preferences.themes == ["逆袭"]
    next_round = parse_baseline("想看都市")
    assert not next_round.required and not next_round.excluded_features


def test_conflict_and_unsupported():
    assert parse_baseline("只看修仙，不要修仙").conflicts
    assert parse_baseline("只看完结且免费").unresolved_constraints
    p = Preferences(required=[{"field":"harem","value":True}], excluded_features=["harem"])
    assert p.conflicts
    assert Preferences(required=[{"field":"pace","value":"快"},{"field":"pace","value":"舒缓"}]).conflicts


@pytest.mark.parametrize("req", [{"field":"sql","value":"DROP TABLE works"},{"field":"genres","value":"修仙' OR 1=1"},{"field":"harem","value":"false"}])
def test_requirements_whitelist(req):
    with pytest.raises(ValidationError): Requirement.model_validate(req)


@pytest.mark.parametrize("feature", ["harem", "romance", "tragic"])
async def test_three_state_hard_filter(record, database, baseline_settings, feature):
    rows=[]
    for i, value in enumerate([False, True, None]):
        row=copy.deepcopy(record); row.update(id=f"row-{i}",title=f"作品 {i}"); row[feature]=value; rows.append(row)
    await import_works(rows,database,BaselineAI(),baseline_settings)
    req=request(excluded_features=[feature],soft_preferences={"genres":["修仙"]})
    response=await recommend(req,database,BaselineAI(),baseline_settings,"request")
    assert [w["id"] for w in response["items"]] == ["row-0"]


async def test_stable_sort_limits_and_no_fill(record, database, baseline_settings):
    rows=[]
    for i in [3,1,2,0]:
        row=copy.deepcopy(record); row.update(id=f"row-{i}",title=f"作品 {i}"); rows.append(row)
    await import_works(rows,database,BaselineAI(),baseline_settings)
    req=request(soft_preferences={"genres":["修仙"]})
    response=await recommend(req,database,BaselineAI(),baseline_settings,"r")
    assert [w["id"] for w in response["items"]] == ["row-0","row-1","row-2"]
    empty=await recommend(request(soft_preferences={"genres":["科幻"]}),database,BaselineAI(),baseline_settings,"r")
    assert empty["status"]=="empty" and not empty["items"]


async def test_pending_missing_and_required(record,database,baseline_settings):
    record["review_status"]="pending"
    await import_works([record],database,BaselineAI(),baseline_settings)
    assert (await recommend(request(required=[{"field":"genres","value":"修仙"}]),database,BaselineAI(),baseline_settings,"r"))["status"]=="empty"


async def test_confirmation_blocks_model_calls(database,baseline_settings):
    class NoAI(FakeAI):
        async def embed(self,texts): raise AssertionError("should not call")
    for prefs in [{}, {"unresolved_constraints":["完结"]}, {"required":[{"field":"genres","value":"修仙"}],"excluded_genres":["修仙"]}]:
        assert (await recommend(request(**prefs),database,NoAI(),baseline_settings,"r"))["status"]=="needs_confirmation"


async def test_live_retrieval_and_reason_validation(record,database):
    settings=Settings(ai_mode="live"); provider=FakeAI()
    await import_works([record],database,provider,settings)
    response=await recommend(request(soft_preferences={"genres":["修仙"]}),database,provider,settings,"r")
    assert response["status"]=="success" and response["items"][0]["reason_mode"]=="model"
    assert response["items"][0]["source_url"]==record["source_url"]


@pytest.mark.parametrize("kind", ["external_id","bad_evidence","fake_quote","missing","duplicate","timeout","malformed"])
async def test_invalid_generation_falls_back(record,database,kind):
    class BadAI(FakeAI):
        async def reasons(self,prefs,works):
            if kind=="timeout": raise TimeoutError()
            if kind=="malformed": raise ProviderError()
            b=(await super().reasons(prefs,works)).model_dump()
            if kind=="external_id": b["items"][0]["work_id"]="unknown"
            if kind=="bad_evidence": b["items"][0]["evidence_ids"]=["fake"]
            if kind=="fake_quote": b["items"][0]["quotes"]=["伪造简介"]
            if kind=="missing": b["items"]=[]
            if kind=="duplicate": b["items"].append(b["items"][0])
            return b
    settings=Settings(ai_mode="live")
    await import_works([record],database,FakeAI(),settings)
    response=await recommend(request(soft_preferences={"genres":["修仙"]}),database,BadAI(),settings,"r")
    assert response["items"][0]["reason_mode"]=="template" and response["warnings"]


def test_postgres_sql_hard_filters_are_parameterized():
    p=Preferences(required=[{"field":"genres","value":"修仙"}],excluded_features=["harem"],excluded_genres=["都市"])
    compiled=constrained_query(p,"postgresql").compile(dialect=postgresql.dialect())
    sql=str(compiled)
    assert "IS false" in sql and "@>" in sql and "修仙" not in sql
    assert ["修仙"] in compiled.params.values()


def test_retrieval_text_uses_readable_positive_intent():
    prefs=Preferences(soft_preferences={"genres":["修仙"],"themes":["穿越"]},excluded_features=["harem"])
    text=retrieval_text(prefs)
    assert '修仙' in text and '穿越' in text
    assert 'harem' not in text and 'schema_version' not in text and '{' not in text


async def test_semantically_weak_unmatched_candidates_are_not_filler(record,database):
    settings=Settings(ai_mode='live')
    await import_works([record],database,FakeAI(),settings)
    class Middling(FakeAI):
        async def embed(self,texts): return [[0.55,(1-0.55**2)**0.5]+[0.0]*1022]
    result=await recommend(request(soft_preferences={"genres":["科幻"]}),database,Middling(),settings,'r')
    assert result['status']=='empty' and not result['items']
