"""Current, verified work preview metadata. Files are retained on downgrade."""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("work_previews",
        sa.Column("work_id", sa.String(80), sa.ForeignKey("works.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("asset_id", sa.String(32), unique=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("clip_kind", sa.String(16), nullable=False),
        sa.Column("video_path", sa.Text()), sa.Column("poster_path", sa.Text()),
        sa.Column("duration_ms", sa.Integer()), sa.Column("width", sa.Integer()), sa.Column("height", sa.Integer()),
        sa.Column("size_bytes", sa.Integer()),
        sa.Column("source_page_url", sa.Text(), nullable=False), sa.Column("usage_basis", sa.Text(), nullable=False),
        sa.Column("source_hash", sa.String(64)), sa.Column("processing_hash", sa.String(64)), sa.Column("video_sha256", sa.String(64)),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('pending', 'ready', 'unavailable')", name="ck_preview_status"),
        sa.CheckConstraint("clip_kind IN ('trailer', 'excerpt')", name="ck_preview_kind"),
        sa.CheckConstraint("status != 'ready' OR (asset_id IS NOT NULL AND video_path IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms > 0 AND width IS NOT NULL AND width > 0 AND height IS NOT NULL AND height > 0 AND size_bytes IS NOT NULL AND size_bytes > 0 AND checked_at IS NOT NULL AND length(trim(usage_basis)) > 0 AND source_hash IS NOT NULL AND processing_hash IS NOT NULL AND video_sha256 IS NOT NULL)", name="ck_preview_ready"))


def downgrade():
    op.drop_table("work_previews")
