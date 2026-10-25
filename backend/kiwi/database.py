from datetime import datetime, timezone
from pathlib import Path

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, create_engine, event, inspect, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
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


# Only the explicitly retired seed IDs; other manually imported data is preserved.
RETIRED_IDS = tuple(f"bili-{i}" for i in (
    45128,102888,42977,102887,28092,103017,102867,32556,32430,102998,100171,102872,
    102894,43048,113970,102999,149531,102892,149526,45991,121468,88987,102829,149530,
    102864,148585,149529,33874,103000,102995,103003,111618,112207,102893,149520,103007))


def make_database(url):
    kwargs = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
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
            connection.execute(Work.__table__.delete().where(Work.id.in_(RETIRED_IDS)))
            connection.execute(CatalogRefresh.__table__.insert().values(id="seed-retired", payload={"count": 36}))


PUBLIC_WORK_FIELDS = ("id", "title", "original_intro", "summary", "genres", "themes", "pace", "harem", "romance", "tragic", "source_url", "cover_url", "source_meta", "collected_at", "evidence", "review_note")


def public_work(work):
    return {key: getattr(work, key) for key in PUBLIC_WORK_FIELDS}


def utc_now():
    return datetime.now(timezone.utc)


def as_utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
