"""Public metadata and guarded file delivery; never downloads or transcodes."""
import re
from pathlib import Path

from fastapi import APIRouter, Path as PathParam, Request
from fastapi.responses import FileResponse, Response
from pydantic import Field
from sqlalchemy import select

from .auth import problem
from .database import CatalogRefresh, PreviewJob, Work, WorkPreview, as_utc
from .schemas import StrictModel

DRAMA_TYPES = {"真人剧", "漫剧", "AI剧"}
ASSET_PATTERN = r"^[0-9a-f]{32}$"
router = APIRouter(prefix="/api/v1")


class PreviewMedia(StrictModel):
    asset_id: str
    clip_kind: str
    video_url: str
    poster_url: str | None
    content_type: str = "video/mp4"
    duration_ms: int = Field(gt=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    source_page_url: str
    checked_at: str


class PreviewResponse(StrictModel):
    request_id: str
    work_id: str
    status: str
    message: str
    preview: PreviewMedia | None = None
    preparing: bool = False


def reject_query(request):
    if request.query_params:
        raise problem(422, "unexpected_field", "预览不接受额外参数")


def media_file(root, relative, asset_id, kind):
    # Fixed names also prevent database corruption from exposing other local files.
    expected = f"{asset_id}/{'clip.mp4' if kind == 'video' else 'poster.jpg'}"
    if not re.fullmatch(ASSET_PATTERN, asset_id or "") or relative != expected:
        return None
    root = Path(root).resolve()
    candidate = root / relative
    try:
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file() or candidate.is_symlink() or candidate.parent.is_symlink():
            return None
        return resolved
    except (OSError, ValueError, RuntimeError):
        return None


def ready_file(row, settings):
    if (row.status != "ready" or not row.asset_id or not row.checked_at or not row.usage_basis.strip()
            or not row.source_hash or not row.processing_hash or not row.video_sha256
            or not all(value and value > 0 for value in (row.width, row.height, row.duration_ms, row.size_bytes))):
        return None
    path = media_file(settings.media_root, row.video_path, row.asset_id, "video")
    try:
        return path if path and path.stat().st_size == row.size_bytes else None
    except OSError:
        return None


@router.get("/works/{work_id}/preview", response_model=PreviewResponse)
def preview_metadata(request: Request, work_id: str = PathParam(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")):
    reject_query(request)
    settings = request.app.state.settings
    with request.app.state.sessions() as session:
        work = session.get(Work, work_id)
        if not work or work.review_status != "approved":
            raise problem(404, "work_not_found", "作品不存在或不可用")
        kind = (work.source_meta or {}).get("content_type")
        row = session.get(WorkPreview, work_id)
        status = "not_applicable" if kind == "漫画" else "unavailable" if kind not in DRAMA_TYPES else row.status if row else "missing"
        if status == "ready" and not ready_file(row, settings):
            status = "unavailable"
        job = session.get(PreviewJob, work_id) if kind in DRAMA_TYPES else None
        service = session.get(CatalogRefresh, "preview-service") if job else None
        service_error = (service.payload or {}).get("error_code") if service else None
        preparing = bool(settings.preview_auto_enabled and not service_error and job and job.status in ("pending", "running") and status != "ready")
        if preparing:
            status = "pending"
        elif status != "ready" and job and (job.status == "unavailable" or service_error):
            status = "unavailable"
        payload = None
        if status == "ready":
            prefix = f"/api/v1/media/previews/{row.asset_id}"
            payload = PreviewMedia(asset_id=row.asset_id, clip_kind=row.clip_kind, video_url=f"{prefix}/video",
                poster_url=f"{prefix}/poster" if media_file(settings.media_root, row.poster_path, row.asset_id, "poster") else None,
                duration_ms=row.duration_ms, width=row.width, height=row.height,
                source_page_url=row.source_page_url, checked_at=as_utc(row.checked_at).isoformat())
        message = {"ready": "真实预告" if row and row.clip_kind == "trailer" else "试看片段", "missing": "暂无视频预览",
                   "pending": "暂无视频预览", "unavailable": "视频暂不可用", "not_applicable": "漫画阅读资料预览"}[status]
        return PreviewResponse(request_id=request.state.request_id, work_id=work_id, status=status, message="预览准备中" if preparing else message, preview=payload, preparing=preparing)


@router.api_route("/media/previews/{asset_id}/{kind}", methods=["GET", "HEAD"])
def preview_file(request: Request, asset_id: str = PathParam(pattern=ASSET_PATTERN), kind: str = PathParam(pattern=r"^(video|poster)$")):
    reject_query(request)
    settings = request.app.state.settings
    with request.app.state.sessions() as session:
        row = session.scalar(select(WorkPreview).join(Work, Work.id == WorkPreview.work_id).where(
            WorkPreview.asset_id == asset_id, WorkPreview.status == "ready", Work.review_status == "approved"))
        work = session.get(Work, row.work_id) if row else None
        if not row or (work.source_meta or {}).get("content_type") not in DRAMA_TYPES or not ready_file(row, settings):
            raise problem(404, "media_not_found", "片段不存在或已不可用")
        path = media_file(settings.media_root, row.video_path if kind == "video" else row.poster_path, asset_id, kind)
        if not path:
            raise problem(404, "media_not_found", "片段不存在或已不可用")
        content_type = "video/mp4" if kind == "video" else "image/jpeg"
        headers = {"Cache-Control": "no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"}
        if settings.media_delivery_mode == "nginx":
            return Response(media_type=content_type, headers={**headers, "X-Accel-Redirect": f"/_kiwi_previews/{asset_id}/{path.name}"})
        return FileResponse(path, media_type=content_type, headers=headers)
