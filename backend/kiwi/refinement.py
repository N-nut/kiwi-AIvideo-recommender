"""Controlled refinement grammar and atomic, account-independent preference merging.

The model proposes operations; a complete clause grammar independently authorizes
them. Unknown wording is deliberately sent back for review, never partly applied.
"""
import re

from pydantic import ValidationError

from .schemas import GENRES, THEMES, Preferences, RefinementPlan

FEATURES = {"后宫": "harem", "感情线": "romance", "恋爱线": "romance", "虐心": "tragic"}
TARGETS = ("soft.genres", "soft.themes", "soft.pace", "required.genres", "required.themes",
           "required.pace", "required.harem", "required.romance", "required.tragic",
           "excluded_features", "excluded_genres")


class InvalidRefinementOutput(ValueError):
    pass


def unique(values):
    return sorted(set(values), key=lambda v: (type(v).__name__, str(v)))


def slots(preferences):
    result = {target: [] for target in TARGETS}
    soft = preferences.soft_preferences
    for field in ("genres", "themes"):
        result[f"soft.{field}"] = unique(getattr(soft, field))
    result["soft.pace"] = [soft.pace] if soft.pace else []
    for item in preferences.required:
        result[f"required.{item.field}"].append(item.value)
    result["excluded_features"] = list(preferences.excluded_features)
    result["excluded_genres"] = list(preferences.excluded_genres)
    return {key: unique(value) for key, value in result.items()}


def from_slots(values):
    if len(values["soft.pace"]) > 1:
        raise ValueError("普通节奏偏好互相冲突，请明确替换节奏")
    return Preferences.model_validate({
        "soft_preferences": {"genres": values["soft.genres"], "themes": values["soft.themes"],
                             "pace": next(iter(values["soft.pace"]), None)},
        "required": [{"field": target.split(".")[1], "value": value}
                     for target in TARGETS if target.startswith("required.") for value in values[target]],
        "excluded_features": values["excluded_features"], "excluded_genres": values["excluded_genres"],
    })


def normalize(preferences):
    if not preferences.meaningful or preferences.conflicts or preferences.unresolved_constraints:
        raise ValueError("需要有效且已核对的基准偏好")
    return from_slots(slots(preferences))


def diff_preferences(base, candidate):
    old, new = slots(base), slots(candidate)
    changes, preserved = [], []
    for target in TARGETS:
        before, after = old[target], new[target]
        same = [value for value in before if value in after]
        if same:
            preserved.append({"target": target, "values": same})
        if before != after:
            removed = any(value not in after for value in before)
            added = any(value not in before for value in after)
            changes.append({"kind": "replaced" if removed and added else "removed" if removed else "added",
                            "target": target, "before": before, "after": after})
    return changes, preserved


def atom(text):
    value = re.sub(r"^(?:题材|主题|剧情特色)(?:为|是)?", "", text)
    value = re.sub(r"(?:题材|主题|的故事|故事|情节)$", "", value)
    if value in GENRES:
        return "genres", value
    if value in THEMES:
        return "themes", value
    if value in ("节奏快", "快节奏", "节奏快一点", "快"):
        return "pace", "快"
    if value in ("节奏舒缓", "节奏慢", "慢节奏", "舒缓"):
        return "pace", "舒缓"
    feature = re.fullmatch(r"(有|无|没有)?(后宫|感情线|恋爱线|虐心)", value)
    if feature:
        return FEATURES[feature[2]], feature[1] not in ("无", "没有")
    return None


