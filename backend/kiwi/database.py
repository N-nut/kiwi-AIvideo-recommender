from datetime import datetime, timezone
from pathlib import Path

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text, UniqueConstraint, create_engine, event, inspect, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


class Work(Base):
    __tablename__ = "works"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    title: Mapped[str] = mapped_column(String(150), index=True)
    original_intro: Mapped[str] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text)
    genres: Mapped[list] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    themes: Mapped[list] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    pace: Mapped[str | None] = mapped_column(String(10), nullable=True)
    harem: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    romance: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    tragic: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    source_url: Mapped[str] = mapped_column(Text)
    cover_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_meta: Mapped[dict | None] = mapped_column(JSON().with_variant(JSONB, "postgresql"), nullable=True)
    collected_at: Mapped[str] = mapped_column(String(10))
    evidence: Mapped[list] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    review_status: Mapped[str] = mapped_column(String(16), index=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    embedding: Mapped[list | None] = mapped_column(Vector(1024).with_variant(JSON, "sqlite"), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    embedding_dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    embedded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_state: Mapped["WorkReviewState | None"] = relationship(lazy="selectin", uselist=False, passive_deletes="all")


class WorkPreview(Base):
    __tablename__ = "work_previews"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'ready', 'unavailable')", name="ck_preview_status"),
        CheckConstraint("clip_kind IN ('trailer', 'excerpt')", name="ck_preview_kind"),
        CheckConstraint("status != 'ready' OR (asset_id IS NOT NULL AND video_path IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms > 0 AND width IS NOT NULL AND width > 0 AND height IS NOT NULL AND height > 0 AND size_bytes IS NOT NULL AND size_bytes > 0 AND checked_at IS NOT NULL AND length(trim(usage_basis)) > 0 AND source_hash IS NOT NULL AND processing_hash IS NOT NULL AND video_sha256 IS NOT NULL)", name="ck_preview_ready"),
    )
    work_id: Mapped[str] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    asset_id: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    status: Mapped[str] = mapped_column(String(16))
    clip_kind: Mapped[str] = mapped_column(String(16))
    video_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    poster_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_page_url: Mapped[str] = mapped_column(Text)
    usage_basis: Mapped[str] = mapped_column(Text)
    source_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    processing_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    video_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PreviewJob(Base):
    __tablename__ = "preview_jobs"
    __table_args__ = (CheckConstraint("status IN ('pending','running','ready','unavailable')", name="ck_preview_job_status"),)
    work_id: Mapped[str] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), index=True)
    source_key: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CatalogRefresh(Base):
    __tablename__ = "catalog_refresh"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(20))
    username_key: Mapped[str] = mapped_column(String(20), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    nickname: Mapped[str | None] = mapped_column(String(20), nullable=True)
    nickname_key: Mapped[str | None] = mapped_column(Text().with_variant(Text(collation="C"), "postgresql"), nullable=True)
    avatar_id: Mapped[str] = mapped_column(String(32), default="kiwi-default", server_default="kiwi-default")
    is_reviewer: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    __table_args__ = (Index("uq_users_nickname_key", "nickname_key", unique=True),)


class UserSession(Base):
    __tablename__ = "user_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Favorite(Base):
    __tablename__ = "favorites"
    __table_args__ = (Index("ix_favorites_user_created_work", "user_id", "created_at", "work_id"),)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[str] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class UserWorkFeedback(Base):
    __tablename__ = "user_work_feedback"
    __table_args__ = (
        CheckConstraint("status IN ('not_interested', 'watched')", name="ck_feedback_status"),
        Index("ix_feedback_user_status_updated_work", "user_id", "status", "updated_at", "work_id"),
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[str] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    status: Mapped[str] = mapped_column(String(20))
    revision: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class UserAvatar(Base):
    __tablename__ = "user_avatars"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(32), unique=True)
    image: Mapped[bytes] = mapped_column(LargeBinary)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RecommendationHistory(Base):
    __tablename__ = "recommendation_history"
    __table_args__ = (Index("ix_history_user_created", "user_id", "created_at", "id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    query: Mapped[str] = mapped_column(String(300))
    snapshot: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkReviewState(Base):
    __tablename__ = "work_review_state"
    __table_args__ = (CheckConstraint("revision >= 1 AND revision <= 2147483647", name="ck_review_revision"),)
    work_id: Mapped[str] = mapped_column(ForeignKey("works.id", ondelete="RESTRICT"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    source_snapshot: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    confirmed_fields: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    recheck_fields: Mapped[list] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    manual_hold: Mapped[bool] = mapped_column(Boolean, default=False)
    hold_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_hold: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkCorrection(Base):
    __tablename__ = "work_corrections"
    __table_args__ = (
        CheckConstraint("status IN ('pending','accepted','rejected','needs_recheck')", name="ck_correction_status"),
        CheckConstraint("origin IN ('user','reviewer')", name="ck_correction_origin"),
        UniqueConstraint("submitter_id", "operation_id", name="uq_correction_operation"),
        UniqueConstraint("submitter_id", "active_key", name="uq_correction_active"),
        Index("ix_correction_owner_time", "submitter_id", "created_at", "id"),
        Index("ix_correction_status_time", "status", "created_at", "id"),
        Index("ix_correction_work_field", "work_id", "field"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    work_id: Mapped[str] = mapped_column(ForeignKey("works.id", ondelete="RESTRICT"))
    submitter_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    operation_id: Mapped[str] = mapped_column(String(32))
    request_hash: Mapped[str] = mapped_column(String(64))
    active_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    origin: Mapped[str] = mapped_column(String(16))
    category: Mapped[str] = mapped_column(String(24))
    field: Mapped[str] = mapped_column(String(24))
    base_revision: Mapped[int] = mapped_column(Integer)
    base_snapshot: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    suggestion: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    description: Mapped[str] = mapped_column(Text)
    source_hint: Mapped[dict | None] = mapped_column(JSON().with_variant(JSONB, "postgresql"), nullable=True)
    related_correction_id: Mapped[str | None] = mapped_column(ForeignKey("work_corrections.id", ondelete="RESTRICT"), nullable=True)
    status: Mapped[str] = mapped_column(String(16))
    revision: Mapped[str] = mapped_column(String(32))
    decision: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkReviewEvent(Base):
    __tablename__ = "work_review_events"
    __table_args__ = (
        UniqueConstraint("actor_key", "operation_id", name="uq_review_event_operation"),
        CheckConstraint("(kind = 'permission' AND work_id IS NULL) OR (kind != 'permission' AND work_id IS NOT NULL)", name="ck_review_event_work"),
        Index("ix_review_event_work_time", "work_id", "created_at", "id"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    actor_key: Mapped[str] = mapped_column(String(120))
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    work_id: Mapped[str | None] = mapped_column(ForeignKey("works.id", ondelete="RESTRICT"), nullable=True)
    operation_id: Mapped[str] = mapped_column(String(32))
    request_hash: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(24))
    payload: Mapped[dict] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


@event.listens_for(Session, "before_flush")
def new_work_review_state(session, _context, _instances):
    # A newly inserted work and its source snapshot always commit together.
    for work in list(session.new):
        if isinstance(work, Work) and work.review_state is None:
            from .reviewing import work_data
            work.review_state = WorkReviewState(revision=1,
                source_snapshot={"kind": "import", "data": work_data(work)}, confirmed_fields={},
                recheck_fields=[], manual_hold=False, media_hold=False, updated_at=utc_now())


# Only the explicitly retired seed IDs; other manually imported data is preserved.
RETIRED_IDS = tuple(f"bili-{i}" for i in (
    45128,102888,42977,102887,28092,103017,102867,32556,32430,102998,100171,102872,
    102894,43048,113970,102999,149531,102892,149526,45991,121468,88987,102829,149530,
    102864,148585,149529,33874,103000,102995,103003,111618,112207,102893,149520,103007))


def make_database(url):
    kwargs = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 3}
        if ":memory:" in url:
            kwargs["poolclass"] = StaticPool
        elif url.startswith("sqlite:///"):
            Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, pool_pre_ping=True, **kwargs)
    if engine.dialect.name == "sqlite":
        @event.listens_for(engine, "connect")
        def enable_foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
    return engine, sessionmaker(engine, expire_on_commit=False)


def initialize(engine):
    if engine.dialect.name == "sqlite":
        from .profile_upgrade import upgrade_local_profiles
        upgrade_local_profiles(engine)
    if engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    # Local SQLite installs predate Alembic startup. Upgrade these two nullable
    # columns in place; PostgreSQL uses the matching explicit 0002 migration.
    if engine.dialect.name == "sqlite" and inspect(engine).has_table("works"):
        columns = {c["name"] for c in inspect(engine).get_columns("works")}
        with engine.begin() as connection:
            for name, sqltype in [("cover_url", "TEXT"), ("source_meta", "JSON")]:
                if name not in columns:
                    connection.execute(text(f"ALTER TABLE works ADD COLUMN {name} {sqltype}"))
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        if connection.execute(select(CatalogRefresh.id).where(CatalogRefresh.id == "seed-retired")).first() is None:
            # Explicit seed retirement predates review records. Never erase audit.
            safe = [key for key in RETIRED_IDS if not connection.execute(select(WorkReviewEvent.id).where(WorkReviewEvent.work_id == key)).first()
                    and not connection.execute(select(WorkCorrection.id).where(WorkCorrection.work_id == key)).first()]
            connection.execute(WorkReviewState.__table__.delete().where(WorkReviewState.work_id.in_(safe)))
            connection.execute(Work.__table__.delete().where(Work.id.in_(safe)))
            connection.execute(CatalogRefresh.__table__.insert().values(id="seed-retired", payload={"count": 36}))


PUBLIC_WORK_FIELDS = ("id", "title", "original_intro", "summary", "genres", "themes", "pace", "harem", "romance", "tragic", "source_url", "cover_url", "source_meta", "collected_at", "evidence", "review_note")


def public_work(work):
    from .reviewing import public_review
    return {**{key: getattr(work, key) for key in PUBLIC_WORK_FIELDS}, "review": public_review(work)}


def utc_now():
    return datetime.now(timezone.utc)


def as_utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
