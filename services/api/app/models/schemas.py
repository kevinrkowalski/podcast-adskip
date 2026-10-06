from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AdSegment(BaseModel):
    start_ms: int = Field(..., ge=0)
    end_ms: int = Field(..., ge=0)
    type: Literal["sponsor", "midroll", "preroll", "postroll", "crosspromo", "network", "unknown"] = "unknown"
    confidence: float = Field(0.5, ge=0.0, le=1.0)


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
    analyzed_audio_size_bytes: int | None = Field(default=None, ge=0)
    analyzed_audio_duration_ms: int | None = Field(default=None, ge=0)


class SkipMapResponse(AnalyzeProgressFields):
    status: Literal["ready", "pending", "missing", "error"]
    episode_guid: str
    segments: list[AdSegment] = []
    model: str | None = None
    analyzed_at: datetime | None = None
    message: str | None = None
    audio_url: str | None = None
    analyzed_audio_size_bytes: int | None = Field(default=None, ge=0)
    analyzed_audio_duration_ms: int | None = Field(default=None, ge=0)


class HealthResponse(BaseModel):
    status: str = "ok"
    openrouter_configured: bool = False
    groq_configured: bool = False  # legacy
    llm_configured: bool = False
    mock_mode: bool = True
    version: str = "0.1.0"
