from pathlib import Path
import os
from typing import Literal

from pydantic import Field, SecretStr
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

    @property
    def configured(self):
        return self.ai_mode == "baseline" or bool(
            self.deepseek_api_key.get_secret_value() and self.dashscope_api_key.get_secret_value()
        )

