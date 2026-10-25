import copy
from datetime import timedelta

import pytest
from pydantic import ValidationError
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from kiwi.database import Favorite, UserSession, Work, utc_now
from kiwi.home_recommendations import build_profile, build_recommendations, score_work, suggest_prompts
from kiwi.schemas import HomeRecommendationResponse
from test_accounts import accounts, register, login


def home_work(record, id="favorite", genres=None, themes=None, kind="漫剧", **overrides):
    row = copy.deepcopy(record)
    row.update(id=id, genres=["修仙"] if genres is None else genres, themes=["逆袭"] if themes is None else themes,
               cover_url="https://example.org/cover.jpg", source_meta={"provider": "hongguo", "content_type": kind,
               "tags": ["未知标签"], "pages": ["https://example.org/source"]})
    row.update(overrides)
    return row


def seed(client, rows):
    with client.app.state.sessions.begin() as session:
        session.add_all(Work(**{**row, "content_hash": "a"*64}) for row in rows)


def test_normalized_counts_deduplicate_each_work_and_ignore_unknown_tags(record):
    rows = [home_work(record, genres=["修仙", "修仙", "未知"], themes=["逆袭", "逆袭"]),
            home_work(record, "empty", genres=[], themes=[])]
    profile = build_profile(rows + rows)
    assert profile.count == 2 and profile.genres == {"修仙": 1} and profile.themes == {"逆袭": 1}
    assert profile.pairs == {("修仙", "逆袭"): 1}
    assert score_work(home_work(record), profile) == pytest.approx(0.6)
    assert score_work(home_work(record, genres=["修仙", "都市"], themes=["逆袭", "成长"]), profile) == pytest.approx(0.4)


@pytest.mark.parametrize("overrides", [{"kind": "漫画"}, {"kind": "未标注"}, {"source_meta": None}, {"review_status": "pending"}, {"review_status": "rejected"}])
def test_invalid_favorites_do_not_form_profile(record, overrides):
    assert not build_profile([home_work(record, **overrides)]).sufficient


def test_rank_score_ties_public_fill_and_complete_public_fields(record):
    favorite = home_work(record)
    rows = [home_work(record, "z"), home_work(record, "b"), home_work(record, "a", genres=["都市"], themes=["成长"])]
    result = build_recommendations([favorite], rows + [favorite], ["favorite"]).model_dump()
    assert [row["id"] for row in result["items"]] == ["b", "z", "a"]
    assert result["carousel_mode"] == "mixed" and result["prompts_mode"] == "personalized"
    assert [row["basis"] for row in result["items"]] == ["favorites", "favorites", "public"]
    assert result["items"][0]["matched_features"] == {"content_type": ["漫剧"], "genres": ["修仙"], "themes": ["逆袭"]}
    assert result["items"][-1]["matched_features"] == {"content_type": [], "genres": [], "themes": []}
    assert result["items"][-1]["reason"] == "片库精选"
    assert set(record) - {"review_status"} <= result["items"][0].keys()
    assert "review_status" not in result["items"][0]


def test_candidates_without_cover_comics_unknown_and_unapproved_are_excluded(record):
    bad = [home_work(record, str(i), **kw) for i, kw in enumerate([
        {"cover_url": None}, {"cover_url": "  "}, {"kind": "漫画"}, {"source_meta": None}, {"kind": "未标注"}, {"review_status": "pending"}])]
    assert build_recommendations([], bad).items == []
    assert build_profile([home_work(record, cover_url=None)]).sufficient


def test_no_style_or_no_remaining_candidates_never_reintroduces_favorites(record):
    favorite = home_work(record, genres=[], themes=[])
    result = build_recommendations([favorite], [favorite], [favorite["id"]])
    assert result.items == [] and result.carousel_mode == result.prompts_mode == "default"
    assert all(prompt.basis == "public" for prompt in result.prompts)
    favorite = home_work(record)
    result = build_recommendations([favorite], [], [favorite["id"]])
    assert result.carousel_mode == "default" and result.prompts_mode == "personalized"


def test_limit_unique_stable_order_and_matching_requires_genre_or_theme(record):
    rows = [home_work(record, str(i)) for i in range(9)]
    result = build_recommendations([home_work(record)], list(reversed(rows)) + rows)
    assert [work.id for work in result.items] == [str(i) for i in range(6)]
    assert result.carousel_mode == "personalized"
    public = build_recommendations([], list(reversed(rows)))
    assert [work.id for work in public.items] == [str(i) for i in range(6)]
    assert public.carousel_mode == "default"
    only_type = build_recommendations([home_work(record)], [home_work(record, genres=["都市"], themes=["成长"])])
    assert only_type.items[0].basis == "public"


def test_prompts_only_use_actual_cooccurrence_and_soft_whitelisted_facts(record):
    profile = build_profile([home_work(record), home_work(record, "b", genres=["末世"], themes=["系统"]), home_work(record, "c")])
    prompts = suggest_prompts(profile)
    assert [prompt["label"] for prompt in prompts[:2]] == ["修仙逆袭", "末世系统"]
    assert len(prompts) == len({p["label"] for p in prompts}) == 4
    for prompt in prompts:
        assert len(prompt["label"]) <= 16 and len(prompt["text"]) <= 300
        assert not any(word in prompt["text"] for word in ["只看", "不要", "后宫", "无感情线"])
        if prompt["genres"] and prompt["themes"]:
            assert (prompt["genres"][0], prompt["themes"][0]) in profile.pairs
    assert len(suggest_prompts(build_profile([home_work(record, themes=[])]))) == 1
    assert suggest_prompts(build_profile([home_work(record, genres=[])]))[0]["text"] == "想看带有逆袭元素的故事。"


