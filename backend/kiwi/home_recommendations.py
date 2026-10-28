"""Request-local, explainable favorites matching. No model calls or profile writes."""
from collections import Counter
from dataclasses import dataclass, field
import logging
import json
import time

from sqlalchemy import exists, select

from .database import Favorite, PUBLIC_WORK_FIELDS, UserWorkFeedback, Work
from .schemas import GENRES, THEMES, HomeRecommendationResponse, PublicWork

DRAMA_TYPES = {"真人剧", "漫剧", "AI剧"}
STRATEGY_VERSION = "favorites-tags-v1"
log = logging.getLogger("kiwi")


def tags(work, name):
    return set(work.get(name) or []) & set(GENRES if name == "genres" else THEMES)


def content_type(work):
    return (work.get("source_meta") or {}).get("content_type")


@dataclass
class FavoriteProfile:
    count: int = 0
    content_types: Counter = field(default_factory=Counter)
    genres: Counter = field(default_factory=Counter)
    themes: Counter = field(default_factory=Counter)
    pairs: Counter = field(default_factory=Counter)

    @property
    def sufficient(self):
        return self.count > 0 and bool(self.genres or self.themes)


def build_profile(favorites):
    profile = FavoriteProfile()
    seen = set()
    for work in favorites:
        if work["id"] in seen or work.get("review_status") != "approved" or content_type(work) not in DRAMA_TYPES:
            continue
        seen.add(work["id"])
        genres, themes = tags(work, "genres"), tags(work, "themes")
        profile.count += 1
        profile.content_types.update([content_type(work)])
        profile.genres.update(genres)
        profile.themes.update(themes)
        profile.pairs.update((genre, theme) for genre in genres for theme in themes)
    return profile


def score_work(work, profile):
    if not profile.sufficient:
        return 0
    genres, themes = tags(work, "genres"), tags(work, "themes")
    genre_score = sum(profile.genres[tag] for tag in genres) / len(genres) if genres else 0
    theme_score = sum(profile.themes[tag] for tag in themes) / len(themes) if themes else 0
    return (0.2 * profile.content_types[content_type(work)] + 0.4 * genre_score + 0.4 * theme_score) / profile.count


def suggest_prompts(profile):
    if not profile.sufficient:
        return [{"label": label, "text": text, "basis": "public", "genres": [], "themes": []} for label, text in [
            ("修仙逆袭", "想看修仙题材，偏好逆袭主题。"),
            ("穿越重生", "想看带有穿越和重生元素的故事。"),
            ("末世系统", "想看末世题材，偏好系统主题。"),
            ("都市成长", "想看都市题材，偏好成长主题。"),
        ]]
    prompts = []
    for (genre, theme), _ in sorted(profile.pairs.items(), key=lambda pair: (-pair[1], pair[0])):
        prompts.append({"label": genre + theme, "text": f"想看{genre}题材，偏好{theme}主题。", "basis": "favorites", "genres": [genre], "themes": [theme]})
    singles = [(count, tag, name) for name in ("genres", "themes") for tag, count in getattr(profile, name).items()]
    for _, tag, name in sorted(singles, key=lambda value: (-value[0], value[1])):
        prompts.append({"label": tag, "text": f"想看{tag}题材的故事。" if name == "genres" else f"想看带有{tag}元素的故事。",
                        "basis": "favorites", "genres": [tag] if name == "genres" else [], "themes": [tag] if name == "themes" else []})
    unique = {}
    for prompt in prompts:
        unique.setdefault(prompt["label"], prompt)
    return list(unique.values())[:4]


def build_recommendations(favorites, candidates, favorite_ids=(), request_id="home"):
    profile = build_profile(favorites)
    excluded = set(favorite_ids)
    eligible = {work["id"]: work for work in candidates if work["id"] not in excluded
                and work.get("review_status") == "approved" and content_type(work) in DRAMA_TYPES
                and (work.get("cover_url") or "").strip()}
    ranked = []
    if profile.sufficient:
        ranked = sorted((work for work in eligible.values() if tags(work, "genres") & profile.genres.keys()
                         or tags(work, "themes") & profile.themes.keys()),
                        key=lambda work: (-score_work(work, profile), work["id"]))[:6]
    selected_ids = {work["id"] for work in ranked}
    selection = [(work, "favorites") for work in ranked]
    selection += [(eligible[id], "public") for id in sorted(eligible) if id not in selected_ids][:6-len(selection)]
    items = []
    for work, basis in selection:
        features = {"content_type": [], "genres": [], "themes": []}
        if basis == "favorites":
            features = {"content_type": [content_type(work)] if profile.content_types[content_type(work)] else [],
                        "genres": sorted(tags(work, "genres") & profile.genres.keys()),
                        "themes": sorted(tags(work, "themes") & profile.themes.keys())}
        # Only the public projection goes onto the wire; counters and scores stay local.
        public = {key: value for key, value in work.items() if key in PublicWork.model_fields}
        items.append({**public, "basis": basis, "matched_features": features,
                      "reason": "根据你收藏的" + "、".join(features["genres"] + features["themes"]) + "风格推荐" if basis == "favorites" else "片库精选"})
    sources = {basis for _, basis in selection}
    return HomeRecommendationResponse(request_id=request_id, strategy_version=STRATEGY_VERSION,
        carousel_mode="mixed" if len(sources) == 2 else "personalized" if "favorites" in sources else "default",
        prompts_mode="personalized" if profile.sufficient else "default", items=items, prompts=suggest_prompts(profile))


def home_recommendations(sessions, request_id, user_id=None):
    start = time.perf_counter()
    columns = [getattr(Work, name) for name in (*PUBLIC_WORK_FIELDS, "review_status")]
    with sessions() as session:
        favorites = []
        if user_id is not None:
            rows = session.execute(select(*columns).join(Favorite, Favorite.work_id == Work.id).where(Favorite.user_id == user_id)).mappings()
            favorites = [dict(row) for row in rows]
        query = select(*columns).where(Work.review_status == "approved", Work.cover_url.is_not(None),
            Work.source_meta["content_type"].as_string().in_(sorted(DRAMA_TYPES)))
        if user_id is not None:
            query = query.where(~exists(select(1).where(UserWorkFeedback.user_id == user_id, UserWorkFeedback.work_id == Work.id)))
        rows = session.execute(query).mappings()
        candidates = [dict(row) for row in rows]
        from .database import WorkReviewState
        from .reviewing import review_projection
        ids = {w["id"] for w in favorites+candidates}
        states = {s.work_id:s for s in session.scalars(select(WorkReviewState).where(WorkReviewState.work_id.in_(ids)))}
        for work in favorites+candidates:
            work["review"] = review_projection(states[work["id"]], work["review_status"])
    favorite_ids = {work["id"] for work in favorites}
    result = build_recommendations(favorites, candidates, favorite_ids, request_id)
    log.info(json.dumps({"request_id": request_id, "strategy_version": STRATEGY_VERSION, "valid_favorites": build_profile(favorites).count,
              "candidates": sum(bool((work.get("cover_url") or "").strip()) and work["id"] not in favorite_ids for work in candidates),
              "elapsed_ms": round((time.perf_counter() - start) * 1000, 2)}))
    return result
