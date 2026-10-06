"""File upload endpoint for client-side audio analysis."""

import logging
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, Header, Request, UploadFile

from app.auth import check_app_key
from app.db import get_skip_map, set_status
from app.models.schemas import AnalyzeEpisodeResponse
from app.rate_limit import enforce_analyze_rate_limit
from app.services.analyze_pipeline import run_analyze_from_file

logger = logging.getLogger(__name__)

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


@router.post("/analyze-episode-upload", response_model=AnalyzeEpisodeResponse)
async def analyze_episode_upload(
    request: Request,
    background_tasks: BackgroundTasks,
    audio_file: UploadFile = File(...),
    episode_guid: str = Form(...),
    title: str | None = Form(None),
    duration_ms: int | None = Form(None),
    feed_url: str | None = Form(None),
    audio_url: str | None = Form(None),
    force: bool = Form(False),
    x_app_key: str | None = Header(default=None),
    sync: bool = False,
) -> AnalyzeEpisodeResponse:
    """
    Analyze an episode from uploaded audio file (client-side download).
    
    This ensures the analyzed audio matches what the player will play,
    avoiding dynamic ad insertion mismatches.
    """
    enforce_analyze_rate_limit(request)
    check_app_key(x_app_key)
    
    # Check cache (unless force)
    existing = await get_skip_map(episode_guid)
    if existing and existing["status"] == "ready" and not force:
        logger.info("Returning cached skip map for %s (upload endpoint)", episode_guid)
        return AnalyzeEpisodeResponse(
            status="ready",
            episode_guid=episode_guid,
            segments=existing.get("segments") or [],
            model=existing.get("model"),
            analyzed_at=_parse_dt(existing.get("analyzed_at")),
            audio_url=existing.get("audio_url"),
            analyzed_audio_size_bytes=existing.get("analyzed_audio_size_bytes"),
            analyzed_audio_duration_ms=existing.get("analyzed_audio_duration_ms"),
            **_progress_kwargs(existing),
        )
    
    if existing and existing["status"] == "pending" and not force:
        return AnalyzeEpisodeResponse(
            status="queued",
            episode_guid=episode_guid,
            message="Analysis already in progress",
            **_progress_kwargs(existing),
        )
    
    # Save uploaded file to temp location
    suffix = Path(audio_file.filename or "audio.mp3").suffix or ".mp3"
    if len(suffix) > 8:
        suffix = ".mp3"
    
    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path = Path(tmp_file.name)
    tmp_file.close()
    
    try:
        # Stream upload to disk
        with tmp_path.open("wb") as f:
            chunk_size = 1024 * 1024  # 1MB chunks
            while chunk := await audio_file.read(chunk_size):
                f.write(chunk)
        
        logger.info(
            "Received upload for %s: %s bytes, starting analysis",
            episode_guid,
            tmp_path.stat().st_size,
        )
        
        if sync:
            result = await run_analyze_from_file(
                episode_guid=episode_guid,
                audio_path=tmp_path,
                audio_url=audio_url,
                title=title,
                duration_ms=duration_ms,
                feed_url=feed_url,
            )
            return AnalyzeEpisodeResponse(
                status=result["status"],
                episode_guid=episode_guid,
                segments=result.get("segments") or [],
                model=result.get("model"),
                analyzed_at=_parse_dt(result.get("analyzed_at")),
                message=result.get("message"),
                audio_url=result.get("audio_url"),
                analyzed_audio_size_bytes=result.get("analyzed_audio_size_bytes"),
                analyzed_audio_duration_ms=result.get("analyzed_audio_duration_ms"),
                **_progress_kwargs(result),
            )
        
        # Background task - file will be deleted by analyze pipeline
        await set_status(
            episode_guid,
            "pending",
            audio_url=audio_url,
            feed_url=feed_url,
            title=title,
            stage="queued",
            duration_ms=duration_ms,
            reset_started=True,
        )
        background_tasks.add_task(
            run_analyze_from_file,
            episode_guid=episode_guid,
            audio_path=tmp_path,
            audio_url=audio_url,
            title=title,
            duration_ms=duration_ms,
            feed_url=feed_url,
        )
        
        queued = await get_skip_map(episode_guid)
        return AnalyzeEpisodeResponse(
            status="queued",
            episode_guid=episode_guid,
            message="Analysis queued (client upload)",
            **_progress_kwargs(queued),
        )
        
    except Exception:
        # Clean up on error
        tmp_path.unlink(missing_ok=True)
        logger.exception("Upload analysis failed for %s", episode_guid)
        raise
