"""Persistent work preview preparation queue."""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("preview_jobs",
        sa.Column("work_id", sa.String(80), sa.ForeignKey("works.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("source_key", sa.String(64), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.String(64)), sa.Column("retry_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('pending','running','ready','unavailable')", name="ck_preview_job_status"))
    op.create_index("ix_preview_jobs_status", "preview_jobs", ["status"])


def downgrade():
    op.drop_table("preview_jobs")
