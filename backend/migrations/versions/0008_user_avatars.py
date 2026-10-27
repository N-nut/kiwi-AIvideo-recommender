"""One re-encoded profile photo per account, covered by database backups."""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("user_avatars",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("asset_id", sa.String(32), nullable=False, unique=True),
        sa.Column("image", sa.LargeBinary(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False))


def downgrade():
    # Export profile photos before requesting this destructive downgrade.
    op.drop_table("user_avatars")
