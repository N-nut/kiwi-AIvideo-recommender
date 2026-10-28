"""Session-owned reports and durable, alias-safe submission receipts."""
import copy
import uuid
from contextlib import contextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from sqlalchemy import func, select, text, update

from .auth import get_current_user, problem
from .database import User, Work, WorkCorrection, WorkReviewEvent, WorkReviewState, as_utc, public_work, utc_now
from .feedback import reject_query
from .review_models import Category, OperationID, Status, Submission
from .reviewing import digest, field_value, revision, work_data

router = APIRouter(prefix="/api/v1/me", tags=["资料纠错"])
CurrentUser = Annotated[dict, Depends(get_current_user)]
ReportID = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
WorkPath = Annotated[str, Path(pattern=r"^[a-z0-9_-]{1,80}$")]


def require_reviewer(session, user_id):
    user = session.get(User, user_id)
    if user is None or not user.is_reviewer:
        raise problem(403, "review_forbidden", "此账号没有资料审核权限")


def review_conflict(state):
    error = problem(409, "review_conflict", "资料已更新，请重新核对")
    error.detail["current_revision"] = state.revision
    return error


def lock_work(session, work_id):
    state = session.scalar(select(WorkReviewState).where(WorkReviewState.work_id == work_id).with_for_update().execution_options(populate_existing=True))
    work = session.scalar(select(Work).where(Work.id == work_id).with_for_update().execution_options(populate_existing=True))
    if work is None:
        raise problem(404, "work_unavailable", "作品不存在或不可用")
    if state is None:
        raise problem(503, "review_schema_unavailable", "审核状态尚未就绪")
    return work, state


@contextmanager
def catalog_write(sessions):
    with sessions() as session:
        if session.bind.dialect.name == "sqlite":
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        else:
            session.execute(text("SET LOCAL lock_timeout = '3s'"))
        try:
            yield session
            session.commit()
        except BaseException:
            session.rollback()
            raise


def bump(session, state, **values):
    before = state.revision
    if before >= 2_147_483_647:
        raise problem(503, "review_revision_exhausted", "资料版本暂时无法更新")
    result = session.execute(update(WorkReviewState).where(WorkReviewState.work_id == state.work_id,
        WorkReviewState.revision == before).values(revision=before+1, updated_at=utc_now(), **values),
        execution_options={"synchronize_session": False})
    if result.rowcount != 1:
        raise problem(409, "review_conflict", "资料已更新，请重新核对")
    session.refresh(state)


def invalidate_reports(session, work_id, except_id=None):
    rows = session.scalars(select(WorkCorrection).where(WorkCorrection.work_id == work_id,
        WorkCorrection.status == "pending").order_by(WorkCorrection.id).with_for_update())
    for row in rows:
        if row.id != except_id:
            row.status, row.revision, row.updated_at = "needs_recheck", uuid.uuid4().hex, utc_now()
            row.decision = "作品资料或来源已更新，请重新核对"


def event_for(session, actor, operation_id, request_hash=None, kind=None):
    event = session.scalar(select(WorkReviewEvent).where(WorkReviewEvent.actor_key == actor,
        WorkReviewEvent.operation_id == operation_id))
    if event is not None and (request_hash is not None and event.request_hash != request_hash or kind is not None and event.kind != kind):
        raise problem(409, "idempotency_mismatch", "同一操作标识对应不同内容，请核对原操作")
    return event


def add_event(session, actor, operation_id, request_hash, kind, work_id, payload):
    event = WorkReviewEvent(id=uuid.uuid4().hex, actor_key=actor, actor_id=actor if kind != "permission" else None,
        operation_id=operation_id, request_hash=request_hash, kind=kind, work_id=work_id,
        payload=copy.deepcopy(payload), created_at=utc_now())
    session.add(event)
    return event


def report_data(row, work):
    return {"id": row.id, "work_id": row.work_id, "work_title": work.title, "origin": row.origin,
        "category": row.category, "field": row.field, "status": row.status, "revision": row.revision,
        "base_revision": row.base_revision, "current_value": field_value(row.base_snapshot, row.field),
        "suggestion": row.suggestion, "description": row.description, "source_hint": row.source_hint,
        "related_correction_id": row.related_correction_id, "decision": row.decision,
        "created_at": as_utc(row.created_at).isoformat(), "updated_at": as_utc(row.updated_at).isoformat()}


def owned(session, user_id, report_id, reviewer=False):
    row = session.get(WorkCorrection, report_id)
    if row is None or not reviewer and row.submitter_id != user_id:
        raise problem(404, "correction_unavailable", "纠错记录不存在或不可见")
    return row


def submit_response(session, event, replayed=False):
    row = session.get(WorkCorrection, event.payload["report_id"])
    work = session.get(Work, row.work_id)
    return {"correction": report_data(row, work), "work_revision": revision(work),
        "deduplicated": replayed or event.payload["deduplicated"], "operation_id": event.operation_id}


