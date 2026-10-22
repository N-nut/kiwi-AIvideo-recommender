"""Hongguo covers, provenance, refresh state and retirement of the old seed."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    # SQLite may already have received the equivalent local startup upgrade.
    connection = op.get_bind()
    columns = {c["name"] for c in sa.inspect(connection).get_columns("works")}
    if "cover_url" not in columns:
        op.add_column("works", sa.Column("cover_url", sa.Text()))
    if "source_meta" not in columns:
        op.add_column("works", sa.Column("source_meta", sa.JSON().with_variant(JSONB, "postgresql")))
    if not sa.inspect(connection).has_table("catalog_refresh"):
        op.create_table("catalog_refresh", sa.Column("id", sa.String(32), primary_key=True),
                        sa.Column("payload", sa.JSON().with_variant(JSONB, "postgresql"), nullable=False))
    retired = [f"bili-{i}" for i in (45128,102888,42977,102887,28092,103017,102867,32556,32430,102998,100171,102872,102894,43048,113970,102999,149531,102892,149526,45991,121468,88987,102829,149530,102864,148585,149529,33874,103000,102995,103003,111618,112207,102893,149520,103007)]
    works = sa.table("works", sa.column("id", sa.String))
    op.execute(works.delete().where(works.c.id.in_(retired)))


def downgrade():
    op.drop_table("catalog_refresh")
    op.drop_column("works", "source_meta")
    op.drop_column("works", "cover_url")
    # Retired seed data is intentionally not restored.
