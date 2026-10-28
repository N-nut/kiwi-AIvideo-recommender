from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StrictBool, StrictStr, ValidationInfo, field_validator, model_validator

GENRES = ["修仙", "玄幻", "都市", "末世", "科幻", "悬疑", "恋爱", "古风", "搞笑", "武侠"]
THEMES = ["逆袭", "复仇", "重生", "穿越", "系统", "成长", "冒险", "经营", "治愈", "战斗"]
Feature = Literal["harem", "romance", "tragic"]
Pace = Literal["快", "舒缓"]
CategoryCode = Literal["real-drama", "comic-drama", "ai-drama", "comic"]
ContentType = Literal["真人剧", "漫剧", "AI剧", "漫画", "未标注"]


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
    query: str = Field(default="", max_length=300, strict=True)
    limit: int = Field(default=3, ge=1, le=3, strict=True)
    exclude_work_ids: list[Annotated[str, Field(min_length=1, max_length=80, strict=True)]] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def unique_exclusions(self):
        self.exclude_work_ids = list(dict.fromkeys(self.exclude_work_ids))
        return self


RefinementTarget = Literal[
    "soft.genres", "soft.themes", "soft.pace", "required.genres", "required.themes",
    "required.pace", "required.harem", "required.romance", "required.tragic",
    "excluded_features", "excluded_genres",
]
RefinementValue = StrictStr | StrictBool


class RefinementRequest(StrictModel):
    base_preferences: Preferences
    text: str = Field(strict=True, min_length=1, max_length=300)
    base_revision: int = Field(strict=True, ge=1, le=2_147_483_647)

    @field_validator("text", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if type(value) is str else value

    @model_validator(mode="after")
    def valid_base(self):
        base = self.base_preferences
        if not base.meaningful or base.conflicts or base.unresolved_constraints:
            raise ValueError("请先确认并执行有效偏好")
        return self


class RefinementOperation(StrictModel):
    target: RefinementTarget
    values: list[RefinementValue] = Field(min_length=1, max_length=20)
    evidence: str = Field(strict=True, min_length=1, max_length=300)

    @model_validator(mode="after")
    def valid_values(self):
        target = self.target
        allowed = (GENRES if target.endswith("genres") else THEMES if target.endswith("themes")
                   else ["快", "舒缓"] if target.endswith("pace") else
                   ["harem", "romance", "tragic"] if target == "excluded_features" else [True, False])
        for values in [self.values] + ([self.old_values] if hasattr(self, "old_values") else []):
            if any(not any(type(v) is type(a) and v == a for a in allowed) for v in values):
                raise ValueError("调整值超出目标白名单或类型不正确")
        if not self.evidence.strip():
            raise ValueError("调整证据不能为空")
        return self


class AddRefinement(RefinementOperation):
    op: Literal["add"]


class RemoveRefinement(RefinementOperation):
    op: Literal["remove"]


class ReplaceRefinement(RefinementOperation):
    op: Literal["replace"]
    old_values: list[RefinementValue] = Field(min_length=1, max_length=20)


class RefinementPlan(StrictModel):
    operations: list[Annotated[AddRefinement | RemoveRefinement | ReplaceRefinement, Field(discriminator="op")]] = Field(default_factory=list, max_length=20)
    unresolved_constraints: list[Annotated[str, Field(strict=True, min_length=1, max_length=200)]] = Field(default_factory=list, max_length=10)


class RefinementChange(StrictModel):
    kind: Literal["added", "removed", "replaced"]
    target: RefinementTarget
    before: list[RefinementValue]
    after: list[RefinementValue]


class PreservedPreference(StrictModel):
    target: RefinementTarget
    values: list[RefinementValue]


class RefinementResponse(StrictModel):
    request_id: str
    status: Literal["ready", "no_change", "needs_confirmation"]
    base_revision: int
    preferences: Preferences | None
    changes: list[RefinementChange]
    preserved: list[PreservedPreference]
    issues: list[str]
    mode: Literal["baseline", "live"]
    timings_ms: dict[str, float]
    usage: dict[str, int]


class Evidence(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{1,64}$")
    field: Literal["summary", "genres", "themes", "pace", "harem", "romance", "tragic"]
    quote: str = Field(min_length=1, max_length=1000)


class SourceMetadata(StrictModel):
    provider: Literal["hongguo"] = "hongguo"
    content_type: ContentType = "未标注"
    tags: list[str] = Field(default_factory=list, max_length=40)
    pages: list[HttpUrl] = Field(min_length=1, max_length=100)
    categories: list[CategoryCode] = Field(default_factory=list, max_length=4)
    rank: int | None = Field(default=None, ge=1, le=100)
    heat: str | None = Field(default=None, max_length=40)
    episode_count: int | None = Field(default=None, ge=1, le=10000)
    chapter_count: int | None = Field(default=None, ge=1, le=10000)
    classification_note: str = Field(default="", max_length=200)


class RefreshRequest(StrictModel):
    categories: list[CategoryCode] = Field(default_factory=lambda: ["comic-drama", "ai-drama"], max_length=4)
    include_hot_rank: StrictBool = False

    @model_validator(mode="after")
    def scope(self):
        self.categories = list(dict.fromkeys(self.categories))
        if not self.categories and not self.include_hot_rank:
            raise ValueError("请至少选择一个类别或榜单")
        return self


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
    def grounded(self, info: ValidationInfo):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("名称不能为空")
        if len({e.id for e in self.evidence}) != len(self.evidence):
            raise ValueError("证据标识重复")
        for e in self.evidence:
            manual = (info.context or {}).get("review_evidence", {}).get(e.id)
            trusted = manual and manual["field"] == e.field and manual["quote"] == e.quote and manual["value"] == getattr(self, e.field)
            if e.quote not in self.original_intro and not trusted:
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


class PublicReview(StrictModel):
    revision: int
    state: Literal["automatic", "partial", "recheck", "unavailable"]
    confirmed_fields: list[str]
    recheck_fields: list[str]


class PublicWork(StrictModel):
    id: str
    title: str
    original_intro: str
    summary: str
    genres: list[str]
    themes: list[str]
    pace: str | None
    harem: bool | None
    romance: bool | None
    tragic: bool | None
    source_url: str
    cover_url: str | None
    source_meta: SourceMetadata | None
    collected_at: str
    evidence: list[Evidence]
    review_note: str
    review: PublicReview


class MatchedFeatures(StrictModel):
    content_type: list[Literal["真人剧", "漫剧", "AI剧"]] = Field(default_factory=list, max_length=1)
    genres: list[str] = Field(default_factory=list, max_length=10)
    themes: list[str] = Field(default_factory=list, max_length=10)


class HomeWorkItem(PublicWork):
    basis: Literal["favorites", "public"]
    matched_features: MatchedFeatures
    reason: str = Field(min_length=1, max_length=300)


class PromptSuggestion(StrictModel):
    label: str = Field(min_length=1, max_length=16)
    text: str = Field(min_length=1, max_length=300)
    basis: Literal["favorites", "public"]
    genres: list[str] = Field(default_factory=list, max_length=1)
    themes: list[str] = Field(default_factory=list, max_length=1)


class HomeRecommendationResponse(StrictModel):
    request_id: str
    strategy_version: Literal["favorites-tags-v1"] = "favorites-tags-v1"
    carousel_mode: Literal["personalized", "mixed", "default"]
    prompts_mode: Literal["personalized", "default"]
    items: list[HomeWorkItem] = Field(max_length=6)
    prompts: list[PromptSuggestion] = Field(max_length=4)
    warnings: list[str] = Field(default_factory=list)
