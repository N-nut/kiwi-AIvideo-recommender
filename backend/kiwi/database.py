from datetime import datetime, timezone
from pathlib import Path

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Boolean, DateTime, Integer, String, Text, create_engine, select, text
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
    collected_at: Mapped[str] = mapped_column(String(10))
    evidence: Mapped[list] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    review_status: Mapped[str] = mapped_column(String(16), index=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    embedding: Mapped[list | None] = mapped_column(Vector(1024).with_variant(JSON, "sqlite"), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    embedding_dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    embedded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


def make_database(url):
    kwargs = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if ":memory:" in url:
            kwargs["poolclass"] = StaticPool
        elif url.startswith("sqlite:///"):
            Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, pool_pre_ping=True, **kwargs)
    return engine, sessionmaker(engine, expire_on_commit=False)


def initialize(engine):
    if engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(engine)


def public_work(work):
    fields = ["id", "title", "original_intro", "summary", "genres", "themes", "pace", "harem", "romance", "tragic", "source_url", "collected_at", "evidence", "review_note"]
    return {key: getattr(work, key) for key in fields}


def utc_now():
    return datetime.now(timezone.utc)
