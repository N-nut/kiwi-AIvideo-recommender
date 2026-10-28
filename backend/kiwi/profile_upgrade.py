"""Bridge recognized create_all SQLite installations to Alembic, with a backup."""
from pathlib import Path
import sqlite3
import uuid

from alembic import command
from alembic.config import Config
from sqlalchemy import CheckConstraint, UniqueConstraint, inspect

from .config import ROOT
from .database import Base

PROFILE_COLUMNS = {"nickname", "nickname_key", "avatar_id"}
REVIEW_TABLES = {"work_review_state", "work_corrections", "work_review_events"}


def upgrade_local_profiles(engine):
    with engine.connect() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            schema = inspect(connection)
            revision = connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar() if schema.has_table("alembic_version") else None
            columns = {c["name"] for c in schema.get_columns("users")} if schema.has_table("users") else set()
            has_profiles = PROFILE_COLUMNS <= columns
            if columns & PROFILE_COLUMNS and not has_profiles:
                raise RuntimeError("未知或部分升级的个人资料结构")
            if revision not in (None, "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010"):
                raise RuntimeError("未知 SQLite 迁移版本")
            present = set(schema.get_table_names()) - {"alembic_version"}
            known = [{"works"}]
            for added in ({"catalog_refresh"}, {"users", "user_sessions", "favorites"}, {"work_previews"}, {"preview_jobs"}):
                known.append(known[-1] | added)
            feedback_tables = known[-1] | {"user_work_feedback"}
            if present and present not in known and present not in (feedback_tables, feedback_tables | {"user_avatars"}, feedback_tables | {"user_avatars", "recommendation_history"}, feedback_tables | {"user_avatars", "recommendation_history"} | REVIEW_TABLES):
                raise RuntimeError("未知或部分升级的 SQLite 表结构")
            if revision is not None and (not present or int(revision) >= 6 and not has_profiles):
                raise RuntimeError("未知或部分升级的 SQLite 迁移结构")
            stage = 10 if REVIEW_TABLES <= present else 9 if "recommendation_history" in present else 8 if "user_avatars" in present else 7 if "user_work_feedback" in present else 6 if has_profiles else known.index(present)+1 if present else 0
            if revision is not None and int(revision) > stage:
                raise RuntimeError("SQLite 结构落后于迁移版本，拒绝自动盖章")
            if has_profiles and revision not in (None, "0006", "0007", "0008", "0009", "0010"):
                raise RuntimeError("个人资料结构与迁移版本不一致")
            if schema.has_table("user_work_feedback") != (revision in ("0007", "0008", "0009", "0010")):
                raise RuntimeError("反馈结构与迁移版本不一致，请从备份检查迁移")
            if schema.has_table("user_avatars") != (revision in ("0008", "0009", "0010")):
                raise RuntimeError("照片头像结构与迁移版本不一致，请从备份检查迁移")
            if schema.has_table("recommendation_history") != (revision in ("0009", "0010")):
                raise RuntimeError("历史片单结构与迁移版本不一致，请从备份检查迁移")
            if (bool(present & REVIEW_TABLES) or "is_reviewer" in columns) != (revision == "0010"):
                raise RuntimeError("纠错审核结构与迁移版本不一致")
            if has_profiles and not all(schema.has_table(name) for name in Base.metadata.tables if name not in {"user_work_feedback", "user_avatars", "recommendation_history"} | REVIEW_TABLES):
                raise RuntimeError("未知或不完整的 SQLite 0006 结构")
            # Refuse unknown or half-applied schemas instead of silently stamping.
            for table_name in schema.get_table_names():
                if table_name == "alembic_version":
                    continue
                table = Base.metadata.tables.get(table_name)
                if table is None:
                    raise RuntimeError("未知 SQLite 结构，拒绝自动建立迁移基线")
                expected = {c.name for c in table.columns} - (PROFILE_COLUMNS if table_name == "users" and not has_profiles else set())
                if table_name == "users" and revision != "0010":
                    expected -= {"is_reviewer"}
                actual = schema.get_columns(table_name)
                if table_name == "works" and present == {"works"} and revision in (None, "0001") and {c["name"] for c in actual} == expected - {"cover_url", "source_meta"}:
                    expected -= {"cover_url", "source_meta"}
                if {c["name"] for c in actual} != expected:
                    raise RuntimeError("未知 SQLite 列结构，拒绝自动建立迁移基线")
                for col in actual:
                    model = table.c[col["name"]]
                    if col["type"]._type_affinity != model.type.dialect_impl(connection.dialect)._type_affinity:
                        raise RuntimeError("未知 SQLite 字段类型，拒绝自动迁移")
                    if col["nullable"] != model.nullable:
                        raise RuntimeError("未知 SQLite 字段约束，拒绝自动迁移")
                if schema.get_pk_constraint(table_name)["constrained_columns"] != [c.name for c in table.primary_key]:
                    raise RuntimeError("未知 SQLite 主键结构")
                for fk in table.foreign_key_constraints:
                    if not any(item["constrained_columns"] == list(fk.column_keys) and item["referred_table"] == fk.referred_table.name
                               and item["options"].get("ondelete") == fk.ondelete for item in schema.get_foreign_keys(table_name)):
                        raise RuntimeError("未知 SQLite 外键结构")
                for index in table.indexes:
                    if table_name == "users" and index.name == "uq_users_nickname_key" and not has_profiles:
                        continue
                    if not any(item["name"] == index.name and item["column_names"] == [c.name for c in index.columns]
                               and bool(item["unique"]) == bool(index.unique) for item in schema.get_indexes(table_name)):
                        raise RuntimeError("未知 SQLite 索引结构")
                for constraint in table.constraints:
                    if isinstance(constraint, UniqueConstraint):
                        if not any(item["column_names"] == [c.name for c in constraint.columns] for item in schema.get_unique_constraints(table_name)):
                            raise RuntimeError("未知 SQLite 唯一约束")
                    elif isinstance(constraint, CheckConstraint):
                        normalize = lambda value: "".join(value.split())
                        if not any(item["name"] == constraint.name and normalize(item["sqltext"]) == normalize(str(constraint.sqltext))
                                   for item in schema.get_check_constraints(table_name)):
                            raise RuntimeError("未知 SQLite 检查约束")
            if schema.has_table("users"):
                uniques = schema.get_unique_constraints("users") + schema.get_indexes("users")
                if not any(i["column_names"] == ["username_key"] and i.get("unique", True) for i in uniques):
                    raise RuntimeError("旧账号结构缺少用户名唯一约束")
            if revision == "0010":
                if connection.exec_driver_sql("PRAGMA foreign_key_check").first():
                    raise RuntimeError("SQLite 外键完整性检查失败")
                if connection.exec_driver_sql("SELECT works.id FROM works LEFT JOIN work_review_state ON works.id=work_review_state.work_id WHERE work_review_state.work_id IS NULL LIMIT 1").first():
                    raise RuntimeError("已有作品缺少审核状态，请检查 0010 升级")
                connection.rollback()
                return
            # BEGIN IMMEDIATE blocks writers; a separate read connection can copy
            # a consistent snapshot without SQLite's same-connection backup deadlock.
            database = engine.url.database
            if database and database != ":memory:" and schema.get_table_names():
                target = Path(database).with_name(Path(database).name + f".before-profiles-{uuid.uuid4().hex[:12]}.bak")
                with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) as source, sqlite3.connect(target) as backup:
                    source.backup(backup)
                    if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise RuntimeError("迁移前备份完整性检查失败")
            config = Config(str(ROOT / "backend/alembic.ini"))
            config.attributes["connection"] = connection
            if not schema.get_table_names() or schema.get_table_names() == ["alembic_version"]:
                command.upgrade(config, "head")
            elif has_profiles:
                if revision is None:
                    command.stamp(config, "0006")
                command.upgrade(config, "head")
            else:
                # Known create_all installs have no version row; fill only missing
                # known tables before establishing the verified 0005 baseline.
                # Older mixed installs can retain 0001 despite having the entire
                # verified 0005 schema. Re-baseline only after all checks above.
                if schema.has_table("works"):
                    actual = {c["name"] for c in schema.get_columns("works")}
                    for name, kind in (("cover_url", "TEXT"), ("source_meta", "JSON")):
                        if name not in actual:
                            connection.exec_driver_sql(f"ALTER TABLE works ADD COLUMN {name} {kind}")
                # New tables may be filled from metadata, but feedback is always
                # created by 0007 and existing users receive 0006 via Alembic.
                had_users = schema.has_table("users")
                Base.metadata.create_all(connection, tables=[table for name, table in Base.metadata.tables.items() if name not in {"user_work_feedback", "user_avatars", "recommendation_history"} | REVIEW_TABLES])
                if not had_users:
                    connection.exec_driver_sql("ALTER TABLE users DROP COLUMN is_reviewer")
                command.stamp(config, "0005" if had_users else "0006")
                command.upgrade(config, "head")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
