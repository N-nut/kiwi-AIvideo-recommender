import re

from .schemas import GENRES, THEMES, Preferences

FEATURE_NAMES = {"harem": "后宫", "romance": "感情线", "tragic": "虐心"}


def parse_baseline(text):
    prefs = {"soft_preferences": {"genres": [], "themes": [], "pace": None}, "required": [],
             "excluded_features": [], "excluded_genres": [], "unresolved_constraints": []}
    clauses = re.split(r"[，,。；;！!\n]+", text)
    for clause in clauses:
        negative = bool(re.search(r"不要|不想|排除|别来|不看|拒绝|无", clause))
        mandatory = bool(re.search(r"只看|必须|一定|只要", clause))
        for genre in GENRES:
            if genre in clause:
                if negative:
                    prefs["excluded_genres"].append(genre)
                elif mandatory:
                    prefs["required"].append({"field": "genres", "value": genre})
                else:
                    prefs["soft_preferences"]["genres"].append(genre)
        for theme in THEMES:
            if theme in clause:
                if negative:
                    prefs["unresolved_constraints"].append(f"暂不支持排除主题：{theme}")
                elif mandatory:
                    prefs["required"].append({"field": "themes", "value": theme})
                else:
                    prefs["soft_preferences"]["themes"].append(theme)
        for feature, name in FEATURE_NAMES.items():
            if name in clause or (feature == "romance" and "恋爱线" in clause):
                if negative:
                    prefs["excluded_features"].append(feature)
                elif mandatory:
                    prefs["required"].append({"field": feature, "value": True})
        pace = "快" if re.search(r"节奏快|快节奏|节奏快一点", clause) else "舒缓" if re.search(r"慢节奏|节奏舒缓|节奏慢", clause) else None
        if pace:
            if negative:
                prefs["unresolved_constraints"].append(f"请用必须条件指定节奏：{clause}")
            elif mandatory:
                prefs["required"].append({"field": "pace", "value": pace})
            else:
                prefs["soft_preferences"]["pace"] = pace
        if re.search(r"完结|集数|分钟|时长|免费|付费|配音|主演|平台|番茄|红果", clause):
            prefs["unresolved_constraints"].append(clause)
    return Preferences.model_validate(prefs)


def satisfies(work, prefs):
    if work.review_status != "approved":
        return False
    if any(getattr(work, f) is not False for f in prefs.excluded_features):
        return False
    if any(g in work.genres for g in prefs.excluded_genres):
        return False
    for req in prefs.required:
        actual = getattr(work, req.field)
        if req.field in ("genres", "themes"):
            if req.value not in actual:
                return False
        elif actual != req.value or actual is None:
            return False
    return True


def soft_matches(work, prefs):
    soft = prefs.soft_preferences
    matches = [g for g in soft.genres if g in work.genres] + [t for t in soft.themes if t in work.themes]
    caveats = [f"资料未标注偏好题材：{g}" for g in soft.genres if g not in work.genres]
    caveats += [f"资料未标注偏好主题：{t}" for t in soft.themes if t not in work.themes]
    if soft.pace:
        if work.pace == soft.pace:
            matches.append(f"节奏{soft.pace}")
        else:
            caveats.append("资料无法确认符合节奏偏好" if work.pace is None else f"作品节奏为{work.pace}")
    return matches, caveats