def submit(body, request, user, response, reviewer=False):
    reject_query(request)
    auth = request.app.state.auth
    body_data = body.model_dump(mode="json")
    request_hash = digest({"origin": "reviewer" if reviewer else "user", **body_data})
    # Hashes are server-derived; a new key for an identical active report still
    # receives its own durable receipt pointing to the existing report.
    active = digest({k:v for k,v in body_data.items() if k not in {"operation_id", "base_revision"}})
    with auth.write(request, user["id"]) as (session, _):
        if reviewer:
            require_reviewer(session, user["id"])
        previous = event_for(session, user["id"], body.operation_id, request_hash, "submit")
        if previous:
            response.status_code = 200
            return submit_response(session, previous, True)
        work, state = lock_work(session, body.work_id)
        if not reviewer and (work.review_status != "approved" or state.manual_hold):
            raise problem(404, "work_unavailable", "作品不存在或不可用")
        if state.revision != body.base_revision:
            raise review_conflict(state)
        if body.related_correction_id:
            related = owned(session, user["id"], body.related_correction_id, reviewer)
            if related.work_id != body.work_id:
                raise problem(422, "invalid_related_report", "关联纠错须属于同一作品")
        row = session.scalar(select(WorkCorrection).where(WorkCorrection.submitter_id == user["id"], WorkCorrection.active_key == active))
        duplicate = row is not None
        if not duplicate:
            ip = request.client.host if request.client else "unknown"
            auth.limiter.take(("correction_user", user["id"]), 10, 60)
            auth.limiter.take(("correction_ip", ip), 30, 60)
            count = session.scalar(select(func.count()).select_from(WorkCorrection).where(
                WorkCorrection.submitter_id == user["id"], WorkCorrection.status.in_(["pending", "needs_recheck"])))
            if count >= 20:
                raise problem(429, "correction_capacity", "最多同时保留 20 条未处理纠错，请等待审核", headers={"Retry-After":"60"})
            now = utc_now()
            row = WorkCorrection(id=uuid.uuid4().hex, work_id=body.work_id, submitter_id=user["id"],
                operation_id=body.operation_id, request_hash=request_hash, active_key=active,
                origin="reviewer" if reviewer else "user", category=body.category, field=body.field,
                base_revision=state.revision, base_snapshot=work_data(work), suggestion=body.suggestion.model_dump(),
                description=body.description, source_hint=body.source_hint.model_dump() if body.source_hint else None,
                related_correction_id=body.related_correction_id, status="pending", revision=uuid.uuid4().hex,
                created_at=now, updated_at=now)
            session.add(row)
            session.flush()
        event = add_event(session, user["id"], body.operation_id, request_hash, "submit", body.work_id,
            {"report_id":row.id, "deduplicated":duplicate})
        response.status_code = 200 if duplicate else 201
        return submit_response(session, event)


@router.post("/corrections", status_code=201)
def create_correction(body: Submission, request: Request, response: Response, user: CurrentUser):
    return {"request_id":request.state.request_id, **submit(body, request, user, response)}


@router.get("/corrections")
def my_corrections(request: Request, user: CurrentUser, page: int = Query(1, ge=1),
                   page_size: int = Query(12, ge=1, le=50), status: Status | None = None):
    reject_query(request, ("page", "page_size", "status"))
    with request.app.state.sessions() as session:
        query = select(WorkCorrection).where(WorkCorrection.submitter_id == user["id"])
        if status:
            query = query.where(WorkCorrection.status == status)
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        rows = session.scalars(query.order_by(WorkCorrection.created_at.desc(), WorkCorrection.id.desc()).offset((page-1)*page_size).limit(page_size)).all()
        works = {w.id:w for w in session.scalars(select(Work).where(Work.id.in_([r.work_id for r in rows])))}
        return {"request_id":request.state.request_id, "items":[report_data(r, works[r.work_id]) for r in rows], "total":total, "page":page, "page_size":page_size}


@router.get("/corrections/operations/{operation_id}")
def submission_receipt(operation_id: ReportID, request: Request, user: CurrentUser):
    reject_query(request)
    with request.app.state.sessions() as session:
        event = event_for(session, user["id"], operation_id)
        if event is None or event.kind != "submit":
            raise problem(404, "operation_unknown", "尚未查到提交回执，请核对本人记录；在途操作仍可能完成")
        return {"request_id":request.state.request_id, **submit_response(session, event, True)}


@router.get("/corrections/{report_id}")
def my_correction(report_id: ReportID, request: Request, user: CurrentUser):
    reject_query(request)
    with request.app.state.sessions() as session:
        row = owned(session, user["id"], report_id)
        return {"request_id":request.state.request_id, "correction": report_data(row, session.get(Work, row.work_id))}


@router.get("/review-access")
def review_access(request: Request, user: CurrentUser):
    reject_query(request)
    with request.app.state.sessions() as session:
        return {"can_review":bool(session.get(User, user["id"]).is_reviewer)}
