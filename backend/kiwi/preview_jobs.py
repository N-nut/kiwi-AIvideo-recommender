"""Persistent, bounded preview preparation, independent of catalogue ingestion."""
import asyncio
import hashlib
import json
import logging
import tempfile
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select

from .database import CatalogRefresh, PreviewJob, Work, WorkPreview, as_utc, public_work, utc_now
from .preview_importer import MediaError, import_previews, run_tool
from .preview_source import HongguoPreviewSource
from .previews import DRAMA_TYPES, ready_file
from .file_lock import FileLock as WorkerLock
from .importer import import_works
from .providers import LiveAI
from .corrections import catalog_write, lock_work

log = logging.getLogger("kiwi")
USAGE = "用户指定从红果公开第一集截取用于本机开发验证；不代表来源方授予对外传播许可。"


def eligible(work):
    return work.review_status == "approved" and work.review_state is not None and not work.review_state.media_hold and not work.review_state.manual_hold and (work.source_meta or {}).get("content_type") in DRAMA_TYPES


def source_key(work):
    value = work if isinstance(work,dict) else public_work(work)
    meta = value.get('source_meta') or {}
    return hashlib.sha256(json.dumps([value['id'],value['title'],value['source_url'],meta.get('provider'),meta.get('content_type')], ensure_ascii=False).encode()).hexdigest()


