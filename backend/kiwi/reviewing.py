"""Pure review projection/merge; no network and no inference of plot truth."""
import copy
import hashlib
import json
import uuid

from .review_models import MAPPING
from .schemas import WorkInput

WORK_FIELDS = tuple(WorkInput.model_fields)
META_FIELDS = {"content_type", "episode_count", "chapter_count"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def work_data(work):
    return copy.deepcopy({key: getattr(work, key) for key in WORK_FIELDS})


def field_value(data, field):
    if field in META_FIELDS:
        return (data.get("source_meta") or {}).get(field)
    return data.get({"cover_mapping":"cover_url", "source_link":"source_url", "work_identity":"id"}.get(field, field))


def set_field(data, field, value):
    if field in MAPPING and field != "cover_mapping":
        return
    if field in META_FIELDS:
        if data.get("source_meta") is None:
            raise ValueError("缺少内容来源元数据")
        data["source_meta"][field] = copy.deepcopy(value)
    else:
        data["cover_url" if field == "cover_mapping" else field] = copy.deepcopy(value)


def revision(work):
    if work.review_state is None:
        raise RuntimeError("作品缺少审核状态，请检查 0010 升级")
    return work.review_state.revision


def public_review(work):
    state = work.review_state
    if state is None:
        raise RuntimeError("作品缺少审核状态，请检查 0010 升级")
    return review_projection(state, work.review_status)


def review_projection(state, review_status):
    status = ("unavailable" if state.manual_hold or review_status != "approved" else
              "recheck" if state.recheck_fields else "partial" if state.confirmed_fields else "automatic")
    return {"revision": state.revision, "state": status,
            "confirmed_fields": sorted(state.confirmed_fields), "recheck_fields": sorted(state.recheck_fields)}


def validate_effective(data, confirmed):
    """Only server-owned confirmations may supply external evidence context."""
    data = copy.deepcopy(data)
    manual = {}
    for field, entry in confirmed.items():
        if field in {"summary", "genres", "themes", "pace", "harem", "romance", "tragic"}:
            data["evidence"] = [e for e in data["evidence"] if e["field"] != field]
            if entry["value"] is not None and entry["value"] != []:
                basis = entry["basis"]
                quote = basis.get("quote")
                if not quote or quote not in basis["source_text"]:
                    raise ValueError("非空事实缺少已核对的引文")
                evidence = {"id": entry["evidence_id"], "field": field, "quote": quote}
                data["evidence"].append(evidence)
                manual[evidence["id"]] = {**evidence, "value": entry["value"]}
    # Obsolete automatic quotes cannot survive a corrected introduction.
    data["evidence"] = [e for e in data["evidence"] if e["id"] in manual or e["quote"] in data["original_intro"]]
    item = WorkInput.model_validate(data, context={"review_evidence": manual})
    meta = item.source_meta
    if meta and ((meta.content_type == "漫画" and meta.episode_count is not None) or
                 (meta.content_type != "漫画" and meta.chapter_count is not None)):
        raise ValueError("漫画章节与剧集集数必须一起核对")
    # Direct contradictions in the effective copy require an explicit copy edit.
    for field, label in [("harem", "后宫"), ("romance", "感情线"), ("tragic", "虐心")]:
        if field in confirmed:
            value = field_value(data,field)
            text = data["original_intro"] + "\n" + data["summary"]
            if value is not False and (f"无{label}" in text or f"没有{label}" in text):
                raise ValueError("有效简介或摘要与核对事实冲突，请同时校正文稿")
            if value is not True and f"明确有{label}" in text:
                raise ValueError("有效简介或摘要与核对事实冲突，请同时校正文稿")
    return item


def candidate(work, report, changes, reason, allowed_sources=None):
    data = work_data(work)
    state = work.review_state
    confirmed = copy.deepcopy(state.confirmed_fields)
    allowed = {report.field, "original_intro", "summary"}
    if report.field in META_FIELDS:
        allowed |= META_FIELDS
    if report.field in MAPPING:
        allowed = {report.field}
    if any(c.field not in allowed for c in changes) or report.field not in {c.field for c in changes}:
        raise ValueError("仅可核对主问题及必要的关联字段")
    diffs = []
    source = state.source_snapshot["data"]
    for change in changes:
        basis = change.basis.model_dump()
        if basis["source_url"] not in (allowed_sources or {work.source_url}):
            raise ValueError("依据链接必须对应本作已登记来源")
        before = field_value(data, change.field)
        set_field(data, change.field, change.value)
        confirmed[change.field] = {"value": copy.deepcopy(change.value), "basis": basis,
            "evidence_id": "manual-" + uuid.uuid4().hex,
            "source_value": field_value(source, change.field),
            "source_fingerprint": source_fingerprint(source, change.field)}
        diffs.append({"field": change.field, "before": before, "after": change.value, "basis": basis})
    return validate_effective(data, confirmed), confirmed, diffs


def source_fingerprint(data, field):
    # Facts/tags depend on the introduction as well as the extracted value.
    values = [field_value(data, field)]
    if field in {"summary", "genres", "themes", "pace", "harem", "romance", "tragic"}:
        values.append(data.get("original_intro"))
    return digest(values)


def merge_confirmed(data, state):
    raw = copy.deepcopy(data)
    recheck = set(state.recheck_fields)
    for field, entry in state.confirmed_fields.items():
        if source_fingerprint(raw, field) != entry["source_fingerprint"]:
            recheck.add(field)
        set_field(data, field, entry["value"])
    if state.manual_hold:
        data["review_status"] = "pending"
    return validate_effective(data, state.confirmed_fields), sorted(recheck)
