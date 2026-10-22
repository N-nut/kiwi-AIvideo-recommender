"""One shared, persistent refresh job for the local single-worker service."""
import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select

from .crawler import CATEGORY_LABELS, CrawlError, collect_hongguo
from .database import CatalogRefresh, Work
from .importer import import_works
from .providers import ProviderError
from .schemas import RefreshRequest

log = logging.getLogger("kiwi")


def now():
    return datetime.now(timezone.utc).isoformat()


class CatalogManager:
    def __init__(self, sessions, settings, provider_factory, collector=None):
        self.sessions, self.settings, self.provider_factory = sessions, settings, provider_factory
        self.collector = collector or collect_hongguo
        self.task = None
        self.lock = asyncio.Lock()

    def state(self):
        with self.sessions() as session:
            record = session.get(CatalogRefresh, "hongguo")
            state = dict(record.payload) if record else {"status": "idle", "message": "选择类别，更新红果作品库"}
            return {**state, "limits": {"pages_per_source":self.settings.crawl_pages_per_source,
                "max_pages":self.settings.crawl_max_pages,"max_works":self.settings.crawl_max_works}}

    def save(self, **changes):
        state = {**self.state(), **changes}
        with self.sessions.begin() as session:
            session.merge(CatalogRefresh(id="hongguo", payload=state))
        return state

    def recover(self):
        if self.state()["status"] == "running":
            self.save(status="failed", stage="interrupted", message="上次更新因服务重启中断，请重新更新", finished_at=now(), result=None)

    async def start(self, scope=None):
        scope = scope or RefreshRequest()
        async with self.lock:
            state = self.state()
            if state["status"] == "running":
                return {**state, "reused": True}
            if state.get("finished_at") and (datetime.now(timezone.utc) - datetime.fromisoformat(state["finished_at"])).total_seconds() < 30:
                return {**state, "cooldown": True}
            state = self.save(status="running", stage="fetching", run_id=uuid.uuid4().hex,
                scope=scope.model_dump(), message="正在连接红果…", started_at=now(), finished_at=None, result=None,
                pages_done=0, raw_count=0, unique_count=0, category=None, current_page=None, indexed=0, index_total=0)
            self.task = asyncio.create_task(self.run(scope))
            return state

    async def run(self, scope):
        started = time.perf_counter()
        try:
            async with asyncio.timeout(self.settings.refresh_timeout):
                rows, metadata = await asyncio.wait_for(self.collector(scope, lambda data: self.save(**data), settings=self.settings),
                                                       timeout=min(self.settings.crawl_timeout, self.settings.refresh_timeout))
                can_embed = self.settings.ai_mode == "live" and bool(self.settings.dashscope_api_key.get_secret_value())
                settings = self.settings if can_embed else self.settings.model_copy(update={"ai_mode": "baseline"})
                self.save(stage="validating", message=f"已获取 {len(rows)} 部，正在校验资料…")
                remaining = min(self.settings.index_timeout, self.settings.refresh_timeout - (time.perf_counter() - started))
                if remaining <= 0:
                    raise TimeoutError()
                result = await asyncio.wait_for(import_works(rows, self.sessions, self.provider_factory() if can_embed else None,
                    settings, update=True, source_sync=True, progress=lambda data: self.save(**data)), timeout=remaining)
                with self.sessions() as session:
                    visible = session.scalar(select(func.count()).select_from(Work).where(Work.review_status == "approved"))
                    indexed = session.scalar(select(func.count()).select_from(Work).where(Work.review_status == "approved", Work.embedding.is_not(None),
                        Work.embedding_model == self.settings.embedding_model, Work.embedding_dimension == self.settings.embedding_dimension))
                result.update(**metadata, total=len(rows), catalog_total=visible, indexed_total=indexed,
                              indexing_enabled=can_embed, elapsed_ms=round((time.perf_counter()-started)*1000))
                limited = metadata["coverage"] == "limited"
                text = f"{'限定范围更新完成' if limited else '更新完成'}：新增 {result['new']} 部，更新 {result['updated']} 部，未变 {result['unchanged']} 部"
                if not can_embed and self.settings.ai_mode == "live":
                    text += "；尚未配置向量服务，已保存资料"
                timestamp = now()
                self.save(status="succeeded", stage="done", message=text, finished_at=timestamp,
                    last_success_at=timestamp, last_result=result, result=result, **{k:metadata[k] for k in ["pages_done","raw_count","unique_count"]})
        except asyncio.CancelledError:
            self.save(status="failed", stage="interrupted", message="更新已中断，原库已保留", finished_at=now(), result=None)
            raise
        except Exception as exc:
            message = str(exc) if isinstance(exc, CrawlError) else exc.message if isinstance(exc, ProviderError) else "本次更新未完成，已保留原片库，请稍后重试"
            if isinstance(exc, TimeoutError):
                message = "更新超过时间预算，已保留原片库，可缩小采集范围后重试"
            log.warning("catalog_refresh_failed type=%s", type(exc).__name__)
            self.save(status="failed", stage="failed", message=message, finished_at=now(), result=None)

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            # Cancellation before run() starts cannot enter its exception handler.
            if self.state()["status"] == "running":
                self.save(status="failed", stage="interrupted", message="更新已中断，原库已保留", finished_at=now(), result=None)