class PreviewManager:
    def __init__(self, sessions, settings, source_factory=None, provider_factory=None):
        self.sessions, self.settings = sessions, settings
        self.source_factory = source_factory or HongguoPreviewSource
        self.provider_factory = provider_factory or (lambda: LiveAI(settings))
        self.source = None
        self.tasks = []
        self.start_task = None
        self.claim_lock, self.publish_lock, self.start_lock = asyncio.Lock(), asyncio.Lock(), asyncio.Lock()
        self.wake = asyncio.Event()
        self.stopping = False
        self.lock = WorkerLock(settings.media_root.parent / ".preview-worker.lock")

    def service(self, **payload):
        with self.sessions.begin() as session:
            session.merge(CatalogRefresh(id="preview-service", payload=payload))

    def state(self):
        counts = {"total":0, "ready":0, "pending":0, "running":0, "unavailable":0}
        with self.sessions() as session:
            rows = session.execute(select(Work, WorkPreview, PreviewJob).outerjoin(WorkPreview, WorkPreview.work_id == Work.id)
                .outerjoin(PreviewJob, PreviewJob.work_id == Work.id)).all()
            record = session.get(CatalogRefresh, "preview-service")
            service = record.payload if record else {}
            for work, preview, job in rows:
                if not eligible(work):
                    continue
                counts["total"] += 1
                if preview and ready_file(preview, self.settings) and (not job or job.source_key == source_key(work)):
                    counts["ready"] += 1
                elif job and job.status in ("pending", "running", "unavailable"):
                    counts[job.status] += 1
                else:
                    counts["pending"] += 1
        return {**counts, "enabled":self.settings.preview_auto_enabled, "error_code":service.get("error_code"),
            "active":bool(self.settings.preview_auto_enabled and (counts["pending"] or counts["running"]) and not service.get("error_code"))}

    def enqueue(self, retry_failed=False):
        if not self.settings.preview_auto_enabled:
            return 0
        queued = 0
        with catalog_write(self.sessions) as session:
            work_ids = session.scalars(select(Work.id).order_by(Work.id)).all()
            for work_id in work_ids:
                work, _ = lock_work(session,work_id)
                job = session.scalar(select(PreviewJob).where(PreviewJob.work_id == work.id).with_for_update())
                if not eligible(work):
                    if job and job.status in ("running", "pending"):
                        job.status = "unavailable"; job.error_code = "work_unavailable"
                    continue
                preview = session.get(WorkPreview, work.id)
                key = source_key(work)
                if preview and ready_file(preview, self.settings) and (not job or job.source_key == key):
                    if job:
                        job.status = "ready"; job.error_code = None; job.retry_at = None
                    continue
                if preview and job and job.source_key != key:
                    preview.status = "unavailable"
                if job and job.status == "running":
                    continue
                if not job or job.source_key != key or (retry_failed and job.status == "unavailable" and job.error_code != 'source_http_404') or job.status == "ready":
                    timestamp = utc_now()
                    if job is None:
                        job = PreviewJob(work_id=work.id, created_at=timestamp)
                        session.add(job)
                    job.status, job.source_key, job.attempts = "pending", key, 0
                    job.error_code, job.retry_at, job.updated_at = None, None, timestamp
                    queued += 1
        self.wake.set()
        return queued

    async def start(self):
        if not self.settings.preview_auto_enabled or self.stopping:
            return
        async with self.start_lock:
            if any(not task.done() for task in self.tasks):
                return
            if not self.lock.acquire():
                return
            try:
                with catalog_write(self.sessions) as session:
                    ids = session.scalars(select(PreviewJob.work_id).where(PreviewJob.status == "running").order_by(PreviewJob.work_id)).all()
                    for work_id in ids:
                        work,_ = lock_work(session,work_id)
                        job = session.scalar(select(PreviewJob).where(PreviewJob.work_id == work_id).with_for_update())
                        job.status = "pending" if eligible(work) else "unavailable"
                        job.retry_at = None; job.attempts = max(0, job.attempts - 1)
                self.enqueue()
                if not self.state()["pending"]:
                    self.lock.close()
                    return
                for tool in (self.settings.ffmpeg_path, self.settings.ffprobe_path):
                    await asyncio.to_thread(run_tool, [tool, "-version"], 10, "tools")
                self.source = self.source_factory(self.settings)
                await self.source.start()
                self.service(status="running", error_code=None)
                self.tasks = [asyncio.create_task(self.worker()) for _ in range(self.settings.preview_workers)]
            except Exception as exc:
                code = exc.code if isinstance(exc, MediaError) else "preparation_unavailable"
                self.service(status="unavailable", error_code=code)
                log.warning("preview_worker_unavailable type=%s", code)
                if self.source:
                    await self.source.close(); self.source = None
                self.lock.close()

    async def updated(self):
        queued = self.enqueue(retry_failed=True)
        # A slow browser launch cannot turn a committed catalogue update into
        # a failed refresh or consume its remaining collection time budget.
        if not self.stopping and (self.start_task is None or self.start_task.done()):
            self.start_task = asyncio.create_task(self.start())
        return queued

    async def claim(self):
        async with self.claim_lock:
            with catalog_write(self.sessions) as session:
                timestamp = utc_now()
                ids = session.scalars(select(PreviewJob.work_id).where(PreviewJob.status == "pending").order_by(PreviewJob.work_id)).all()
                for work_id in ids:
                    work, _ = lock_work(session,work_id)
                    job = session.scalar(select(PreviewJob).where(PreviewJob.work_id == work_id).with_for_update())
                    if not job or job.status != 'pending':
                        continue
                    if job.retry_at and as_utc(job.retry_at) > timestamp:
                        continue
                    if not work or not eligible(work):
                        job.status = "unavailable"; job.error_code = "work_unavailable"
                        continue
                    job.status = "running"; job.attempts += 1; job.updated_at = timestamp
                    return public_work(work)
        return None

    def finish(self, work_id, code=None, interrupted=False):
        with catalog_write(self.sessions) as session:
            work, _ = lock_work(session,work_id)
            job = session.scalar(select(PreviewJob).where(PreviewJob.work_id == work_id).with_for_update())
            if not job:
                return
            if not work or not eligible(work):
                job.status, job.error_code = "unavailable", "work_unavailable"
                return
            job.updated_at = utc_now(); job.error_code = code
            if interrupted:
                job.status = "pending"; job.attempts = max(0, job.attempts-1); job.retry_at = None
            elif code:
                terminal = code in {"unsupported_source", "episode_identity_mismatch", "media_host_rejected", "source_http_401", "source_http_403", "source_http_404", "invalid_work"}
                retry = not terminal and job.attempts < self.settings.preview_attempts
                job.status = "pending" if retry else "unavailable"
                job.retry_at = utc_now() + timedelta(seconds=self.settings.preview_retry_seconds * job.attempts) if retry else None
            else:
                job.status = "ready"; job.retry_at = None

    async def prepare(self, work):
        self.settings.media_root.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".preview-source-", dir=self.settings.media_root.parent) as folder:
            folder = Path(folder)
            info = await self.source.resolve(work)
            if info.get('source_record'):
                work = await self.sync_source(work, info['source_record'])
            await self.source.download(info, folder / "source.mp4")
            with self.sessions() as session:
                current=session.get(Work,work['id'])
                if not current or not eligible(current) or source_key(current)!=source_key(work) or current.review_state.revision != work['review']['revision']:
                    raise MediaError('work','source_changed')
            manifest = folder / "manifest.json"
            manifest.write_text(json.dumps([{"work_id":work["id"], "source_file":"source.mp4", "source_page_url":info["source_page_url"],
                "usage_basis":USAGE, "clip_kind":"excerpt", "start_seconds":0, "duration_seconds":15,
                "work_confirmed":True, "usage_confirmed":True}], ensure_ascii=False), encoding="utf-8")
            async with self.publish_lock:
                # Existing offline importer provides bounded processing, measured
                # validation, immutable publication and transactional replacement.
                task = asyncio.create_task(asyncio.to_thread(import_previews, manifest, self.sessions, self.settings,
                    expected_work_versions={work['id']:work['review']['revision']}))
                try:
                    result = await asyncio.shield(task)
                except asyncio.CancelledError:
                    await task
                    raise
                if result["failed"]:
                    raise MediaError("publish", result["items"][0]["error"])

    async def sync_source(self, work, row):
        from .preview_source import source_identity
        if row.get('id') != work['id'] or source_identity(row) != source_identity(work):
            raise MediaError('source', 'episode_identity_mismatch')
        with self.sessions() as session:
            current = session.get(Work, work['id'])
            if not current or not eligible(current) or source_key(current) != source_key(work) or current.review_state.revision != work['review']['revision']:
                raise MediaError('source', 'source_changed')
            expected_hash = current.content_hash
        can_embed = self.settings.ai_mode == 'live' and bool(self.settings.dashscope_api_key.get_secret_value())
        settings = self.settings if can_embed else self.settings.model_copy(update={'ai_mode':'baseline'})
        await import_works([row], self.sessions, self.provider_factory() if can_embed else None,
            settings, update=True, source_sync=True, expected_hashes={work['id']:expected_hash}, expected_revisions={work['id']:work['review']['revision']})
        with catalog_write(self.sessions) as session:
            current,_ = lock_work(session,work['id'])
            if not current or not eligible(current) or current.title != row['title']:
                raise MediaError('source', 'source_changed')
            job = session.scalar(select(PreviewJob).where(PreviewJob.work_id == work['id']).with_for_update())
            if job:
                job.source_key = source_key(current)
            return public_work(current)

    async def worker(self):
        while not self.stopping:
            work = await self.claim()
            if not work:
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), 2)
                except TimeoutError:
                    pass
                continue
            try:
                await self.prepare(work)
                self.finish(work["id"])
                log.info("preview_ready work_id=%s", work["id"])
            except asyncio.CancelledError:
                self.finish(work["id"], interrupted=True)
                raise
            except Exception as exc:
                code = exc.code if isinstance(exc, MediaError) else "preparation_failed"
                self.finish(work["id"], code)
                log.warning("preview_failed work_id=%s code=%s", work["id"], code)
            await asyncio.sleep(0.5)

    async def wait_idle(self, progress=None):
        while True:
            state = self.state()
            if progress:
                progress(state)
            if not state["enabled"] or state["error_code"] or not (state["pending"] or state["running"]):
                return state
            await asyncio.sleep(2)

    async def close(self):
        self.stopping = True
        if self.start_task:
            await asyncio.gather(self.start_task,return_exceptions=True)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.source:
            await self.source.close()
        self.lock.close()
