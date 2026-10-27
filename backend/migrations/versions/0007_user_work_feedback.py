"""Current per-account work feedback, independent of favorites."""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("user_work_feedback",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("work_id", sa.String(80), sa.ForeignKey("works.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("revision", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('not_interested', 'watched')", name="ck_feedback_status"),
    )
    op.create_index("ix_feedback_user_status_updated_work", "user_work_feedback", ["user_id", "status", "updated_at", "work_id"])


def downgrade():
    # Export feedback before requesting this destructive downgrade.
    op.drop_table("user_work_feedback")
