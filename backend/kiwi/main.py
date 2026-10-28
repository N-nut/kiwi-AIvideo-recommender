import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import ValidationError
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError

from .config import ROOT, Settings
from .catalog import CatalogManager
from .database import Work, initialize, make_database, public_work
from .providers import BaselineAI, LiveAI, ProviderError
from .repository import array_has
from .schemas import ContentType, HomeRecommendationResponse, ParseRequest, RecommendationRequest, RefreshRequest, RefinementPlan, RefinementRequest, RefinementResponse
from .refinement import InvalidRefinementOutput, merge_refinement, normalize
from .service import recommend
from .auth import AuthManager, get_current_user, problem, protect_write, router as auth_router
from .favorites import router as favorites_router
from .home_recommendations import home_recommendations
from .previews import router as previews_router
from .preview_jobs import PreviewManager
from .personal_space import router as personal_space_router
from .feedback import reject_query, router as feedback_router
from .history import save_history, router as history_router
from .corrections import router as corrections_router
from .reviews import Inflight, router as reviews_router

log = logging.getLogger("kiwi")
log.setLevel(logging.INFO)
if not log.handlers:
    log.addHandler(logging.StreamHandler())


def create_app(settings=None, provider_factory=None, collector=None, preview_source_factory=None):
    settings = settings or Settings()
    engine, sessions = make_database(settings.database_url)
    provider_factory = provider_factory or (lambda: LiveAI(settings) if settings.ai_mode == "live" else BaselineAI())
    previews = PreviewManager(sessions, settings, preview_source_factory, provider_factory)
    catalog = CatalogManager(sessions, settings, provider_factory, collector, previews)

    @asynccontextmanager
    async def lifespan(app):
        # Production schema changes are applied by Alembic before startup.
        if engine.dialect.name == "sqlite":
            initialize(engine)
        app.state.auth.cleanup(force=True)
        catalog.recover()
        await previews.start()
        yield
        await catalog.close()
        await previews.close()
        engine.dispose()

    app = FastAPI(title="Kiwi AI 漫剧推荐", version="1.0.0", lifespan=lifespan)
    app.state.sessions, app.state.engine, app.state.settings = sessions, engine, settings
    app.state.catalog = catalog
    app.state.previews = previews
    app.state.auth = AuthManager(sessions, settings)
    app.state.provider_factory = provider_factory
    app.state.review_inflight = Inflight()
    app.include_router(auth_router)
    app.include_router(favorites_router)
    app.include_router(previews_router)
    app.include_router(personal_space_router)
    app.include_router(feedback_router)
    app.include_router(history_router)
    app.include_router(corrections_router)
    app.include_router(reviews_router)

    @app.middleware("http")
    async def request_context(request, call_next):
        request.state.request_id = uuid.uuid4().hex
        start = time.perf_counter()
        private = request.url.path.startswith(("/api/v1/auth/", "/api/v1/me/"))
        def finish(response):
            response.headers["X-Request-ID"] = request.state.request_id
            if private or request.url.path.startswith("/api/v1/works") or request.url.path in {"/api/v1/home/recommendations", "/api/v1/recommendations", "/api/v1/preferences/refine"} or request.url.path.startswith("/api/v1/media/previews/") or request.url.path.endswith("/preview"):
                response.headers["Cache-Control"] = "no-store"
            return response
        # A real byte limit also covers chunked requests; do not trust Content-Length.
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            size = 0
            chunks = []
            async for chunk in request.stream():
                size += len(chunk)
                if size > 24_000:
                    return finish(JSONResponse(status_code=413, content={"error": {"code": "payload_too_large", "message": "请求内容过长"}, "request_id": request.state.request_id}))
                chunks.append(chunk)
            request._body = b"".join(chunks)
        if (private or request.url.path == "/api/v1/preferences/refine") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
            try:
                protect_write(request)
                if (request.method in ("PUT", "DELETE") or request.url.path.endswith("/logout")) and request._body:
                    raise HTTPException(422, {"code": "unexpected_body", "message": "此操作不接受额外字段"})
            except HTTPException as exc:
                return finish(JSONResponse(status_code=exc.status_code, content={"error": exc.detail, "request_id": request.state.request_id}))
        if private and "user_id" in request.query_params:
            return finish(JSONResponse(status_code=422, content={"error": {"code": "unexpected_field", "message": "不接受账号归属字段"}, "request_id": request.state.request_id}))
        try:
            response = await call_next(request)
        except SQLAlchemyError:
            code = "service_unavailable" if request.url.path in {"/api/v1/me/profile", "/api/v1/me/space-summary", "/api/v1/me/password"} else "database_unavailable"
            return finish(JSONResponse(status_code=503, content={"error": {"code": code, "message": "数据库暂时不可用，请稍后重试"}, "request_id": request.state.request_id}))
        log.info(json.dumps({"request_id": request.state.request_id, "path": request.url.path,
                             "status": response.status_code, "elapsed_ms": round((time.perf_counter()-start)*1000, 2)}, ensure_ascii=False))
        return finish(response)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, exc):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": exc.detail}
        return JSONResponse(status_code=exc.status_code, content={"error": detail, "request_id": request.state.request_id}, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Do not echo arbitrary user input, database URLs, or upstream credentials.
        if request.url.path.startswith(("/api/v1/auth/", "/api/v1/me/")):
            safe = {"username": "用户名须为 3～20 位英文字母、数字或下划线", "password": "密码须为 8～64 个字符", "confirm_password": "请确认两次密码一致且为 8～64 个字符", "work_ids": "每批提交 1～100 个有效作品标识", "page": "页码须大于零", "page_size": "每页数量超出允许范围", "nickname": "昵称须为 1～20 个字符，不能含换行或控制字符", "avatar_id": "请选择预设头像", "current_password": "当前密码须为 8～64 个字符", "new_password": "新密码须为 8～64 个字符"}
            fields = list(dict.fromkeys(next((str(part) for part in error["loc"] if part in safe), "confirm_password" if error["type"] == "value_error" and request.url.path.endswith("/register") else "body") for error in exc.errors()))
            messages = {field: safe.get(field, "请求字段不符合要求") for field in fields}
            return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "；".join(messages.values()), "fields": fields, "field_messages": messages}, "request_id": request.state.request_id})
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

    @app.post("/api/v1/preferences/refine", response_model=RefinementResponse)
    async def refine(body: RefinementRequest, request: Request):
        reject_query(request)
        ip = request.client.host if request.client else "unknown"
        app.state.auth.limiter.take(("preference_refine", ip), settings.preference_refine_ip_limit, 60)
        provider = provider_factory()
        base = normalize(body.base_preferences)
        start = time.perf_counter()
        try:
            plan = await asyncio.wait_for(provider.refine(base, body.text), settings.request_timeout)
            plan = RefinementPlan.model_validate(plan)
            outcome = merge_refinement(base, body.text, plan)
        except (InvalidRefinementOutput, ValidationError) as exc:
            raise ProviderError("refinement_invalid_output", "调整理解结果无效，请重试或手动调整") from exc
        elapsed = round((time.perf_counter() - start) * 1000, 2)
        usage = {"calls": provider.calls, "tokens": provider.tokens}
        log.info(json.dumps({"request_id": request.state.request_id, "mode": settings.ai_mode,
                             "status": outcome["status"], "base_revision": body.base_revision,
                             "operations": len(plan.operations), "elapsed_ms": elapsed, "usage": usage}))
        return {"request_id": request.state.request_id, "base_revision": body.base_revision,
                **outcome, "mode": settings.ai_mode, "timings_ms": {"refine": elapsed}, "usage": usage}

    @app.post("/api/v1/me/recommendations")
    async def private_recommendations(body: RecommendationRequest, request: Request, user=Depends(get_current_user)):
        reject_query(request)
        result = await asyncio.wait_for(recommend(body, sessions, provider_factory(), settings, request.state.request_id, user["id"]), settings.request_timeout)
        get_current_user(request)  # Revocation during generation also invalidates this result.
        try:
            result["history"] = save_history(request, user, body, result)
        except SQLAlchemyError:
            get_current_user(request)
            result["history"] = {"status": "failed"}
            result["warnings"].append("本次片单未保存到历史，请保留当前结果；稍后生成的片单会再次尝试保存。")
        return result

    def home_response(request, user_id=None):
        if request.query_params:
            raise problem(422, "unexpected_field", "首页推荐不接受额外参数")
        try:
            return home_recommendations(sessions, request.state.request_id, user_id)
        except Exception as exc:
            log.error({"request_id": request.state.request_id, "stage": "home_recommendations", "error_type": type(exc).__name__})
            raise problem(503, "home_unavailable", "首页推荐暂时不可用，请稍后重试") from None

    @app.get("/api/v1/home/recommendations", response_model=HomeRecommendationResponse)
    def public_home(request: Request):
        return home_response(request)

    @app.get("/api/v1/me/home-recommendations", response_model=HomeRecommendationResponse)
    def private_home(request: Request, user=Depends(get_current_user)):
        return home_response(request, user["id"])

    @app.get("/api/v1/catalog/refresh")
    async def refresh_state():
        return catalog.state()

    @app.post("/api/v1/catalog/refresh", status_code=202)
    async def refresh_catalog(body: RefreshRequest, request: Request):
        origin = request.headers.get("origin")
        if origin:
            host = urlsplit(origin).hostname
            local = {"localhost", "127.0.0.1", "::1"}
            if host != request.url.hostname and not (host in local and request.url.hostname in local):
                raise HTTPException(403, "请从奇维页面发起更新")
        return await catalog.start(body)

    @app.get("/api/v1/works")
    def works(page: int = Query(1, ge=1), page_size: int = Query(12, ge=1, le=50), genre: str | None = Query(None, max_length=30), content_type: ContentType | None = None, q: str = Query("", max_length=100)):
        with sessions() as session:
            statement = select(Work).where(Work.review_status == "approved")
            if genre:
                statement = statement.where(array_has(Work.genres, genre, engine.dialect.name))
            if content_type:
                statement = statement.where(Work.source_meta["content_type"].as_string() == content_type)
            if q.strip():
                statement = statement.where(Work.title.icontains(q.strip(), autoescape=True))
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
