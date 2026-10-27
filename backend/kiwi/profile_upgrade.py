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


def upgrade_local_profiles(engine):
    with engine.connect() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            schema = inspect(connection)
            revision = connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar() if schema.has_table("alembic_version") else None
            columns = {c["name"] for c in schema.get_columns("users")} if schema.has_table("users") else set()
            if PROFILE_COLUMNS <= columns:
                if revision not in (None, "0006"):
                    raise RuntimeError("个人资料结构与迁移版本不一致")
                indexes = schema.get_indexes("users")
                if not any(i["name"] == "uq_users_nickname_key" and i["unique"] and i["column_names"] == ["nickname_key"] for i in indexes):
                    raise RuntimeError("个人资料结构不完整，请从备份检查迁移")
                connection.rollback()
                return
            # Refuse unknown or half-applied schemas instead of silently stamping.
            for table_name in schema.get_table_names():
                if table_name == "alembic_version":
                    continue
                table = Base.metadata.tables.get(table_name)
                if table is None:
                    raise RuntimeError("未知 SQLite 结构，拒绝自动建立迁移基线")
                expected = {c.name for c in table.columns} - (PROFILE_COLUMNS if table_name == "users" else set())
                actual = schema.get_columns(table_name)
                if table_name == "works" and revision == "0001" and {c["name"] for c in actual} == expected - {"cover_url", "source_meta"}:
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
                               and item["options"].get("ondelete") == "CASCADE" for item in schema.get_foreign_keys(table_name)):
                        raise RuntimeError("未知 SQLite 外键结构")
                for index in table.indexes:
                    if table_name == "users" and index.name == "uq_users_nickname_key":
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
            if revision not in (None, "0001", "0002", "0003", "0004", "0005"):
                raise RuntimeError("未知 SQLite 迁移版本")
            # BEGIN IMMEDIATE blocks writers; a separate read connection can copy
            # a consistent snapshot without SQLite's same-connection backup deadlock.
            database = engine.url.database
            if database and database != ":memory:":
                target = Path(database).with_name(Path(database).name + f".before-profiles-{uuid.uuid4().hex[:12]}.bak")
                with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) as source, sqlite3.connect(target) as backup:
                    source.backup(backup)
                    if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise RuntimeError("迁移前备份完整性检查失败")
            config = Config(str(ROOT / "backend/alembic.ini"))
            config.attributes["connection"] = connection
            full_legacy = all(schema.has_table(name) and {c["name"] for c in schema.get_columns(name)} ==
                {c.name for c in table.columns} - (PROFILE_COLUMNS if name == "users" else set())
                for name, table in Base.metadata.tables.items())
            if revision and not full_legacy:
                command.upgrade(config, "head")
            else:
                # Known create_all installs have no version row; fill only missing
                # known tables before establishing the verified 0005 baseline.
                # Older mixed installs can retain 0001 despite having the entire
                # verified 0005 schema. Re-baseline only after all checks above.
                Base.metadata.create_all(connection)
                command.stamp(config, "0005")
                command.upgrade(config, "head")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
