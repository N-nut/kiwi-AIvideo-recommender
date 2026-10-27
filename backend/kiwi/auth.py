"""Single-worker browser authentication with database-backed, fixed-life sessions."""
from collections import OrderedDict
from contextlib import contextmanager
from datetime import timedelta
import hashlib
import math
import re
import secrets
from threading import BoundedSemaphore, Lock
import time
from urllib.parse import urlsplit
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pwdlib import PasswordHash
from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .database import User, UserSession, as_utc, utc_now

COOKIE = "kiwi_session"
passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash(secrets.token_urlsafe(32))


def problem(status, code, message, fields=None, headers=None):
    detail = {"code": code, "message": message}
    if fields:
        detail["fields"] = fields
        detail["field_messages"] = {field: message for field in fields}
    return HTTPException(status, detail, headers=headers)


def username_parts(value):
    name = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", name):
        raise ValueError("用户名须为 3～20 位英文字母、数字或下划线")
    return name, name.lower()


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    username: str = Field(max_length=200)
    password: str = Field(min_length=8, max_length=64, repr=False)

    @field_validator("username")
    @classmethod
    def valid_username(cls, value):
        return username_parts(value)[0]


class RegisterInput(LoginInput):
    confirm_password: str = Field(min_length=8, max_length=64, repr=False)

    @model_validator(mode="after")
    def matching_passwords(self):
        if self.password != self.confirm_password:
            raise ValueError("两次密码不一致")
        return self


def origin_key(value, referer=False):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
                or parsed.password or "*" in parsed.hostname or parsed.fragment
                or not referer and (parsed.path or parsed.query)):
            return None
        if parsed.port == 0:
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return None


def protect_write(request):
    origins = {origin_key(x.strip()) for x in request.app.state.settings.auth_allowed_origins.split(",")}
    origin = request.headers.get("origin")
    source = origin_key(origin) if origin is not None else origin_key(request.headers.get("referer", ""), referer=True)
    if source is None or source not in origins or request.headers.get("x-kiwi-request") != "1":
        raise problem(403, "invalid_origin", "请从奇维页面发起账号或收藏操作")
    if getattr(request, "_body", b"") and request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise problem(403, "invalid_content_type", "请使用 JSON 请求")


class RateLimiter:
    """Bounded counters; refuse new keys when full instead of evicting active limits."""
    def __init__(self, capacity, clock=time.monotonic):
        self.capacity, self.clock = capacity, clock
        self.entries = OrderedDict()
        self.lock = Lock()
        self.next_cleanup = 0

    def take(self, key, limit, window):
        now = self.clock()
        with self.lock:
            if now >= self.next_cleanup:
                self.entries = OrderedDict((k, v) for k, v in self.entries.items() if v[0] > now)
                self.next_cleanup = now + 30
            expiry, count = self.entries.get(key, (now + window, 0))
            if expiry <= now:
                expiry, count = now + window, 0
            if count >= limit or key not in self.entries and len(self.entries) >= self.capacity:
                raise problem(429, "rate_limited", "操作过于频繁，请稍后重试", headers={"Retry-After": str(max(1, math.ceil(expiry - now)))})
            self.entries[key] = (expiry, count + 1)
            return key, expiry

    def refund(self, reservation):
        key, expiry = reservation
        with self.lock:
            current = self.entries.get(key)
            if current and current[0] == expiry:
                self.entries[key] = (expiry, max(0, current[1] - 1))


