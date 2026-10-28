"""Prepare outside locks; authorize, compare and publish in one short transaction."""
import asyncio
import copy
import math
import uuid
from contextlib import contextmanager
from threading import Lock

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from .auth import AuthManager, problem
from .corrections import (CurrentUser, ReportID, WorkPath, add_event, bump, event_for,
    invalidate_reports, lock_work, owned, report_data, require_reviewer, review_conflict, submit)
from .database import PreviewJob, User, Work, WorkCorrection, WorkPreview, WorkReviewEvent, utc_now, public_work
from .feedback import reject_query
from .importer import content_hash, search_text
from .providers import ProviderError
from .review_models import Availability, Category, ReviewAction, Status, Submission
from .reviewing import candidate, digest, public_review, revision, validate_effective, work_data

router = APIRouter(prefix="/api/v1/me/review", tags=["资料审核"])


class Inflight:
    def __init__(self):
        self.keys, self.lock = set(), Lock()

    @contextmanager
    def enter(self, key):
        with self.lock:
            if key in self.keys:
                raise problem(409, "operation_in_progress", "操作正在准备，请稍后核对回执")
            if len(self.keys) >= 1000:
                raise problem(429, "review_busy", "审核服务繁忙，请稍后重试", headers={"Retry-After":"2"})
            self.keys.add(key)
        try:
            yield
        finally:
            with self.lock:
                self.keys.discard(key)


def audit(session, work_id):
    rows = session.scalars(select(WorkReviewEvent).where(WorkReviewEvent.work_id == work_id,
        WorkReviewEvent.kind != "submit").order_by(WorkReviewEvent.created_at.desc(), WorkReviewEvent.id.desc()).limit(100))
    return [{"id":r.id, "kind":r.kind, "actor_id":r.actor_id, "created_at":r.created_at.isoformat(), **r.payload} for r in rows]


def work_detail(session, work):
    state = work.review_state
    return {"work":public_work(work), "source_snapshot":state.source_snapshot,
        "confirmed_fields":state.confirmed_fields, "recheck_fields":state.recheck_fields,
        "manual_hold":state.manual_hold, "hold_reason":state.hold_reason, "media_hold":state.media_hold,
        "updated_at":state.updated_at.isoformat(), "events":audit(session, work.id)}


def reviewer_read(request, user):
    session = request.app.state.sessions()
    try:
        require_reviewer(session, user["id"])
        return session
    except BaseException:
        session.close()
        raise


@router.get("/corrections")
def queue(request: Request, user: CurrentUser, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=50),
          status: Status | None = "pending", category: Category | None = None, q: str = Query("", max_length=100)):
    reject_query(request, ("page", "page_size", "status", "category", "q"))
    with reviewer_read(request, user) as session:
        query = select(WorkCorrection).join(Work, Work.id == WorkCorrection.work_id)
        if status:
            query = query.where(WorkCorrection.status == status)
        if category:
            query = query.where(WorkCorrection.category == category)
        if q.strip():
            query = query.where(Work.title.icontains(q.strip(), autoescape=True))
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        rows = session.scalars(query.order_by(WorkCorrection.created_at, WorkCorrection.id).offset((page-1)*page_size).limit(page_size)).all()
        works = {w.id:w for w in session.scalars(select(Work).where(Work.id.in_([r.work_id for r in rows])))}
        return {"request_id":request.state.request_id, "items":[report_data(r, works[r.work_id]) for r in rows], "total":total, "page":page, "page_size":page_size}


@router.get("/works")
def works(request: Request, user: CurrentUser, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=50),
          review_state: str = Query("automatic", pattern=r"^(automatic|partial|recheck|unavailable|all)$"), q: str = Query("", max_length=100)):
    reject_query(request, ("page", "page_size", "review_state", "q"))
    with reviewer_read(request, user) as session:
        query = select(Work).order_by(Work.id)
        if q.strip():
            query = query.where(Work.title.icontains(q.strip(), autoescape=True))
        # Existing catalogue is bounded; projection keeps SQLite/JSONB semantics identical.
        rows = [w for w in session.scalars(query) if review_state == "all" or public_review(w)["state"] == review_state]
        return {"request_id":request.state.request_id, "items":[public_work(w) for w in rows[(page-1)*page_size:page*page_size]], "total":len(rows), "page":page, "page_size":page_size}


@router.get("/works/{work_id}")
def review_work(work_id: WorkPath, request: Request, user: CurrentUser):
    reject_query(request)
    with reviewer_read(request, user) as session:
        work = session.get(Work, work_id)
        if work is None:
            raise problem(404, "work_unavailable", "作品不存在")
        return {"request_id":request.state.request_id, **work_detail(session, work)}


