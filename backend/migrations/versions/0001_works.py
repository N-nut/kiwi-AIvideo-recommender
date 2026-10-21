"""Initial works and vector schema."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from pgvector.sqlalchemy import Vector

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    document = sa.JSON().with_variant(JSONB, "postgresql")
    op.create_table("works",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("title", sa.String(150), nullable=False),
        sa.Column("original_intro", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("genres", document, nullable=False), sa.Column("themes", document, nullable=False),
        sa.Column("pace", sa.String(10)), sa.Column("harem", sa.Boolean()),
        sa.Column("romance", sa.Boolean()), sa.Column("tragic", sa.Boolean()),
        sa.Column("source_url", sa.Text(), nullable=False), sa.Column("collected_at", sa.String(10), nullable=False),
        sa.Column("evidence", document, nullable=False), sa.Column("review_status", sa.String(16), nullable=False),
        sa.Column("review_note", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(1024).with_variant(sa.JSON(), "sqlite")),
        sa.Column("embedding_model", sa.String(120)), sa.Column("embedding_dimension", sa.Integer()),
        sa.Column("content_hash", sa.String(64), nullable=False), sa.Column("embedded_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_works_title", "works", ["title"])
    op.create_index("ix_works_review_status", "works", ["review_status"])


def downgrade():
    op.drop_index("ix_works_review_status", "works")
    op.drop_index("ix_works_title", "works")
    op.drop_table("works")
