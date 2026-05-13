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

    def validate_for_runtime(self) -> None:
        """Refuse to boot in prod when load-bearing secrets are missing (F-0.7).

        In dev we warn but proceed — keeps the local loop fast. In staging/prod
        the engine fail-closes per docs/Specs.md §13.1 rather than serving
        verdicts against an unconfigured LLM provider.
        """
        if not self.gemini_api_key:
            if self.is_dev:
                # Dev: deferred — the GeminiClient itself raises when actually
                # instantiated, so health probes and unit tests still pass.
                return
            raise RuntimeError(
                f"GEMINI_API_KEY is required in env={self.env}. Set it in engine/.env "
                "or via deployment secrets. See docs/13-Infra.md."
            )
        if not self.is_dev and not self.engine_shared_secret:
            raise RuntimeError(
                f"ENGINE_SHARED_SECRET is required in env={self.env} (HMAC enforcement)."
            )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
