"""One shared, persistent refresh job for the local application."""
import asyncio
import logging
from datetime import datetime, timezone

from .crawler import SOURCES, CrawlError, collect_hongguo
from .database import CatalogRefresh
from .importer import import_works
from .providers import ProviderError

log = logging.getLogger("kiwi")


def now():
    return datetime.now(timezone.utc).isoformat()


class CatalogManager:
    def __init__(self, sessions, settings, provider_factory, collector=None):
        self.sessions, self.settings, self.provider_factory = sessions, settings, provider_factory
        self.collector = collector or collect_hongguo
        self.task = None

    def state(self):
        with self.sessions() as session:
            record = session.get(CatalogRefresh, "hongguo")
            return dict(record.payload) if record else {"status": "idle", "message": "点击更新，从红果读取最新作品", "sources": list(SOURCES)}

    def save(self, **changes):
        state = {**self.state(), **changes}
        with self.sessions.begin() as session:
            session.merge(CatalogRefresh(id="hongguo", payload=state))
        return state

    def recover(self):
        if self.state()["status"] == "running":
            self.save(status="failed", message="上次更新因服务重启中断，请重新更新", finished_at=now())

    def start(self):
        state = self.state()
        if state["status"] == "running":
            return state
        # Small cooldown prevents repeated model costs and source requests.
        if state.get("finished_at") and (datetime.now(timezone.utc) - datetime.fromisoformat(state["finished_at"])).total_seconds() < 30:
            return {**state, "cooldown": True}
        state = self.save(status="running", message="正在连接红果…", started_at=now(), finished_at=None, result=None)
        self.task = asyncio.create_task(self.run())
        return state

    async def run(self):
        try:
            rows, counts = await asyncio.wait_for(self.collector(lambda message: self.save(message=message)), timeout=120)
            # Crawling still works without model keys. Such rows are visible, but
            # readiness continues to report missing retrieval vectors/config.
            can_embed = self.settings.ai_mode == "live" and bool(self.settings.dashscope_api_key.get_secret_value())
            settings = self.settings if can_embed else self.settings.model_copy(update={"ai_mode": "baseline"})
            self.save(message=f"已获取 {len(rows)} 部，正在更新片库…")
            result = await asyncio.wait_for(import_works(rows, self.sessions, self.provider_factory() if can_embed else None,
                settings, update=True, replace_hongguo=True, progress=lambda message: self.save(message=message)), timeout=300)
            result.update(total=len(rows), sources=counts, indexed=can_embed)
            timestamp = now()
            self.save(status="succeeded", message=f"片库已更新，共 {len(rows)} 部作品", finished_at=timestamp,
                      last_success_at=timestamp, result=result)
        except asyncio.CancelledError:
            self.save(status="failed", message="更新已中断，请重新更新", finished_at=now())
            raise
        except Exception as exc:
            message = str(exc) if isinstance(exc, CrawlError) else exc.message if isinstance(exc, ProviderError) else "本次更新未完成，已保留上次片库，请稍后重试"
            log.warning("catalog_refresh_failed type=%s", type(exc).__name__)
            self.save(status="failed", message=message, finished_at=now())

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
