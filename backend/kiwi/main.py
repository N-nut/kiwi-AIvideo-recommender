import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError

from .config import ROOT, Settings
from .database import Work, initialize, make_database, public_work
from .providers import BaselineAI, LiveAI, ProviderError
from .repository import array_has
from .schemas import ParseRequest, RecommendationRequest
from .service import recommend

log = logging.getLogger("kiwi")
log.setLevel(logging.INFO)
if not log.handlers:
    log.addHandler(logging.StreamHandler())


def create_app(settings=None, provider_factory=None):
    settings = settings or Settings()
    engine, sessions = make_database(settings.database_url)
    provider_factory = provider_factory or (lambda: LiveAI(settings) if settings.ai_mode == "live" else BaselineAI())

    @asynccontextmanager
    async def lifespan(app):
        # Production schema changes are applied by Alembic before startup.
        if engine.dialect.name == "sqlite":
            initialize(engine)
        yield
        engine.dispose()

    app = FastAPI(title="Kiwi AI 漫剧推荐", version="1.0.0", lifespan=lifespan)
    app.state.sessions, app.state.engine, app.state.settings = sessions, engine, settings

    @app.middleware("http")
    async def request_context(request, call_next):
        request.state.request_id = uuid.uuid4().hex
        start = time.perf_counter()
        # A real byte limit also covers chunked requests; do not trust Content-Length.
        if request.method in ("POST", "PUT", "PATCH"):
            size = 0
            chunks = []
            async for chunk in request.stream():
                size += len(chunk)
                if size > 24_000:
                    return JSONResponse(status_code=413, content={"error": {"code": "payload_too_large", "message": "请求内容过长"}, "request_id": request.state.request_id})
                chunks.append(chunk)
            request._body = b"".join(chunks)
        try:
            response = await call_next(request)
        except SQLAlchemyError:
            return JSONResponse(status_code=503, content={"error": {"code": "database_unavailable", "message": "数据库暂时不可用，请稍后重试"}, "request_id": request.state.request_id})
        response.headers["X-Request-ID"] = request.state.request_id
        log.info(json.dumps({"request_id": request.state.request_id, "path": request.url.path,
                             "status": response.status_code, "elapsed_ms": round((time.perf_counter()-start)*1000, 2)}, ensure_ascii=False))
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Do not echo arbitrary user input, database URLs, or upstream credentials.
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "参数不符合要求，请检查输入及偏好字段",
            "fields": [".".join(map(str, e["loc"])) for e in exc.errors()]}, "request_id": request.state.request_id})

    @app.exception_handler(ProviderError)
    async def provider_error(request, exc):
        return JSONResponse(status_code=503, content={"error": {"code": exc.code, "message": exc.message}, "request_id": request.state.request_id, "retryable": True})

    @app.exception_handler(TimeoutError)
    async def timeout_error(request, exc):
        return JSONResponse(status_code=504, content={"error": {"code": "request_timeout", "message": "本次请求超时，偏好已保留，可重新尝试"}, "request_id": request.state.request_id, "retryable": True})

    @app.get("/health/live")
    def live():
        return {"status": "ok"}

    @app.get("/health/ready")
    def ready():
        try:
            with sessions() as session:
                session.execute(text("SELECT 1"))
                count = session.scalar(select(func.count()).select_from(Work).where(Work.review_status == "approved"))
                vectors = session.scalar(select(func.count()).select_from(Work).where(Work.review_status == "approved", Work.embedding.is_not(None), Work.embedding_model == settings.embedding_model, Work.embedding_dimension == settings.embedding_dimension))
            is_ready = settings.configured and count > 0 and (settings.ai_mode == "baseline" or vectors == count)
            body = {"status": "ready" if is_ready else "not_ready", "mode": settings.ai_mode,
                    "storage": engine.dialect.name, "works": count, "embedded_works": vectors,
                    "configured": settings.configured, "model": settings.deepseek_model,
                    "embedding_model": settings.embedding_model, "embedding_dimension": settings.embedding_dimension}
            return JSONResponse(status_code=200 if is_ready else 503, content=body)
        except SQLAlchemyError:
            return JSONResponse(status_code=503, content={"status": "not_ready", "reason": "数据库或迁移未就绪"})

    @app.post("/api/v1/preferences/parse")
    async def parse(body: ParseRequest, request: Request):
        provider = provider_factory()
        start = time.perf_counter()
        prefs = await asyncio.wait_for(provider.parse(body.text), settings.request_timeout)
        return {"request_id": request.state.request_id, "preferences": prefs.model_dump(), "mode": settings.ai_mode,
                "timings_ms": {"parse": round((time.perf_counter() - start) * 1000, 2)},
                "usage": {"calls": provider.calls, "tokens": provider.tokens}}

    @app.post("/api/v1/recommendations")
    async def recommendations(body: RecommendationRequest, request: Request):
        result = await asyncio.wait_for(recommend(body, sessions, provider_factory(), settings, request.state.request_id), settings.request_timeout)
        log.info(json.dumps({"request_id": result["request_id"], "stage_ms": result["timings_ms"], "candidates": len(result["candidate_ids"]), "mode": settings.ai_mode, "usage": result["usage"]}))
        return result

    @app.get("/api/v1/works")
    def works(page: int = Query(1, ge=1), page_size: int = Query(12, ge=1, le=50), genre: str | None = Query(None, max_length=30)):
        with sessions() as session:
            statement = select(Work).where(Work.review_status == "approved")
            if genre:
                statement = statement.where(array_has(Work.genres, genre, engine.dialect.name))
            total = session.scalar(select(func.count()).select_from(statement.subquery()))
            rows = session.scalars(statement.order_by(Work.id).offset((page-1)*page_size).limit(page_size))
            return {"items": [public_work(w) for w in rows], "total": total, "page": page, "page_size": page_size}

    @app.get("/api/v1/works/{work_id}")
    def work(work_id: str):
        with sessions() as session:
            row = session.get(Work, work_id)
            if row is None or row.review_status != "approved":
                raise HTTPException(404, "作品不存在或尚未审核")
            return public_work(row)

    static = ROOT / "frontend/dist"
    if (ROOT / "demo").is_dir():
        app.mount("/demo", StaticFiles(directory=ROOT / "demo", html=True), name="demo")
    if static.is_dir():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        @app.get("/")
        def index():
            return FileResponse(static / "index.html")
    return app


app = create_app()

