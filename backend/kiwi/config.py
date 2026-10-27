from pathlib import Path
import os
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(os.environ.get("KIWI_PROJECT_ROOT", str(Path(__file__).resolve().parents[2]))).resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")
    ai_mode: Literal["live", "baseline"] = "live"
    database_url: str = f"sqlite:///{(ROOT / '.local/kiwi.db').as_posix()}"
    deepseek_api_key: SecretStr = SecretStr("")
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    dashscope_api_key: SecretStr = SecretStr("")
    embedding_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    embedding_model: str = "text-embedding-v4"
    embedding_dimension: Literal[1024] = 1024
    request_timeout: float = Field(default=45, ge=1, le=120)
    call_timeout: float = Field(default=18, ge=0.1, le=45)
    max_retries: int = Field(default=1, ge=0, le=2)
    min_similarity: float = Field(default=0.40, ge=0, le=1)
    semantic_only_threshold: float = Field(default=0.65, ge=0, le=1)
    recommendation_scan_limit: int = Field(default=500, ge=1, le=5000)
    recommendation_scan_batch: int = Field(default=50, ge=1, le=100)
    feedback_state_limit: int = Field(default=1000, ge=1, le=10000)
    feedback_write_limit: int = Field(default=60, ge=1, le=60)
    crawl_pages_per_source: int = Field(default=5, ge=1, le=20)
    crawl_max_pages: int = Field(default=25, ge=1, le=25)
    crawl_max_works: int = Field(default=500, ge=1, le=500)
    crawl_interval: float = Field(default=0.5, ge=0.5, le=5)
    crawl_timeout: float = Field(default=300, ge=1, le=300)
    index_timeout: float = Field(default=600, ge=1, le=600)
    refresh_timeout: float = Field(default=900, ge=1, le=900)
    auth_cookie_secure: bool = False
    auth_session_seconds: int = Field(default=604800, ge=60, le=604800)
    auth_allowed_origins: str = "http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8080,http://localhost:8080"
    auth_login_ip_limit: int = Field(default=30, ge=1, le=30)
    auth_login_failure_limit: int = Field(default=5, ge=1, le=5)
    auth_register_limit: int = Field(default=10, ge=1, le=10)
    auth_hash_concurrency: int = Field(default=2, ge=1, le=2)
    auth_limiter_capacity: int = Field(default=10000, ge=10, le=100000)
    auth_password_user_limit: int = Field(default=5, ge=1, le=5)
    auth_password_ip_limit: int = Field(default=20, ge=1, le=20)
    media_root: Path = ROOT / ".local/media/previews"
    media_delivery_mode: Literal["app", "nginx"] = "app"
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    preview_source_max_bytes: int = Field(default=200 * 1024 * 1024, gt=0)
    preview_output_max_bytes: int = Field(default=20 * 1024 * 1024, gt=0)
    preview_probe_timeout: float = Field(default=10, gt=0, le=60)
    preview_process_timeout: float = Field(default=120, gt=0, le=600)
    preview_auto_enabled: bool = True
    preview_workers: int = Field(default=2, ge=1, le=3)
    preview_browser_channel: str = "msedge" if os.name == "nt" else "chromium"
    preview_node_path: str = "node"
    preview_playwright_module: str = ""
    preview_fetch_timeout: float = Field(default=60, ge=5, le=180)
    preview_retry_seconds: float = Field(default=60, ge=1, le=3600)
    preview_attempts: int = Field(default=3, ge=1, le=3)

    @field_validator("media_root")
    @classmethod
    def resolve_media_root(cls, value):
        return (value if value.is_absolute() else ROOT / value).resolve()

    @model_validator(mode="after")
    def validate_auth_origins(self):
        from urllib.parse import urlsplit
        for origin in self.auth_allowed_origins.split(","):
            parsed = urlsplit(origin.strip())
            if (parsed.scheme not in ("http", "https") or not parsed.hostname or "*" in parsed.hostname or parsed.username
                    or parsed.password or parsed.path or parsed.query or parsed.fragment):
                raise ValueError("AUTH_ALLOWED_ORIGINS 必须是完整来源，不能含路径或通配符")
            if parsed.port == 0:
                raise ValueError("AUTH_ALLOWED_ORIGINS 的端口必须为 1～65535")
            if not self.auth_cookie_secure and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}):
                raise ValueError("仅回环 HTTP 开发来源允许 AUTH_COOKIE_SECURE=false")
        return self

    @property
    def configured(self):
        return self.ai_mode == "baseline" or bool(
            self.deepseek_api_key.get_secret_value() and self.dashscope_api_key.get_secret_value()
        )