@router.get("/corrections/{report_id}")
def detail(report_id: ReportID, request: Request, user: CurrentUser):
    reject_query(request)
    with reviewer_read(request, user) as session:
        row = owned(session, user["id"], report_id, True)
        work = session.get(Work, row.work_id)
        return {"request_id":request.state.request_id, "correction":report_data(row, work), "base_snapshot":row.base_snapshot, **work_detail(session, work)}


@router.post("/works/{work_id}/corrections", status_code=201)
def proactive(work_id: WorkPath, body: Submission, request: Request, response: Response, user: CurrentUser):
    if work_id != body.work_id:
        raise problem(422, "work_mismatch", "作品标识不一致")
    return {"request_id":request.state.request_id, **submit(body, request, user, response, True)}


def receipt_data(session, event, replayed, request_id=None):
    work = session.get(Work, event.work_id)
    payload = copy.deepcopy(event.payload)
    report_id = payload.pop("report_id", None)
    row = session.get(WorkCorrection, report_id) if report_id else None
    return {"request_id":request_id, "operation_id":event.operation_id, "replayed":replayed, **payload,
        "correction":report_data(row, work) if row else None, "work":public_work(work)}


@router.get("/operations/{operation_id}")
def receipt(operation_id: ReportID, request: Request, user: CurrentUser):
    reject_query(request)
    with reviewer_read(request, user) as session:
        event = event_for(session, user["id"], operation_id)
        if event is None or event.kind not in {"approve", "reject", "rebase", "pause", "restore"}:
            raise problem(404, "operation_unknown", "尚未查到审核回执，在途操作仍可能完成，请读取最新记录")
        return receipt_data(session,event,True,request.state.request_id)


async def prepare_index(work, item, request, restore=False):
    settings = request.app.state.settings
    changed = search_text(work) != search_text(item)
    current = (work.embedding is not None and work.embedding_model == settings.embedding_model and
        work.embedding_dimension == settings.embedding_dimension and valid_vector(list(work.embedding), settings.embedding_dimension))
    if settings.ai_mode == "live" and (changed or not current):
        provider = request.app.state.provider_factory()
        try:
            vectors = await asyncio.wait_for(provider.embed([search_text(item)]), settings.request_timeout)
        except TimeoutError:
            raise problem(504, "embedding_timeout", "索引准备超时，尚未发布修正") from None
        except ProviderError:
            raise problem(503, "embedding_unavailable", "索引准备失败，尚未发布修正") from None
        if len(vectors) != 1 or not valid_vector(vectors[0], settings.embedding_dimension):
            raise problem(503, "embedding_invalid", "索引结果无效，尚未发布修正")
        return {"embedding":vectors[0], "embedding_model":settings.embedding_model,
            "embedding_dimension":settings.embedding_dimension, "embedded_at":utc_now()}, {"action":"embedded", "calls":provider.calls}
    if not changed and current:
        return {k:getattr(work,k) for k in ("embedding", "embedding_model", "embedding_dimension", "embedded_at")}, {"action":"reused", "calls":0}
    return {"embedding":None, "embedding_model":None, "embedding_dimension":None, "embedded_at":None}, {"action":"baseline_only", "calls":0}


def valid_vector(vector, dimension):
    return (isinstance(vector, list) and len(vector) == dimension and all(type(x) in (int,float) and math.isfinite(x) for x in vector) and any(vector))


def check_report(row, body, state):
    if row.revision != body.expected_report_revision or row.status in ("accepted", "rejected"):
        raise problem(409, "report_conflict", "纠错已处理或已更新，请重新读取")
    if body.action != "reject" and state.revision != body.expected_work_revision:
        raise review_conflict(state)
    if body.action == "approve" and (row.status != "pending" or row.base_revision != state.revision):
        raise problem(409, "review_conflict", "旧建议须先重新核对最新资料")
    if body.action == "rebase" and row.status != "needs_recheck":
        raise problem(409, "report_conflict", "仅待重新核对的报告可以更新基准")


def hold_media(session, work_id):
    preview = session.scalar(select(WorkPreview).where(WorkPreview.work_id == work_id).with_for_update())
    if preview:
        preview.status, preview.updated_at = "unavailable", utc_now()
    job = session.scalar(select(PreviewJob).where(PreviewJob.work_id == work_id).with_for_update())
    if job:
        job.status, job.error_code, job.updated_at = "unavailable", "manual_media_hold", utc_now()


