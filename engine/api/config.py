"""Engine settings — loaded from environment / .env.

Spec: docs/Specs.md §5, docs/13-Infra.md
Strict-mode refusal (no GEMINI_API_KEY → exit) lands in F-0.7.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # === Runtime ===
    env: Literal["development", "staging", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # === LLM ===
    gemini_api_key: str = ""
    model_reasoner: str = "gemini-2.5-pro"
    model_summarizer: str = "gemini-2.5-flash"

    # === Datastores ===
    database_url: str = "postgresql+asyncpg://modpilot:modpilot@localhost:5432/modpilot"
    redis_url: str = "redis://localhost:6379/0"

    # === HMAC ===
    engine_shared_secret: str = ""

    # === Budgets ===
    daily_spend_cap_usd: float = Field(default=15.0, ge=0)
    daily_spend_cap_per_sub_usd: float = Field(default=2.0, ge=0)

    # === Feature flags ===
    enable_live_llm_tests: bool = False

    @property
    def is_dev(self) -> bool:
        return self.env == "development"

    @property
    def hmac_enforced(self) -> bool:
        """In dev with no secret set, middleware logs and lets requests through."""
        return bool(self.engine_shared_secret) and not self.is_dev


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
