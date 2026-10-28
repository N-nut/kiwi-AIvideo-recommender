"""History accepts only snapshots produced by the recommendation service."""
import copy
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from sqlalchemy import delete, func, select

from .auth import get_current_user, problem
from .database import RecommendationHistory, Work, as_utc, public_work, utc_now
from .feedback import reject_query

router = APIRouter(prefix="/api/v1/me/history", tags=["历史片单"])
CurrentUser = Annotated[dict, Depends(get_current_user)]
HistoryID = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
HISTORY_LIMIT = 100


def save_history(request, user, body, result):
    if result["status"] != "success" or not result["items"]:
        return None
    snapshot = copy.deepcopy({key: result[key] for key in ("preferences", "items", "warnings", "mode")})
    with request.app.state.auth.write(request, user["id"]) as (session, _):
        # Capture the exact catalog version from the already validated result.
        # If a catalog write raced that validation, don't save inconsistent data.
        works = {w.id: w for w in session.scalars(select(Work).where(Work.id.in_([w["id"] for w in snapshot["items"]])))}
        for item in snapshot["items"]:
            work = works.get(item["id"])
            if work is None or work.review_status != "approved" or any(item[key] != value for key, value in public_work(work).items()):
                raise problem(409, "catalog_changed", "作品资料已变化，请重新生成；上次片单已保留")
            item["catalog_hash"] = work.content_hash
            item["catalog_revision"] = work.review_state.revision
        row = RecommendationHistory(id=uuid.uuid4().hex, user_id=user["id"], query=body.query.strip(),
                                    snapshot=snapshot, created_at=utc_now())
        session.add(row)
        session.flush()
        older = select(RecommendationHistory.id).where(RecommendationHistory.user_id == user["id"])
        older = older.order_by(RecommendationHistory.created_at.desc(), RecommendationHistory.id.desc()).offset(HISTORY_LIMIT)
        ids = list(session.scalars(older))
        if ids:
            session.execute(delete(RecommendationHistory).where(RecommendationHistory.user_id == user["id"], RecommendationHistory.id.in_(ids)))
        return {"status": "saved", "id": row.id}


def summary(row):
    return {"id": row.id, "query": row.query, "created_at": as_utc(row.created_at).isoformat(),
            "count": len(row.snapshot["items"]), "mode": row.snapshot["mode"],
            "preferences": row.snapshot["preferences"],
            "titles": [item["title"] for item in row.snapshot["items"]]}


@router.get("")
def history_list(request: Request, user: CurrentUser, page: int = Query(1, ge=1), page_size: int = Query(12, ge=1, le=50)):
    reject_query(request, ("page", "page_size"))
    with request.app.state.sessions() as session:
        base = select(RecommendationHistory).where(RecommendationHistory.user_id == user["id"])
        total = session.scalar(select(func.count()).select_from(base.subquery()))
        rows = session.scalars(base.order_by(RecommendationHistory.created_at.desc(), RecommendationHistory.id.desc())
                              .offset((page-1)*page_size).limit(page_size))
        return {"request_id": request.state.request_id, "items": [summary(row) for row in rows],
                "total": total, "page": page, "page_size": page_size, "retention_limit": HISTORY_LIMIT}


def owned(session, user, history_id):
    row = session.scalar(select(RecommendationHistory).where(RecommendationHistory.id == history_id, RecommendationHistory.user_id == user["id"]))
    if row is None:
        raise problem(404, "history_unavailable", "片单不存在或已删除")
    return row


@router.get("/{history_id}")
def history_detail(history_id: HistoryID, request: Request, user: CurrentUser):
    reject_query(request)
    with request.app.state.sessions() as session:
        row = owned(session, user, history_id)
        stored = row.snapshot["items"]
        works = {w.id: w for w in session.scalars(select(Work).where(Work.id.in_([item["id"] for item in stored])))}
        items = []
        for item in stored:
            work = works.get(item["id"])
            available = work is not None and work.review_status == "approved"
            items.append({"id": item["id"], "title": item["title"], "available": available,
                "changed": available and (work.content_hash != item["catalog_hash"] or item.get("catalog_revision", work.review_state.revision) != work.review_state.revision),
                "work": {key: value for key, value in item.items() if key not in {"catalog_hash", "catalog_revision"}} if available else None})
        return {"request_id": request.state.request_id, "history": {**summary(row), "warnings": row.snapshot["warnings"], "items": items}}


@router.delete("/{history_id}", status_code=204)
def remove_history(history_id: HistoryID, request: Request, user: CurrentUser):
    reject_query(request)
    with request.app.state.auth.write(request, user["id"]) as (session, _):
        session.delete(owned(session, user, history_id))