@router.post("/corrections/{report_id}/actions")
async def act(report_id: ReportID, body: ReviewAction, request: Request, user: CurrentUser):
    reject_query(request)
    key = (user["id"], body.operation_id)
    request_hash = digest({"report_id":report_id, **body.model_dump(mode="json")})
    with request.app.state.review_inflight.enter(key):
        with reviewer_read(request, user) as session:
            previous = event_for(session, user["id"], body.operation_id, request_hash, body.action)
            if previous:
                return receipt_data(session,previous,True,request.state.request_id)
            row = owned(session, user["id"], report_id, True)
            work = session.get(Work, row.work_id)
            state = work.review_state
            check_report(row, body, state)
            snapshot_revision, snapshot_hash = state.revision, work.content_hash
            source_hash = digest(state.source_snapshot)
            if body.action == "approve":
                try:
                    urls = {work.source_url}
                    preview = session.get(WorkPreview,work.id)
                    if preview:
                        from urllib.parse import urlsplit
                        parsed = urlsplit(preview.source_page_url)
                        import re
                        if parsed.scheme == 'https' and parsed.hostname in {'hongguoduanju.com','www.hongguoduanju.com'} and not parsed.username and not parsed.password and parsed.port in (None,443) and re.fullmatch(r'/player/'+re.escape(work.id.removeprefix('hongguo-'))+r'/\d{5,24}',parsed.path):
                            urls.add(preview.source_page_url)
                    item, confirmed, diffs = candidate(work, row, body.changes, body.reason, urls)
                except ValueError:
                    raise problem(422, "invalid_review_candidate", "修正字段、依据或完整资料无效，请同时核对关联资料") from None
        request.app.state.auth.limiter.take(("review_write",user["id"]),30,60)
        if body.action == "approve":
            index, embedding = await prepare_index(work, item, request)
        try:
            with request.app.state.auth.write(request, user["id"]) as (session, _):
                require_reviewer(session, user["id"])
                previous = event_for(session, user["id"], body.operation_id, request_hash, body.action)
                if previous:
                    return receipt_data(session,previous,True,request.state.request_id)
                current, state = lock_work(session, work.id)
                row = session.scalar(select(WorkCorrection).where(WorkCorrection.id == report_id).with_for_update())
                check_report(row, body, state)
                if body.action == "approve" and (state.revision != snapshot_revision or current.content_hash != snapshot_hash or digest(state.source_snapshot) != source_hash):
                    raise problem(409, "review_conflict", "资料已更新，准备稿未发布，请重新核对")
                before = state.revision
                payload = {"report_id":row.id, "reason":body.reason, "before_revision":before}
                if body.action == "approve":
                    data = item.model_dump(mode="json")
                    pause_work = body.pause or row.field in {"source_link", "work_identity"} and any(c.value == 'unavailable' for c in body.changes)
                    media_hold = body.media_hold or row.field == "preview_mapping"
                    if pause_work:
                        data["review_status"] = "pending"
                    # The content hash describes exactly the effective candidate.
                    effective = item.model_copy(update={"review_status":data["review_status"]})
                    changed = session.execute(update(Work).where(Work.id == current.id, Work.content_hash == snapshot_hash)
                        .values(**data, content_hash=content_hash(effective), **index), execution_options={"synchronize_session":False})
                    if changed.rowcount != 1:
                        raise problem(409, "review_conflict", "资料已更新，请重新核对")
                    bump(session, state, confirmed_fields=confirmed,
                        recheck_fields=[f for f in state.recheck_fields if f not in {c.field for c in body.changes}],
                        manual_hold=state.manual_hold or pause_work,
                        hold_reason=body.reason if pause_work else state.hold_reason, media_hold=state.media_hold or media_hold)
                    if media_hold or item.source_meta and item.source_meta.content_type == "漫画":
                        hold_media(session, current.id)
                    row.status, row.active_key = "accepted", None
                    invalidate_reports(session, current.id, row.id)
                    payload.update(changes=diffs, embedding=embedding)
                    session.refresh(current)
                elif body.action == "reject":
                    row.status, row.active_key = "rejected", None
                else:
                    row.base_revision, row.base_snapshot = state.revision, work_data(current)
                    row.status = "pending"
                row.revision, row.decision, row.updated_at = uuid.uuid4().hex, body.reason, utc_now()
                payload["after_revision"] = state.revision
                event = add_event(session,user["id"],body.operation_id,request_hash,body.action,current.id,payload)
                session.flush()
                result = receipt_data(session,event,False,request.state.request_id)
        except IntegrityError:
            # A failed PostgreSQL transaction must be rolled back before replay.
            with reviewer_read(request, user) as session:
                event = event_for(session,user["id"],body.operation_id,request_hash,body.action)
                if event is None:
                    raise problem(409,"review_conflict","资料已变化，请重新读取") from None
                result = receipt_data(session,event,True,request.state.request_id)
        if body.action == "approve":
            await request.app.state.previews.updated()
        return result


