from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Primary backend: OpenRouter (STT + chat)
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # Legacy Groq (optional; demoted — use OpenRouter instead)
    groq_api_key: str = ""

    gemini_api_key: str = ""
    llm_api_key: str = ""
    # openrouter (default) | groq | gemini | stub
    llm_provider: str = "openrouter"
    app_key: str = ""  # optional X-App-Key for personal auth
    require_app_key: bool = False  # when true, empty app_key → 503 on protected routes
    # In-memory rate limit for POST /v1/analyze-episode (OpenRouter spend guard)
    analyze_rate_limit: int = 10  # max requests per IP per window
    analyze_rate_window_seconds: int = 3600  # sliding window length
    cors_origins: str = "*"
    database_path: str = "data/skip_maps.db"
    mock_analyze: bool = False  # force stub even if keys present
    # OpenRouter multipart STT cap is 25 MB; larger downloads are ffmpeg-chunked.
    # Legacy Groq allowed ~100 MB — raise only if using GROQ_API_KEY directly.
    max_audio_mb: int = 25
    # OpenRouter STT model slug (Whisper-class with verbose_json segments)
    whisper_model: str = "openai/whisper-large-v3-turbo"
    # Cheap OpenRouter chat model for ad labeling
    openrouter_llm_model: str = "google/gemini-2.5-flash"
    # Legacy Groq model ids (only used when llm_provider=groq / GROQ_API_KEY path)
    groq_llm_model: str = "llama-3.3-70b-versatile"
    gemini_model: str = "gemini-2.5-flash"
    # Optional OpenRouter attribution headers
    openrouter_http_referer: str = "https://github.com/podcast-adskip"
    openrouter_app_title: str = "podcast-adskip"

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def has_openrouter(self) -> bool:
        return bool(self.openrouter_api_key) and not self.mock_analyze

    @property
    def has_groq(self) -> bool:
        """Legacy Groq-only path when OpenRouter key is absent."""
        return bool(self.groq_api_key) and not self.mock_analyze and not self.openrouter_api_key

    @property
    def has_real_stt(self) -> bool:
        """True when a paid STT backend can run (OpenRouter preferred, else legacy Groq)."""
        if self.mock_analyze:
            return False
        return bool(self.openrouter_api_key) or bool(self.groq_api_key)

    @property
    def gemini_ready(self) -> bool:
        return bool(self.gemini_api_key or (self.llm_provider == "gemini" and self.llm_api_key))

    @property
    def openrouter_llm_ready(self) -> bool:
        return bool(self.openrouter_api_key or (self.llm_provider == "openrouter" and self.llm_api_key))

    @property
    def groq_llm_ready(self) -> bool:
        return bool(self.groq_api_key or (self.llm_provider == "groq" and self.llm_api_key))

    @property
    def has_llm(self) -> bool:
        """True when any labeling LLM can run."""
        if self.mock_analyze:
            return False
        if self.llm_provider == "stub":
            return False
        if self.llm_provider == "gemini":
            return self.gemini_ready or self.openrouter_llm_ready or self.groq_llm_ready
        if self.llm_provider == "groq":
            return self.groq_llm_ready or self.openrouter_llm_ready
        # default openrouter
        return self.openrouter_llm_ready or self.groq_llm_ready


@lru_cache
def get_settings() -> Settings:
    return Settings()
