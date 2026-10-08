from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Header, Request

from app.auth import check_app_key
from app.db import get_skip_map, set_status
from app.models.schemas import AnalyzeEpisodeRequest, AnalyzeEpisodeResponse
from app.rate_limit import enforce_analyze_rate_limit
from app.services.analyze_pipeline import run_analyze


router = APIRouter(prefix="/v1", tags=["analyze"])


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _progress_kwargs(row: dict | None) -> dict:
    if not row:
        return {}
    return {
        "stage": row.get("stage"),
        "stage_label": row.get("stage_label"),
        "progress_pct": row.get("progress_pct"),
        "eta_seconds": row.get("eta_seconds"),
        "started_at": _parse_dt(row.get("started_at")) if isinstance(row.get("started_at"), str) else row.get("started_at"),
    }


@router.post("/analyze-episode", response_model=AnalyzeEpisodeResponse)
async def analyze_episode(
    body: AnalyzeEpisodeRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    x_app_key: str | None = Header(default=None),
    sync: bool = False,
) -> AnalyzeEpisodeResponse:
    """Queue or sync-analyze an episode, validating cached audio after download."""
    # Per-IP limit before auth so stolen-key / brute traffic cannot burn OpenRouter.
    enforce_analyze_rate_limit(request)
    check_app_key(x_app_key)

    existing = await get_skip_map(body.episode_guid)
    if existing and existing["status"] == "pending" and not body.force:
        return AnalyzeEpisodeResponse(
            status="queued",
            episode_guid=body.episode_guid,
            message="Analysis already in progress",
            **_progress_kwargs(existing),
        )

    await set_status(
        body.episode_guid,
        "pending",
        audio_url=body.audio_url,
        feed_url=body.feed_url,
        title=body.title,
        stage="queued",
        duration_ms=body.duration_ms,
        reset_started=True,
    )

    if sync:
        result = await run_analyze(
            episode_guid=body.episode_guid,
            audio_url=body.audio_url,
            title=body.title,
            duration_ms=body.duration_ms,
            feed_url=body.feed_url,
            force=body.force,
        )
        return AnalyzeEpisodeResponse(
            status=result["status"],
            episode_guid=body.episode_guid,
            segments=result.get("segments") or [],
            model=result.get("model"),
            analyzed_at=_parse_dt(result.get("analyzed_at")),
            message=result.get("message"),
            audio_url=result.get("audio_url"),
            analyzed_audio_size_bytes=result.get("analyzed_audio_size_bytes"),
            analyzed_audio_duration_ms=result.get("analyzed_audio_duration_ms"),
            audio_md5=result.get("audio_md5"),
            **_progress_kwargs(result),
        )

    background_tasks.add_task(
        run_analyze,
        episode_guid=body.episode_guid,
        audio_url=body.audio_url,
        title=body.title,
        duration_ms=body.duration_ms,
        feed_url=body.feed_url,
        force=body.force,
    )
    queued = await get_skip_map(body.episode_guid)
    return AnalyzeEpisodeResponse(
        status="queued",
        episode_guid=body.episode_guid,
        message="Analysis queued",
        **_progress_kwargs(queued),
    )
