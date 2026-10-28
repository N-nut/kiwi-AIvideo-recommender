"""Source snapshots, private corrections and append-only review receipts."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None
J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade():
    op.add_column("users", sa.Column("is_reviewer", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table("work_review_state",
        sa.Column("work_id", sa.String(80), sa.ForeignKey("works.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("source_snapshot", J, nullable=False),
        sa.Column("confirmed_fields", J, nullable=False),
        sa.Column("recheck_fields", J, nullable=False),
        sa.Column("manual_hold", sa.Boolean(), nullable=False),
        sa.Column("hold_reason", sa.Text(), nullable=True),
        sa.Column("media_hold", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision >= 1 AND revision <= 2147483647", name="ck_review_revision"))
    op.create_table("work_corrections",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("work_id", sa.String(80), sa.ForeignKey("works.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("submitter_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("operation_id", sa.String(32), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("active_key", sa.String(64), nullable=True),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("category", sa.String(24), nullable=False),
        sa.Column("field", sa.String(24), nullable=False),
        sa.Column("base_revision", sa.Integer(), nullable=False),
        sa.Column("base_snapshot", J, nullable=False),
        sa.Column("suggestion", J, nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("source_hint", J, nullable=True),
        sa.Column("related_correction_id", sa.String(32), sa.ForeignKey("work_corrections.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("revision", sa.String(32), nullable=False),
        sa.Column("decision", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('pending','accepted','rejected','needs_recheck')", name="ck_correction_status"),
        sa.CheckConstraint("origin IN ('user','reviewer')", name="ck_correction_origin"),
        sa.UniqueConstraint("submitter_id", "operation_id", name="uq_correction_operation"),
        sa.UniqueConstraint("submitter_id", "active_key", name="uq_correction_active"))
    op.create_index("ix_correction_owner_time", "work_corrections", ["submitter_id", "created_at", "id"])
    op.create_index("ix_correction_status_time", "work_corrections", ["status", "created_at", "id"])
    op.create_index("ix_correction_work_field", "work_corrections", ["work_id", "field"])
    op.create_table("work_review_events",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("actor_key", sa.String(120), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("work_id", sa.String(80), sa.ForeignKey("works.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("operation_id", sa.String(32), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("payload", J, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("actor_key", "operation_id", name="uq_review_event_operation"),
        sa.CheckConstraint("(kind = 'permission' AND work_id IS NULL) OR (kind != 'permission' AND work_id IS NOT NULL)", name="ck_review_event_work"))
    op.create_index("ix_review_event_work_time", "work_review_events", ["work_id", "created_at", "id"])
    # No new collection or human confirmation is inferred from old records.
    connection = op.get_bind()
    fields = ("id", "title", "original_intro", "summary", "genres", "themes", "pace", "harem", "romance", "tragic", "source_url", "cover_url", "source_meta", "collected_at", "evidence", "review_status", "review_note")
    works = sa.table("works", *(sa.column(k, J if k in {"genres", "themes", "source_meta", "evidence"} else sa.Boolean() if k in {"harem", "romance", "tragic"} else sa.String()) for k in fields))
    target = sa.table("work_review_state", sa.column("work_id"), sa.column("revision"), sa.column("source_snapshot", J), sa.column("confirmed_fields", J), sa.column("recheck_fields", J), sa.column("manual_hold", sa.Boolean()), sa.column("media_hold", sa.Boolean()), sa.column("updated_at", sa.DateTime(timezone=True)))
    from datetime import datetime, timezone
    for row in connection.execute(sa.select(works)).mappings():
        connection.execute(target.insert().values(work_id=row["id"], revision=1,
            source_snapshot={"kind":"legacy_snapshot", "data":dict(row)}, confirmed_fields={}, recheck_fields=[],
            manual_hold=False, media_hold=False, updated_at=datetime.now(timezone.utc)))


def downgrade():
    # Explicitly export and back up audit records before this destructive downgrade.
    op.drop_table("work_review_events")
    op.drop_table("work_corrections")
    op.drop_table("work_review_state")
    op.drop_column("users", "is_reviewer")