def test_private_api_uses_all_favorites_and_accounts_are_isolated(accounts, record):
    favorites = [home_work(record, f"fav-{i:02}", genres=["都市"], themes=["成长"]) for i in range(14)]
    favorites[0] = home_work(record, "fav-00")
    candidates = [home_work(record, "a", genres=["都市"], themes=["成长"]), home_work(record, "z")]
    seed(accounts, favorites + candidates)
    assert accounts.get('/api/v1/me/home-recommendations').status_code == 401
    assert register(accounts).status_code == 201
    assert accounts.post('/api/v1/me/favorites/import', json={"work_ids": [row["id"] for row in favorites]}).status_code == 200
    result = accounts.get('/api/v1/me/home-recommendations')
    assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
    first = result.json()
    assert [row["id"] for row in first["items"]] == ["a", "z"]
    assert first['items'][0]['basis'] == 'favorites'
    assert first['prompts'][0]['label'] == '都市成长'
    assert first['items'][1]['basis'] == 'favorites'
    assert any(prompt['label'] == '修仙逆袭' for prompt in first['prompts'])
    assert 'fav-00' not in {work['id'] for work in accounts.get('/api/v1/me/favorites').json()['items']}
    # Adding/removing a candidate updates exclusion, independently of paging.
    accounts.put('/api/v1/me/favorites/z')
    assert any(p['label'] == '修仙逆袭' for p in accounts.get('/api/v1/me/home-recommendations').json()['prompts'])
    assert accounts.get('/api/v1/home/recommendations').json()['prompts_mode'] == 'default'
    assert register(accounts, 'User_B').status_code == 201
    assert accounts.get('/api/v1/me/home-recommendations').json()['prompts_mode'] == 'default'
    accounts.put('/api/v1/me/favorites/z')
    second = accounts.get('/api/v1/me/home-recommendations').json()
    assert second['items'][0]['id'] == 'fav-00' and second['items'][0]['basis'] == 'favorites'
    assert second['prompts'][0]['label'] == '修仙逆袭'
    assert login(accounts).status_code == 200
    assert len(accounts.get('/api/v1/me/home-recommendations').json()['items']) == 1
    accounts.delete('/api/v1/me/favorites/z')
    assert len(accounts.get('/api/v1/me/home-recommendations').json()['items']) == 2


def test_public_ignores_cookie_private_invalid_session_query_validation_and_failures(accounts, record, monkeypatch):
    seed(accounts, [home_work(record)])
    assert register(accounts).status_code == 201
    accounts.put('/api/v1/me/favorites/favorite')
    assert len(accounts.get('/api/v1/home/recommendations').json()['items']) == 1
    assert accounts.get('/api/v1/me/home-recommendations').json()['items'] == []
    for path in ['/api/v1/home/recommendations', '/api/v1/me/home-recommendations']:
        for params in [{'user_id': 'other'}, {'limit': 10}, {'profile': 'invented'}]:
            response = accounts.get(path, params=params)
            assert response.status_code == 422 and response.headers['cache-control'] == 'no-store'
    with accounts.app.state.sessions.begin() as session:
        for row in session.scalars(select(UserSession)):
            row.expires_at = utc_now() - timedelta(seconds=1)
    assert accounts.get('/api/v1/me/home-recommendations').status_code == 401
    assert accounts.get('/api/v1/home/recommendations').status_code == 200
    def broken(*args):
        raise OperationalError('secret-database-url', {}, Exception('secret-password'))
    monkeypatch.setattr('kiwi.main.home_recommendations', broken)
    response = accounts.get('/api/v1/home/recommendations')
    assert response.status_code == 503 and response.headers['cache-control'] == 'no-store'
    assert 'secret' not in response.text and response.json()['request_id']


def test_query_count_is_bounded_and_no_profile_or_internal_fields_written(accounts, record):
    seed(accounts, [home_work(record, str(i)) for i in range(30)])
    register(accounts)
    accounts.post('/api/v1/me/favorites/import', json={'work_ids': [str(i) for i in range(20)]})
    queries = []
    def record_query(conn, cursor, statement, params, context, many):
        queries.append(statement)
    event.listen(accounts.app.state.engine, 'before_cursor_execute', record_query)
    try:
        result = accounts.get('/api/v1/me/home-recommendations')
    finally:
        event.remove(accounts.app.state.engine, 'before_cursor_execute', record_query)
    assert result.status_code == 200
    assert len([q for q in queries if 'works' in q.lower()]) == 2
    assert not any(q.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for q in queries)
    for forbidden in ['password', 'token_hash', 'embedding', 'user_id', 'profile', 'content_hash', 'favorite_ids']:
        assert forbidden not in result.text


@pytest.mark.parametrize('change', [{'items': [None]*7}, {'prompts': [None]*5}, {'carousel_mode': 'invented'}, {'prompts_mode': 'invented'}, {'strategy_version': 'invented'}])
def test_response_rejects_out_of_contract_values(change):
    payload = build_recommendations([], []).model_dump()
    with pytest.raises(ValidationError):
        HomeRecommendationResponse.model_validate({**payload, **change})
