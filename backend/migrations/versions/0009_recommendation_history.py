"""Private, server-generated recommendation snapshots."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("recommendation_history",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("query", sa.String(300), nullable=False),
        sa.Column("snapshot", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_history_user_created", "recommendation_history", ["user_id", "created_at", "id"])


def downgrade():
    # Export private snapshots before explicitly requesting this downgrade.
    op.drop_index("ix_history_user_created", table_name="recommendation_history")
    op.drop_table("recommendation_history")
