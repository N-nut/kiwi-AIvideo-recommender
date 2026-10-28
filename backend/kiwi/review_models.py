"""Strict field-specific contracts shared by submission and review."""
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator

from .schemas import GENRES, THEMES, StrictModel

OperationID = Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{32}$")]
Version = Annotated[int, Field(strict=True, ge=1, le=2_147_483_647)]
WorkID = Annotated[str, Field(strict=True, pattern=r"^[a-z0-9_-]{1,80}$")]
Status = Literal["pending", "accepted", "rejected", "needs_recheck"]
Category = Literal["basic", "tags", "plot_fact", "mapping"]
FIELDS = {
    "basic": ("title", "original_intro", "summary", "content_type", "episode_count", "chapter_count"),
    "tags": ("genres", "themes", "pace"),
    "plot_fact": ("harem", "romance", "tragic"),
    "mapping": ("cover_mapping", "preview_mapping", "source_link", "work_identity"),
}
NULLABLE = {"pace", "harem", "romance", "tragic", "episode_count", "chapter_count"}
MAPPING = set(FIELDS["mapping"])


def https_url(value):
    if type(value) is not str or len(value) > 1000:
        raise ValueError("来源链接无效")
    try:
        url = urlsplit(value)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.port not in (None, 443):
            raise ValueError()
    except ValueError:
        raise ValueError("仅支持无凭据的 HTTPS 来源链接") from None
    return value


def valid_value(field, value):
    if field in NULLABLE and value is None:
        return None
    if field in {"harem", "romance", "tragic"}:
        valid = type(value) is bool
    elif field in {"episode_count", "chapter_count"}:
        valid = type(value) is int and 1 <= value <= 10000
    elif field in {"genres", "themes"}:
        valid = (type(value) is list and len(value) <= 10 and
                 all(type(v) is str and v in (GENRES if field == "genres" else THEMES) for v in value))
        if valid:
            return sorted(set(value))
    elif field == "pace":
        valid = value in ("快", "舒缓")
    elif field == "content_type":
        valid = value in ("真人剧", "漫剧", "AI剧", "漫画")
    elif field in {"title", "original_intro", "summary"}:
        valid = type(value) is str and (1 if field == "title" else 5) <= len(value.strip()) <= {"title":150,"original_intro":6000,"summary":500}[field]
        if valid:
            return value.strip()
    elif field == "cover_mapping":
        from .crawler import safe_cover
        valid = type(value) is str and bool(safe_cover(value))
    elif field in MAPPING:
        valid = value == "unavailable" or field in {"source_link", "work_identity"} and value == "verified"
    else:
        valid = False
    if not valid:
        raise ValueError("字段值或类型不在允许范围")
    return value


class SetSuggestion(StrictModel):
    kind: Literal["set"]
    value: Any


class UnknownSuggestion(StrictModel):
    kind: Literal["unknown"]


class IssueSuggestion(StrictModel):
    kind: Literal["issue"]


class SourceHint(StrictModel):
    url: str | None = None
    quote: str | None = Field(default=None, strict=True, max_length=1000)
    _url = field_validator("url")(classmethod(lambda cls, value: https_url(value) if value is not None else None))


class Submission(StrictModel):
    operation_id: OperationID
    work_id: WorkID
    base_revision: Version
    category: Category
    field: str
    suggestion: Annotated[SetSuggestion | UnknownSuggestion | IssueSuggestion, Field(discriminator="kind")]
    description: str = Field(strict=True, min_length=1, max_length=500)
    source_hint: SourceHint | None = None
    related_correction_id: OperationID | None = None

    @field_validator("description", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if type(value) is str else value

    @model_validator(mode="after")
    def supported(self):
        if self.field not in FIELDS[self.category]:
            raise ValueError("问题类别与字段不匹配")
        if self.field in MAPPING:
            if self.suggestion.kind != "issue":
                raise ValueError("对应问题仅支持报告，不能直接替换媒体或来源")
        elif self.suggestion.kind == "unknown":
            if self.field not in NULLABLE:
                raise ValueError("此字段不能恢复未知")
        elif self.suggestion.kind == "set":
            if self.suggestion.value is None:
                raise ValueError("未知事实请明确使用 unknown 建议")
            self.suggestion.value = valid_value(self.field, self.suggestion.value)
        else:
            raise ValueError("请提供建议值或选择未知")
        return self


class Basis(StrictModel):
    kind: Literal["quoted", "not_stated"]
    source_url: str
    source_text: str = Field(strict=True, min_length=1, max_length=6000)
    quote: str | None = Field(default=None, strict=True, min_length=1, max_length=1000)
    _url = field_validator("source_url")(classmethod(lambda cls, value: https_url(value)))

    @model_validator(mode="after")
    def quoted(self):
        if not self.source_text.strip() or self.kind == "quoted" and (not self.quote or not self.quote.strip() or self.quote not in self.source_text):
            raise ValueError("逐字摘录必须存在于所核对来源原文")
        if self.kind == "not_stated" and self.quote is not None:
            raise ValueError("未说明的事实不接受确定引文")
        return self


class Change(StrictModel):
    field: str
    value: Any
    basis: Basis

    @model_validator(mode="after")
    def supported(self):
        self.value = valid_value(self.field, self.value)
        if self.basis.kind == "not_stated" and (self.field not in NULLABLE or self.value is not None):
            raise ValueError("未说明只能将可空事实恢复未知")
        return self


class ActionBase(StrictModel):
    operation_id: OperationID
    expected_report_revision: OperationID
    reason: str = Field(strict=True, min_length=1, max_length=500)
    _trim = field_validator("reason", mode="before")(classmethod(lambda cls, value: value.strip() if type(value) is str else value))


class Approve(ActionBase):
    action: Literal["approve"]
    expected_work_revision: Version
    changes: list[Change] = Field(min_length=1, max_length=5)
    pause: bool = Field(default=False, strict=True)
    media_hold: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def unique(self):
        if len({c.field for c in self.changes}) != len(self.changes):
            raise ValueError("每个字段只能修改一次")
        return self


class Reject(ActionBase):
    action: Literal["reject"]


class Rebase(ActionBase):
    action: Literal["rebase"]
    expected_work_revision: Version


ReviewAction = Annotated[Approve | Reject | Rebase, Field(discriminator="action")]


class Availability(StrictModel):
    operation_id: OperationID
    action: Literal["pause", "restore"]
    expected_work_revision: Version
    reason: str = Field(strict=True, min_length=1, max_length=500)
    media_hold: bool = Field(default=False, strict=True)
    clear_media_hold: Basis | None = None
    related_correction_id: OperationID | None = None
    _trim = field_validator("reason", mode="before")(classmethod(lambda cls, value: value.strip() if type(value) is str else value))
