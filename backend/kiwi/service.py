import asyncio
import time

from .database import public_work
from .providers import ProviderError
from .repository import retrieve
from .rules import FEATURE_NAMES, satisfies, soft_matches
from .schemas import ReasonBatch


def template_reason(work, prefs):
    matches, caveats = soft_matches(work, prefs)
    evidence = work.evidence
    if not evidence:
        return None
    return {
        "reason": (f"资料中的{'、'.join(matches)}与你的偏好相符。" if matches else "现有资料确认满足本次必须条件和排除条件。") + f"简介摘录：{evidence[0]['quote'][:100]}",
        "caveats": caveats, "evidence_ids": [e["id"] for e in evidence],
        "quotes": [evidence[0]["quote"]], "reason_mode": "template",
    }


def retrieval_text(prefs):
    """Embed readable positive intent; hard exclusions are enforced by SQL."""
    soft = prefs.soft_preferences
    parts = list(soft.genres) + list(soft.themes)
    if soft.pace:
        parts.append(f"节奏{soft.pace}")
    for required in prefs.required:
        if required.field in ("genres", "themes"):
            parts.append(required.value)
        elif required.field == "pace":
            parts.append(f"节奏{required.value}")
        elif required.value is True:
            parts.append(FEATURE_NAMES[required.field])
    return "想看" + "、".join(dict.fromkeys(parts)) + "的动态漫画故事" if parts else "动态漫画故事"


def validate_reasons(batch, works):
    batch = ReasonBatch.model_validate(batch.model_dump() if hasattr(batch, "model_dump") else batch)
    allowed = {w.id: w for w in works}
    if len(batch.items) != len(allowed) or {x.work_id for x in batch.items} != set(allowed):
        raise ValueError("模型返回了库外、重复或缺失作品")
    result = {}
    for reason in batch.items:
        work = allowed[reason.work_id]
        evidence = {e["id"]: e["quote"] for e in work.evidence}
        if any(i not in evidence for i in reason.evidence_ids):
            raise ValueError("无效证据标识")
        if any(not any(q in evidence[i] for i in reason.evidence_ids) for q in reason.quotes):
            raise ValueError("引用不属于该作品的指定证据")
        result[work.id] = {**reason.model_dump(exclude={"work_id"}), "reason_mode": "model"}
    return result


async def recommend(request, sessions, provider, settings, request_id):
    start = time.perf_counter()
    prefs = request.preferences
    result = {"request_id": request_id, "status": "success", "preferences": prefs.model_dump(),
              "items": [], "warnings": [], "timings_ms": {}, "mode": settings.ai_mode,
              "candidate_ids": [], "usage": {"calls": 0, "tokens": 0}}
    if prefs.conflicts or prefs.unresolved_constraints or not prefs.meaningful:
        result.update(status="needs_confirmation", warnings=prefs.conflicts + prefs.unresolved_constraints or ["请补充题材或剧情偏好"])
        return result
    vector = None
    if settings.ai_mode == "live":
        query = retrieval_text(prefs)
        vector = (await provider.embed([query]))[0]
    result["timings_ms"]["embedding"] = round((time.perf_counter() - start) * 1000, 2)
    tick = time.perf_counter()
    with sessions() as session:
        candidates = retrieve(session, prefs, vector, settings)
        scored = []
        for work, similarity in candidates:
            if not satisfies(work, prefs):
                continue
            matches, _ = soft_matches(work, prefs)
            soft = prefs.soft_preferences
            has_soft = bool(soft.genres or soft.themes or soft.pace)
            if has_soft and not matches and (similarity is None or similarity < settings.semantic_only_threshold):
                continue
            if similarity is not None and similarity < settings.min_similarity:
                continue
            score = (similarity or 0) + 0.08 * len(matches)
            scored.append((work, score, similarity))
        scored.sort(key=lambda x: (-x[1], x[0].id))
        unique = {w.id: (w, score, similarity) for w, score, similarity in scored}
        selected = list(unique.values())[:request.limit]
        result["candidate_ids"] = [w.id for w, _ in candidates]
        result["timings_ms"]["retrieval"] = round((time.perf_counter() - tick) * 1000, 2)
        if not selected:
            result.update(status="empty", warnings=["作品库中没有资料足以确认满足条件的相关作品。未知信息也会被严格排除；可主动调整条件。"])
        else:
            tick = time.perf_counter()
            reasons = {}
            if settings.ai_mode == "live":
                try:
                    # Reserve time for validation and the HTTP response inside the shared budget.
                    remaining = settings.request_timeout - (time.perf_counter() - start) - 0.3
                    if remaining <= 0:
                        raise TimeoutError()
                    batch = await asyncio.wait_for(provider.reasons(prefs, [public_work(w) for w, _, _ in selected]), remaining)
                    reasons = validate_reasons(batch, [w for w, _, _ in selected])
                except (ProviderError, ValueError, TimeoutError):
                    result["warnings"].append("推荐理由生成失败或引用未通过校验，已使用审核资料的证据模板。")
            for work, score, similarity in selected:
                if not satisfies(work, prefs):
                    continue
                reason = reasons.get(work.id) or template_reason(work, prefs)
                if reason:
                    # Program-derived differences cannot be suppressed by a model response.
                    reason["caveats"] = list(dict.fromkeys(reason["caveats"] + soft_matches(work, prefs)[1]))
                    result["items"].append({**public_work(work), **reason, "score": round(score, 5), "similarity": similarity})
            result["timings_ms"]["generation"] = round((time.perf_counter() - tick) * 1000, 2)
    if not result["items"] and result["status"] == "success":
        result.update(status="empty", warnings=["候选作品没有足够的有效证据，未输出推荐。"])
    result["timings_ms"]["total"] = round((time.perf_counter() - start) * 1000, 2)
    result["usage"] = {"calls": provider.calls, "tokens": provider.tokens}
    return result

