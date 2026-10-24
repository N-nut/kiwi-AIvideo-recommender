"""Favorites always derive ownership from the current database session."""
from typing import Annotated
from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .auth import get_current_user, problem
from .database import Favorite, Work, public_work, utc_now

router = APIRouter(prefix="/api/v1/me/favorites", tags=["收藏"])
CurrentUser = Annotated[dict, Depends(get_current_user)]
WorkID = Annotated[str, Path(min_length=1, max_length=80)]


class ImportInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    work_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(min_length=1, max_length=100)


def save_ids(session, user_id, ids):
    if not ids:
        return 0
    insert = pg_insert if session.bind.dialect.name == "postgresql" else sqlite_insert
    statement = insert(Favorite).values([{"user_id": user_id, "work_id": id, "created_at": utc_now()} for id in ids])
    return len(session.scalars(statement.on_conflict_do_nothing(index_elements=["user_id", "work_id"]).returning(Favorite.work_id)).all())


@router.get("")
def favorites(request: Request, user: CurrentUser, page: int = Query(1, ge=1), page_size: int = Query(12, ge=1, le=50)):
    with request.app.state.sessions() as session:
        base = select(Favorite).where(Favorite.user_id == user["id"])
        relations = session.scalar(select(func.count()).select_from(base.subquery()))
        visible = base.join(Work, Work.id == Favorite.work_id).where(Work.review_status == "approved")
        total = session.scalar(select(func.count()).select_from(visible.subquery()))
        unavailable = session.scalars(base.join(Work, Work.id == Favorite.work_id).where(Work.review_status != "approved")
            .with_only_columns(Favorite.work_id).order_by(Favorite.created_at.desc(), Favorite.work_id.asc()).limit(50)).all()
        rows = session.scalars(visible.with_only_columns(Work).order_by(Favorite.created_at.desc(), Favorite.work_id.asc()).offset((page-1)*page_size).limit(page_size))
        return {"items": [public_work(w) for w in rows], "total": total, "unavailable_count": relations-total,
                "unavailable_ids": unavailable, "page": page, "page_size": page_size}


@router.get("/ids")
def favorite_ids(request: Request, user: CurrentUser, page: int = Query(1, ge=1), page_size: int = Query(200, ge=1, le=200)):
    with request.app.state.sessions() as session:
        base = select(Favorite).where(Favorite.user_id == user["id"])
        total = session.scalar(select(func.count()).select_from(base.subquery()))
        ids = session.scalars(base.with_only_columns(Favorite.work_id).order_by(Favorite.created_at.desc(), Favorite.work_id.asc()).offset((page-1)*page_size).limit(page_size)).all()
        return {"items": ids, "relation_total": total, "page": page, "page_size": page_size}


@router.post("/import")
def import_favorites(body: ImportInput, request: Request, user: CurrentUser):
    ids = list(dict.fromkeys(body.work_ids))
    with request.app.state.sessions.begin() as session:
        available = session.scalars(select(Work.id).where(Work.id.in_(ids), Work.review_status == "approved")).all()
        added = save_ids(session, user["id"], available)
    return {"requested": len(body.work_ids), "unique": len(ids), "added": added,
            "already_saved": len(available)-added, "skipped_unavailable": len(ids)-len(available)}


@router.put("/{work_id}")
def save_favorite(work_id: WorkID, request: Request, user: CurrentUser):
    with request.app.state.sessions.begin() as session:
        work = session.get(Work, work_id)
        if work is None or work.review_status != "approved":
            raise problem(404, "work_unavailable", "作品不存在或暂不可收藏")
        save_ids(session, user["id"], [work_id])
    return {"saved": True}


@router.delete("/{work_id}", status_code=204)
def remove_favorite(work_id: WorkID, request: Request, user: CurrentUser):
    with request.app.state.sessions.begin() as session:
        session.execute(delete(Favorite).where(Favorite.user_id == user["id"], Favorite.work_id == work_id))
