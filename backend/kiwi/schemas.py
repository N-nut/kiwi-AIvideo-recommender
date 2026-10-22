from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StrictBool, model_validator

GENRES = ["修仙", "玄幻", "都市", "末世", "科幻", "悬疑", "恋爱", "古风", "搞笑", "武侠"]
THEMES = ["逆袭", "复仇", "重生", "穿越", "系统", "成长", "冒险", "经营", "治愈", "战斗"]
Feature = Literal["harem", "romance", "tragic"]
Pace = Literal["快", "舒缓"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SoftPreferences(StrictModel):
    genres: list[str] = Field(default_factory=list, max_length=10)
    themes: list[str] = Field(default_factory=list, max_length=10)
    pace: Pace | None = None

    @model_validator(mode="after")
    def whitelist(self):
        if any(x not in GENRES for x in self.genres) or any(x not in THEMES for x in self.themes):
            raise ValueError("题材或主题超出支持范围，请放入待确认条件")
        self.genres = sorted(set(self.genres))
        self.themes = sorted(set(self.themes))
        return self


class Requirement(StrictModel):
    field: Literal["genres", "themes", "pace", "harem", "romance", "tragic"]
    value: str | StrictBool

    @model_validator(mode="after")
    def supported(self):
        valid = {"genres": GENRES, "themes": THEMES, "pace": ["快", "舒缓"]}
        if self.field in valid and (type(self.value) is not str or self.value not in valid[self.field]):
            raise ValueError("不支持的必须条件")
        if self.field not in valid and type(self.value) is not bool:
            raise ValueError("剧情特征必须使用布尔值")
        return self


class Preferences(StrictModel):
    schema_version: Literal[1] = 1
    soft_preferences: SoftPreferences = Field(default_factory=SoftPreferences)
    required: list[Requirement] = Field(default_factory=list, max_length=20)
    excluded_features: list[Feature] = Field(default_factory=list, max_length=3)
    excluded_genres: list[str] = Field(default_factory=list, max_length=10)
    unresolved_constraints: list[str] = Field(default_factory=list, max_length=10)
    conflicts: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def conflicts_from_constraints(self):
        if any(x not in GENRES for x in self.excluded_genres):
            raise ValueError("不支持的排除题材")
        computed = []
        for item in self.required:
            if item.field == "genres" and item.value in self.excluded_genres:
                computed.append(f"必须包含且排除了题材：{item.value}")
            if item.field in self.excluded_features and item.value is True:
                computed.append(f"必须包含且排除了特征：{item.field}")
            if item.field in ("pace", "harem", "romance", "tragic"):
                if len({x.value for x in self.required if x.field == item.field}) > 1:
                    computed.append(f"必须条件互相冲突：{item.field}")
        self.conflicts = list(dict.fromkeys(self.conflicts + computed))
        self.excluded_features = sorted(set(self.excluded_features))
        self.excluded_genres = sorted(set(self.excluded_genres))
        return self

    @property
    def meaningful(self):
        soft = self.soft_preferences
        return bool(soft.genres or soft.themes or soft.pace or self.required or self.excluded_features or self.excluded_genres)


class ParseRequest(StrictModel):
    text: str = Field(min_length=1, max_length=300)

    @model_validator(mode="after")
    def not_blank(self):
        self.text = self.text.strip()
        if not self.text:
            raise ValueError("请先描述想看的故事")
        return self


class RecommendationRequest(StrictModel):
    preferences: Preferences
    limit: int = Field(default=3, ge=1, le=3, strict=True)


class Evidence(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{1,64}$")
    field: Literal["summary", "genres", "themes", "pace", "harem", "romance", "tragic"]
    quote: str = Field(min_length=1, max_length=1000)


class SourceMetadata(StrictModel):
    provider: Literal["hongguo"] = "hongguo"
    content_type: Literal["真人剧", "漫剧", "AI剧", "未标注"] = "未标注"
    tags: list[str] = Field(default_factory=list, max_length=40)
    pages: list[HttpUrl] = Field(min_length=1, max_length=2)
    rank: int | None = Field(default=None, ge=1, le=100)
    heat: str | None = Field(default=None, max_length=40)
    episode_count: int | None = Field(default=None, ge=1, le=10000)


class WorkInput(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{1,80}$")
    title: str = Field(min_length=1, max_length=150)
    original_intro: str = Field(min_length=5, max_length=6000)
    summary: str = Field(min_length=5, max_length=500)
    genres: list[str] = Field(default_factory=list)
    themes: list[str] = Field(default_factory=list)
    pace: Pace | None = None
    harem: StrictBool | None = None
    romance: StrictBool | None = None
    tragic: StrictBool | None = None
    source_url: HttpUrl
    cover_url: HttpUrl | None = None
    source_meta: SourceMetadata | None = None
    collected_at: date
    evidence: list[Evidence] = Field(min_length=1)
    review_status: Literal["approved", "pending", "rejected"] = "pending"
    review_note: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def grounded(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("名称不能为空")
        if len({e.id for e in self.evidence}) != len(self.evidence):
            raise ValueError("证据标识重复")
        for e in self.evidence:
            if e.quote not in self.original_intro:
                raise ValueError(f"证据不在原始资料中：{e.id}")
        for field in ["summary", "genres", "themes", "pace", "harem", "romance", "tragic"]:
            value = getattr(self, field)
            if value is not None and value != [] and not any(e.field == field for e in self.evidence):
                raise ValueError(f"字段缺少依据：{field}")
        if any(x not in GENRES for x in self.genres) or any(x not in THEMES for x in self.themes):
            raise ValueError("作品标签超出支持范围")
        return self


class GeneratedReason(StrictModel):
    work_id: str
    reason: str = Field(min_length=1, max_length=400)
    caveats: list[str] = Field(default_factory=list, max_length=10)
    evidence_ids: list[str] = Field(min_length=1, max_length=20)
    quotes: list[str] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def nonempty_references(self):
        if not self.reason.strip() or any(not q.strip() for q in self.quotes) or any(not i.strip() for i in self.evidence_ids):
            raise ValueError("推荐理由和引用不能为空白")
        return self


class ReasonBatch(StrictModel):
    items: list[GeneratedReason] = Field(max_length=3)
