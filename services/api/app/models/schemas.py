from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


LEGACY_SEGMENT_TYPE_MAP = {
    "sponsor": "advertisement",
    "midroll": "advertisement",
    "preroll": "advertisement",
    "postroll": "advertisement",
    "crosspromo": "self_promotion",
    "network": "self_promotion",
    "unknown": "advertisement",
}

CANONICAL_SEGMENT_TYPES = frozenset({"advertisement", "intro_outro", "self_promotion"})


def map_legacy_segment_type(legacy_type: str) -> str:
    """Map legacy segment types to consolidated types (advertisement/intro_outro/self_promotion)."""
    if legacy_type in CANONICAL_SEGMENT_TYPES:
        return legacy_type
    return LEGACY_SEGMENT_TYPE_MAP.get(legacy_type, "advertisement")


class AdSegment(BaseModel):
    start_ms: int = Field(..., ge=0)
    end_ms: int = Field(..., ge=0)
    type: Literal["advertisement", "intro_outro", "self_promotion"] = "advertisement"
    confidence: float = Field(0.75, ge=0.0, le=1.0)

    @field_validator("type", mode="before")
    @classmethod
    def _coerce_legacy_type(cls, v: object) -> object:
        if isinstance(v, str):
            return map_legacy_segment_type(v)
        return v


class AnalyzeEpisodeRequest(BaseModel):
    episode_guid: str = Field(..., min_length=1)
    audio_url: str = Field(..., min_length=1)
    title: str | None = None
    duration_ms: int | None = None
    feed_url: str | None = None
    force: bool = False


AnalyzeStage = Literal[
    "queued",
    "downloading",
    "transcribing",
    "labeling",
    "saving",
    "ready",
    "error",
]


class AnalyzeProgressFields(BaseModel):
    """Lightweight progress the client can show (ETA-first, honest stages)."""

    stage: AnalyzeStage | None = None
    stage_label: str | None = None
    progress_pct: float | None = Field(default=None, ge=0.0, le=100.0)
    eta_seconds: int | None = Field(default=None, ge=0)
    started_at: datetime | None = None


class AnalyzeEpisodeResponse(AnalyzeProgressFields):
    status: Literal["ready", "queued", "pending", "error"]
    episode_guid: str
    segments: list[AdSegment] = []
    model: str | None = None
    analyzed_at: datetime | None = None
    message: str | None = None
    audio_url: str | None = None
    analyzed_audio_size_bytes: int | None = None
    analyzed_audio_duration_ms: int | None = None


class SkipMapResponse(AnalyzeProgressFields):
    status: Literal["ready", "pending", "missing", "error"]
    episode_guid: str
    segments: list[AdSegment] = []
    model: str | None = None
    analyzed_at: datetime | None = None
    message: str | None = None
    audio_url: str | None = None
    analyzed_audio_size_bytes: int | None = None
    analyzed_audio_duration_ms: int | None = None


class HealthResponse(BaseModel):
    status: str = "ok"
    openrouter_configured: bool = False
    groq_configured: bool = False  # legacy
    llm_configured: bool = False
    mock_mode: bool = True
    version: str = "0.1.0"