@router.post("/works/{work_id}/availability")
async def availability(work_id: WorkPath, body: Availability, request: Request, user: CurrentUser):
    reject_query(request)
    request_hash = digest({"work_id":work_id, **body.model_dump(mode="json")})
    with request.app.state.review_inflight.enter((user["id"], body.operation_id)):
        with reviewer_read(request,user) as session:
            old = event_for(session,user["id"],body.operation_id,request_hash,body.action)
            if old:
                return receipt_data(session,old,True,request.state.request_id)
            work = session.get(Work,work_id)
            if work is None:
                raise problem(404,"work_unavailable","作品不存在")
            state = work.review_state
            if state.revision != body.expected_work_revision:
                raise review_conflict(state)
            if body.action == "restore" and (not state.manual_hold or not state.confirmed_fields or state.recheck_fields):
                raise problem(422,"review_required","请先核对并采纳最新资料，再恢复作品")
            if body.action == "restore" and any(state.confirmed_fields.get(f,{}).get('value') == 'unavailable' for f in ('source_link','work_identity')):
                raise problem(422,"review_required","来源或作品对应仍未解决，请新建关联核对单并确认后恢复")
            if body.clear_media_hold:
                media = session.get(WorkPreview,work_id)
                basis = body.clear_media_hold
                if (not media or basis.kind != "quoted" or basis.source_url != media.source_page_url or
                        work_id.removeprefix("hongguo-") not in basis.source_url):
                    raise problem(422,"media_review_required","须明确核对本作与已有首集资产对应关系")
            snapshot_hash = work.content_hash
            item = validate_effective(work_data(work),state.confirmed_fields)
        request.app.state.auth.limiter.take(("review_write",user["id"]),30,60)
        index, embedding = await prepare_index(work,item,request,True) if body.action == "restore" else ({}, {"action":"unchanged","calls":0})
        with request.app.state.auth.write(request,user["id"]) as (session,_):
            require_reviewer(session,user["id"])
            old = event_for(session,user["id"],body.operation_id,request_hash,body.action)
            if old:
                return receipt_data(session,old,True,request.state.request_id)
            work,state = lock_work(session,work_id)
            if state.revision != body.expected_work_revision or work.content_hash != snapshot_hash:
                raise review_conflict(state)
            if body.related_correction_id and owned(session,user["id"],body.related_correction_id,True).work_id != work_id:
                raise problem(422,"invalid_related_report","关联记录须属于本作")
            before = state.revision
            confirmed = copy.deepcopy(state.confirmed_fields)
            if body.clear_media_hold:
                from .reviewing import source_fingerprint
                confirmed['preview_mapping'] = {'value':'verified','basis':body.clear_media_hold.model_dump(),
                    'evidence_id':'manual-'+uuid.uuid4().hex,'source_value':None,
                    'source_fingerprint':source_fingerprint(state.source_snapshot['data'],'preview_mapping')}
            bump(session,state,manual_hold=body.action == "pause",hold_reason=body.reason,
                confirmed_fields=confirmed,
                media_hold=False if body.clear_media_hold else state.media_hold or body.media_hold)
            work.review_status = "pending" if body.action == "pause" else "approved"
            for key,value in index.items():
                setattr(work,key,value)
            effective = item.model_copy(update={"review_status":work.review_status})
            work.content_hash = content_hash(effective)
            if state.media_hold or body.action == "pause":
                hold_media(session,work_id)
            elif body.clear_media_hold:
                media = session.scalar(select(WorkPreview).where(WorkPreview.work_id == work_id).with_for_update())
                # Revalidated files are checked again by the public delivery path.
                media.status = "ready"
            invalidate_reports(session,work_id)
            event = add_event(session,user["id"],body.operation_id,request_hash,body.action,work_id,
                {"reason":body.reason,"before_revision":before,"after_revision":state.revision,
                 "media_hold":state.media_hold,"media_basis":body.clear_media_hold.model_dump() if body.clear_media_hold else None,
                 "embedding":embedding,"report_id":body.related_correction_id})
            session.flush()
            result = receipt_data(session,event,False,request.state.request_id)
        await request.app.state.previews.updated()
        return result


def set_reviewer(sessions, settings, user_id, grant, reason):
    """Local operations only; shares the user row lock with every review write."""
    if not reason.strip() or len(reason.strip()) > 500:
        raise ValueError("权限变更须提供 1～500 字符理由")
    auth = AuthManager(sessions,settings)
    with auth.write(None,user_id,require_session=False) as (session,user):
        before = user.is_reviewer
        user.is_reviewer = grant
        op = uuid.uuid4().hex
        payload = {"user_id":user_id,"before":before,"after":grant,"reason":reason.strip()}
        add_event(session,"cli:local",op,digest(payload),"permission",None,payload)
    return {"user_id":user_id,"can_review":grant,"operation_id":op}