class AuthManager:
    def __init__(self, sessions, settings):
        self.sessions, self.settings = sessions, settings
        self.limiter = RateLimiter(settings.auth_limiter_capacity)
        self.hash_slots = BoundedSemaphore(settings.auth_hash_concurrency)
        self.cleanup_lock = Lock()
        self.next_cleanup = 0
        self.now = utc_now

    @contextmanager
    def hashing(self):
        if not self.hash_slots.acquire(blocking=False):
            raise problem(429, "hash_busy", "登录服务繁忙，请稍后重试", headers={"Retry-After": "2"})
        try:
            yield
        finally:
            self.hash_slots.release()

    def cleanup(self, force=False):
        with self.cleanup_lock:
            if not force and time.monotonic() < self.next_cleanup:
                return
            with self.sessions.begin() as session:
                session.execute(delete(UserSession).where(UserSession.expires_at <= self.now()))
            self.next_cleanup = time.monotonic() + 300

    def current(self, request):
        token = request.cookies.get(COOKIE, "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None
        with self.sessions() as session:
            stored = session.get(UserSession, token_digest(token))
            if stored is None or as_utc(stored.expires_at) <= self.now():
                return None
            user = session.get(User, stored.user_id)
            return public_user(user) if user else None

    def issue(self, session, user_id, request):
        previous = request.cookies.get(COOKIE)
        if previous:
            session.execute(delete(UserSession).where(UserSession.token_hash == token_digest(previous)))
        token = secrets.token_urlsafe(32)
        now = self.now()
        session.add(UserSession(token_hash=token_digest(token), user_id=user_id, created_at=now,
                                expires_at=now + timedelta(seconds=self.settings.auth_session_seconds)))
        return token

    def cookie(self, response, token):
        response.set_cookie(COOKIE, token, max_age=self.settings.auth_session_seconds,
                            httponly=True, secure=self.settings.auth_cookie_secure, samesite="lax", path="/")

    @contextmanager
    def write(self, request, user_id, *, expected_hash=None, require_session=True):
        """All account writes coordinate on user -> session -> application data."""
        with self.sessions() as session:
            if session.bind.dialect.name == "sqlite":
                session.connection().exec_driver_sql("BEGIN IMMEDIATE")
            else:
                session.execute(text("SET LOCAL lock_timeout = '3s'"))
            try:
                user = session.scalar(select(User).where(User.id == user_id).with_for_update())
                if user is None:
                    raise problem(401, "login_required", "登录状态已失效，请重新登录")
                if require_session:
                    stored = session.scalar(select(UserSession).where(UserSession.token_hash == token_digest(request.cookies.get(COOKIE, ""))).with_for_update())
                    if stored is None or stored.user_id != user_id or as_utc(stored.expires_at) <= self.now():
                        raise problem(401, "login_required", "登录状态已失效，请重新登录")
                if expected_hash is not None and user.password_hash != expected_hash:
                    raise problem(409, "password_changed", "密码已发生变化，请重新登录核实")
                yield session, user
                session.commit()
            except BaseException:
                session.rollback()
                raise

    def clear_cookie(self, response):
        response.delete_cookie(COOKIE, path="/", httponly=True, secure=self.settings.auth_cookie_secure, samesite="lax")


def token_digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def public_user(user):
    return {"id": user.id, "username": user.username, "nickname": user.nickname, "avatar_id": user.avatar_id or "kiwi-default"}


def get_current_user(request: Request):
    user = request.app.state.auth.current(request)
    if user is None:
        raise problem(401, "login_required", "登录状态已失效，请重新登录")
    return user


router = APIRouter(prefix="/api/v1/auth", tags=["账号"])


@router.get("/me")
def me(request: Request):
    return {"user": request.app.state.auth.current(request)}


@router.post("/register", status_code=201)
def register(body: RegisterInput, request: Request, response: Response):
    auth = request.app.state.auth
    ip = request.client.host if request.client else "unknown"
    auth.limiter.take(("register", ip), auth.settings.auth_register_limit, 600)
    with auth.hashing():
        encoded = passwords.hash(body.password)
    user = User(id=str(uuid.uuid4()), username=body.username, username_key=body.username.lower(),
                password_hash=encoded, created_at=auth.now())
    auth.cleanup()
    with auth.sessions.begin() as session:
        insert = pg_insert if session.bind.dialect.name == "postgresql" else sqlite_insert
        created = session.scalar(insert(User).values(id=user.id, username=user.username, username_key=user.username_key,
            password_hash=encoded, created_at=user.created_at).on_conflict_do_nothing(index_elements=["username_key"]).returning(User.id))
        if created is None:
            raise problem(409, "username_taken", "用户名已被使用", ["username"])
        token = auth.issue(session, user.id, request)
    auth.cookie(response, token)
    return {"user": public_user(user)}


@router.post("/login")
def login(body: LoginInput, request: Request, response: Response):
    auth = request.app.state.auth
    ip = request.client.host if request.client else "unknown"
    auth.limiter.take(("login_ip", ip), auth.settings.auth_login_ip_limit, 300)
    reservation = auth.limiter.take(("login_failure", ip, body.username.lower()), auth.settings.auth_login_failure_limit, 300)
    with auth.sessions() as session:
        user = session.scalar(select(User).where(User.username_key == body.username.lower()))
    with auth.hashing():
        valid = passwords.verify(body.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        raise problem(401, "invalid_credentials", "用户名或密码不正确")
    auth.limiter.refund(reservation)
    auth.cleanup()
    with auth.write(request, user.id, expected_hash=user.password_hash, require_session=False) as (session, current_user):
        token = auth.issue(session, user.id, request)
        result = public_user(current_user)
    auth.cookie(response, token)
    return {"user": result}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response):
    auth = request.app.state.auth
    token = request.cookies.get(COOKIE)
    user = auth.current(request)
    if token and user:
        with auth.write(request, user["id"], require_session=False) as (session, _):
            session.execute(delete(UserSession).where(UserSession.token_hash == token_digest(token)))
    auth.clear_cookie(response)
