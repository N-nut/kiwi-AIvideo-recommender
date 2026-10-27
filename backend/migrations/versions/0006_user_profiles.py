"""Nullable unique nicknames and bundled preset avatars; no users-table rebuild."""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("nickname", sa.Unicode(20), nullable=True))
    op.add_column("users", sa.Column("nickname_key", sa.Text().with_variant(sa.Text(collation="C"), "postgresql"), nullable=True))
    op.add_column("users", sa.Column("avatar_id", sa.String(32), nullable=False, server_default="kiwi-default"))
    op.create_index("uq_users_nickname_key", "users", ["nickname_key"], unique=True)


def downgrade():
    # Back up profile values before explicitly requesting this destructive downgrade.
    op.drop_index("uq_users_nickname_key", table_name="users")
    for name in ("avatar_id", "nickname_key", "nickname"):
        op.drop_column("users", name)
