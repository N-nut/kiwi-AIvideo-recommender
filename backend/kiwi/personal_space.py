"""Session-owned profiles, request-local interest summaries and password changes."""
import json
import unicodedata
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from . import auth as auth_module
from .auth import get_current_user, problem, public_user
from .config import ROOT
from .database import Favorite, User, UserSession, Work
from .home_recommendations import build_profile

AVATARS = {item["id"] for item in json.loads((ROOT / "data/avatar-presets.json").read_text(encoding="utf-8"))}
router = APIRouter(prefix="/api/v1/me", tags=["个人空间"])
CurrentUser = Annotated[dict, Depends(get_current_user)]


def nickname_parts(value):
    def forbidden(text):
        return any(unicodedata.category(c).startswith("C") or c in "\u2028\u2029" for c in text)
    if forbidden(value):
        raise ValueError("昵称不能含换行或控制字符")
    display = value.strip()
    key = unicodedata.normalize("NFKC", display).strip().casefold()
    if not 1 <= len(display) <= 20 or not key or forbidden(key):
        raise ValueError("昵称须为 1～20 个字符，不能含换行或控制字符")
    return display, key


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    nickname: str = Field(default=None, max_length=200)
    avatar_id: str = Field(default=None, max_length=32)

    @field_validator("nickname")
    @classmethod
    def valid_nickname(cls, value):
        return nickname_parts(value)[0]

    @field_validator("avatar_id")
    @classmethod
    def valid_avatar(cls, value):
        if value not in AVATARS:
            raise ValueError("请选择预设头像")
        return value

    @model_validator(mode="after")
    def not_empty(self):
        if not self.model_fields_set:
            raise ValueError("请提交要修改的资料")
        return self


class PasswordInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    current_password: str = Field(min_length=8, max_length=64, repr=False)
    new_password: str = Field(min_length=8, max_length=64, repr=False)
    confirm_password: str = Field(min_length=8, max_length=64, repr=False)

    @model_validator(mode="after")
    def different_and_confirmed(self):
        if self.new_password != self.confirm_password:
            raise problem(422, "validation_error", "两次新密码不一致", ["confirm_password"])
        if self.new_password == self.current_password:
            raise problem(422, "validation_error", "新密码不能与当前密码相同", ["new_password"])
        return self


def no_query(request):
    if request.query_params:
        raise problem(422, "validation_error", "此操作不接受额外查询参数")


@router.get("/profile")
def profile(request: Request, user: CurrentUser):
    no_query(request)
    return {"request_id": request.state.request_id, "profile": user}


@router.patch("/profile")
def update_profile(body: ProfileInput, request: Request, user: CurrentUser):
    no_query(request)
    try:
        with request.app.state.auth.write(request, user["id"]) as (_, stored):
            if "nickname" in body.model_fields_set:
                stored.nickname, stored.nickname_key = nickname_parts(body.nickname)
            if "avatar_id" in body.model_fields_set:
                stored.avatar_id = body.avatar_id
            result = public_user(stored)
    except IntegrityError as exc:
        original = exc.orig
        if (getattr(getattr(original, "diag", None), "constraint_name", None) == "uq_users_nickname_key"
                or "UNIQUE constraint failed: users.nickname_key" in str(original)):
            raise problem(409, "nickname_taken", "昵称已被使用，请换一个", ["nickname"]) from None
        raise
    return {"request_id": request.state.request_id, "profile": result}


def summarize(rows):
    rows = {row["id"]: row for row in rows}.values()
    total = len(rows)
    available = sum(row.get("review_status") == "approved" for row in rows)
    profile = build_profile(rows)
    def top(counter):
        return [{"label": label, "count": count} for label, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))[:5]]
    status = "no_favorites" if not total else "no_valid_favorites" if not profile.count else "no_tags" if not profile.sufficient else "ready"
    return {"favorites": {"total": total, "available": available, "unavailable": total - available},
            "interest": {"status": status, "analyzed_count": profile.count, "content_types": top(profile.content_types),
                         "genres": top(profile.genres), "themes": top(profile.themes)}}


@router.get("/space-summary")
def space_summary(request: Request, user: CurrentUser):
    no_query(request)
    with request.app.state.sessions() as session:
        rows = session.execute(select(Favorite.work_id.label("id"), Work.review_status, Work.source_meta, Work.genres, Work.themes)
            .outerjoin(Work, Work.id == Favorite.work_id).where(Favorite.user_id == user["id"])).mappings().all()
    return {"request_id": request.state.request_id, **summarize(rows)}


@router.post("/password", status_code=204)
def change_password(body: PasswordInput, request: Request, response: Response, user: CurrentUser):
    no_query(request)
    auth = request.app.state.auth
    auth.limiter.take(("password_user", user["id"]), auth.settings.auth_password_user_limit, 600)
    auth.limiter.take(("password_ip", request.client.host if request.client else "unknown"), auth.settings.auth_password_ip_limit, 600)
    with auth.sessions() as session:
        old_hash = session.get(User, user["id"]).password_hash
    with auth.hashing():
        if not auth_module.passwords.verify(body.current_password, old_hash):
            raise problem(400, "invalid_current_password", "当前密码不正确", ["current_password"])
        encoded = auth_module.passwords.hash(body.new_password)
    with auth.write(request, user["id"], expected_hash=old_hash) as (session, stored):
        stored.password_hash = encoded
        session.execute(delete(UserSession).where(UserSession.user_id == user["id"]))
    auth.clear_cookie(response)