def parse_refinement_baseline(base, text):
    """Full-match every clause; return a plan even when a clause needs review."""
    existing = slots(base)
    operations, issues = [], []

    def scope(field, value, explicit=None):
        if explicit:
            return f"{explicit}.{field}"
        choices = [f"{kind}.{field}" for kind in ("soft", "required") if f"{kind}.{field}" in existing and value in existing[f"{kind}.{field}"]]
        if len(choices) > 1:
            raise ValueError("同一条件同时是普通偏好和必须条件，请明确修改哪一层")
        return choices[0] if choices else f"soft.{field}"

    def append(op, target, values, evidence, old=None):
        row = {"op": op, "target": target, "values": values, "evidence": evidence}
        if old is not None:
            row["old_values"] = old
        operations.append(row)

    for source in re.split(r"[，,。；;！!\n＋+]+|而且|并且|同时", text):
        clause = re.sub(r"\s+", "", source)
        if not clause:
            continue
        try:
            if clause in ("其他不变", "其它不变", "保持原样", "条件不变", "保持不变"):
                continue
            # Cancellation is recognized before ordinary negative/addition forms.
            cancel = re.fullmatch(r"(?:取消|去掉|移除|不再限定)(.*)|不再排除(.+)", clause)
            if cancel:
                body = cancel[1] if cancel[1] is not None else "排除" + cancel[2]
                negative = re.fullmatch(r"(?:不要|排除|不看)(.+)", body)
                if negative:
                    item = atom(negative[1])
                    if item and (item[0] == "genres" or item[0] in FEATURES.values() and item[1] is True):
                        field, value = item
                        append("remove", "excluded_genres" if field == "genres" else "excluded_features",
                               [value if field == "genres" else field], source)
                        continue
                    raise ValueError("暂不支持该排除条件，请手动核对")
                explicit = "required" if re.match(r"必须|一定要|只看", body) else "soft" if re.match(r"普通偏好|偏好", body) else None
                body = re.sub(r"^(?:必须|一定要|只看|普通偏好|偏好)", "", body)
                item = atom(body)
                if item:
                    field, value = item
                    target = scope(field, value, explicit)
                    if target in existing:
                        append("remove", target, [value], source)
                        continue
                raise ValueError("请明确要取消的普通偏好、必须条件或排除项")
            replace = re.fullmatch(r"(?:把)?(.+?)(?:改成|改为|换成|替换为)(.+)", clause)
            if replace:
                left, right = replace[1], replace[2]
                explicit = "required" if left.startswith("必须") else "soft" if re.match(r"普通偏好|偏好", left) else None
                left = re.sub(r"^(?:必须|普通偏好|偏好)", "", left)
                new = atom(right)
                fields = {"题材": "genres", "剧情特色": "themes", "主题": "themes", "节奏": "pace"}
                if left in fields and new and new[0] == fields[left]:
                    field, value = new
                    available = [f"{kind}.{field}" for kind in ("soft", "required") if existing[f"{kind}.{field}"]]
                    if explicit is None and len(available) > 1:
                        raise ValueError("请明确替换普通偏好还是必须条件")
                    target = f"{explicit}.{field}" if explicit else available[0] if available else f"soft.{field}"
                    old = existing[target]
                else:
                    previous = atom(left)
                    if not previous or not new or previous[0] != new[0]:
                        raise ValueError("请明确替换同一类条件的原值和新值")
                    field, value = new
                    target = scope(field, previous[1], explicit)
                    old = [previous[1]]
                if not old or any(value not in existing.get(target, []) for value in old):
                    raise ValueError("要替换的原条件不存在，请核对当前偏好")
                append("replace", target, [value], source, old)
                continue
            negative = re.fullmatch(r"(?:不要|排除|不看|不想看|拒绝)(.+)", clause)
            if negative:
                item = atom(negative[1])
                if item and (item[0] == "genres" or item[0] in FEATURES.values() and item[1] is True):
                    field, value = item
                    append("add", "excluded_genres" if field == "genres" else "excluded_features",
                           [value if field == "genres" else field], source)
                    continue
                raise ValueError("暂不支持该排除条件，请明确题材或已有剧情特征")
            addition = re.fullmatch(r"(?:再加上|再加|加点|增加|添加|加上|追加|也想看|还想看|想看|偏好)?(?:也|还)?(一定要|必须|只看|只要)?(.+)", clause)
            mandatory, body = addition[1], addition[2]
            for part in re.split(r"[、和及]", body):
                item = atom(part)
                if not item:
                    raise ValueError("暂不能确定这项调整，请明确题材、剧情特色、节奏或使用作品反馈")
                field, value = item
                if not mandatory and field in FEATURES.values():
                    raise ValueError("剧情特征请明确使用必须或排除条件")
                append("add", f"{'required' if mandatory else 'soft'}.{field}", [value], source)
        except ValueError as exc:
            issues.append(str(exc))
    if not operations and not issues and not re.search(r"保持原样|条件不变|保持不变|其他不变|其它不变", text):
        issues.append("请写出本次需要调整的条件")
    if len(operations) > 20:
        return RefinementPlan(unresolved_constraints=["本次调整过多，请分次核对"])
    return RefinementPlan(operations=operations, unresolved_constraints=list(dict.fromkeys(issues))[:10])


def merge_refinement(base, text, plan):
    base = normalize(base)
    original = slots(base)
    preserved = [{"target": key, "values": value} for key, value in original.items() if value]

    def pending(issues):
        return {"status": "needs_confirmation", "preferences": None, "changes": [], "preserved": preserved,
                "issues": list(dict.fromkeys(issues))}

    for operation in plan.operations:
        if operation.evidence not in text:
            raise InvalidRefinementOutput("调整证据不在本次文字中")
    expected = parse_refinement_baseline(base, text)
    issues = expected.unresolved_constraints + plan.unresolved_constraints
    if issues:
        return pending(issues)

    def signature(operation):
        return (operation.op, operation.target, tuple(unique(operation.values)),
                tuple(unique(operation.old_values)) if operation.op == "replace" else ())

    # Both full-text coverage and each operation's local evidence must agree.
    def ordered_by_target(operations):
        return {target: [signature(op) for op in operations if op.target == target] for target in TARGETS}

    if ordered_by_target(plan.operations) != ordered_by_target(expected.operations):
        return pending(["本次操作与明确表达不完全一致，请重述或手动核对；原条件已保留"])
    for operation in plan.operations:
        local = parse_refinement_baseline(base, operation.evidence)
        if local.unresolved_constraints or signature(operation) not in {signature(op) for op in local.operations}:
            return pending(["无法从本次引用确认调整意图，请重述或手动核对"])
    values = {key: list(value) for key, value in original.items()}
    for operation in plan.operations:
        target = values[operation.target]
        if operation.op == "replace" and any(v not in target for v in operation.old_values):
            return pending(["要替换的原条件不存在，请核对当前偏好"])
        removals = operation.values if operation.op == "remove" else operation.old_values if operation.op == "replace" else []
        values[operation.target] = unique([v for v in target if v not in removals] + ([] if operation.op == "remove" else operation.values))
    try:
        candidate = from_slots(values)
    except (ValueError, ValidationError):
        return pending(["调整后条件冲突或超出容量，请手动核对；原条件已保留"])
    if candidate.conflicts or not candidate.meaningful:
        return pending(candidate.conflicts or ["请至少保留一项有效偏好"])
    changes, preserved = diff_preferences(base, candidate)
    return {"status": "ready" if changes else "no_change", "preferences": candidate.model_dump(),
            "changes": changes, "preserved": preserved, "issues": []}
