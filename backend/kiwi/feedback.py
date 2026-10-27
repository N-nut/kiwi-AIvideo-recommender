"""Versioned, account-scoped feedback. Writes share the password revocation lock."""
import re
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from .auth import get_current_user, problem
from .database import UserWorkFeedback, Work, as_utc, utc_now

router = APIRouter(prefix="/api/v1/me/feedback", tags=["推荐反馈"])
CurrentUser = Annotated[dict, Depends(get_current_user)]
WorkID = Annotated[str, Path(min_length=1, max_length=80)]
Status = Literal["not_interested", "watched"]


class FeedbackInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    status: Status
    expected_revision: Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")] | None


def public_feedback(row):
    return None if row is None else {"work_id": row.work_id, "status": row.status,
        "revision": row.revision, "updated_at": as_utc(row.updated_at).isoformat()}


def reject_query(request, allowed=()):
    if set(request.query_params) - set(allowed):
        raise problem(422, "unexpected_field", "不接受额外参数")


def feedback_versions(session, user_id):
    return dict(session.execute(select(UserWorkFeedback.work_id, UserWorkFeedback.revision)
        .where(UserWorkFeedback.user_id == user_id)).all())


@router.get("")
def feedback_list(request: Request, user: CurrentUser, status: Status | None = None,
                  page: int = Query(1, ge=1), page_size: int = Query(12, ge=1, le=50)):
    reject_query(request, ("status", "page", "page_size"))
    with request.app.state.sessions() as session:
        base = select(UserWorkFeedback).where(UserWorkFeedback.user_id == user["id"])
        if status:
            base = base.where(UserWorkFeedback.status == status)
        total = session.scalar(select(func.count()).select_from(base.subquery()))
        rows = session.execute(base.add_columns(Work).outerjoin(Work, Work.id == UserWorkFeedback.work_id)
            .order_by(UserWorkFeedback.updated_at.desc(), UserWorkFeedback.work_id.asc())
            .offset((page-1)*page_size).limit(page_size)).all()
        items = []
        for row, work in rows:
            available = work is not None and work.review_status == "approved"
            items.append({**public_feedback(row), "available": available, "work":
                {"id": work.id, "title": work.title, "cover_url": work.cover_url} if available else None})
        return {"request_id": request.state.request_id, "items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/state")
def feedback_state(request: Request, user: CurrentUser):
    reject_query(request)
    cap = request.app.state.settings.feedback_state_limit
    with request.app.state.sessions() as session:
        rows = session.scalars(select(UserWorkFeedback).where(UserWorkFeedback.user_id == user["id"])
            .order_by(UserWorkFeedback.work_id).limit(cap+1)).all()
        return {"request_id": request.state.request_id, "items": [public_feedback(row) for row in rows[:cap]], "complete": len(rows) <= cap}


@router.get("/{work_id}")
def feedback_one(work_id: WorkID, request: Request, user: CurrentUser):
    reject_query(request)
    with request.app.state.sessions() as session:
        return {"request_id": request.state.request_id, "feedback": public_feedback(session.get(UserWorkFeedback, (user["id"], work_id)))}


def limit_write(request, user):
    reject_query(request)
    auth = request.app.state.auth
    auth.limiter.take(("feedback_write", user["id"]), auth.settings.feedback_write_limit, 60)


@router.patch("/{work_id}")
def save_feedback(work_id: WorkID, body: FeedbackInput, request: Request, user: CurrentUser):
    limit_write(request, user)
    with request.app.state.auth.write(request, user["id"]) as (session, _):
        work = session.get(Work, work_id)
        if work is None or work.review_status != "approved":
            raise problem(404, "work_unavailable", "作品不存在或暂不可反馈")
        row = session.get(UserWorkFeedback, (user["id"], work_id))
        if row is None or row.status != body.status:
            if (row.revision if row else None) != body.expected_revision:
                raise problem(409, "feedback_changed", "反馈已发生变化，请重新读取后决定是否修改")
            if row is None:
                row = UserWorkFeedback(user_id=user["id"], work_id=work_id)
                session.add(row)
            row.status, row.revision, row.updated_at = body.status, uuid.uuid4().hex, utc_now()
            session.flush()
        value = public_feedback(row)
    return {"request_id": request.state.request_id, "feedback": value}


@router.delete("/{work_id}", status_code=204)
def remove_feedback(work_id: WorkID, request: Request, user: CurrentUser, if_match: Annotated[str, Header()]):
    limit_write(request, user)
    if not re.fullmatch(r'"[a-f0-9]{32}"', if_match):
        raise problem(422, "invalid_revision", "撤销需要有效的反馈版本")
    with request.app.state.auth.write(request, user["id"]) as (session, _):
        row = session.get(UserWorkFeedback, (user["id"], work_id))
        if row is not None:
            if row.revision != if_match[1:-1]:
                raise problem(412, "precondition_failed", "反馈已发生变化，请重新读取后决定是否撤销")
            session.delete(row)
