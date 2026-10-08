"""File upload endpoint for client-side audio analysis."""

import asyncio
import logging
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

import aiofiles
from fastapi import APIRouter, BackgroundTasks, File, Form, Header, Request, UploadFile

from app.auth import check_app_key
from app.db import get_skip_map, set_status
from app.models.schemas import AnalyzeEpisodeResponse
from app.rate_limit import enforce_analyze_rate_limit
from app.services.analyze_pipeline import run_analyze_from_file
from app.services.audio_fingerprint import file_fingerprints

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["analyze"])


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _progress_kwargs(row: dict[str, Any] | None) -> dict[str, Any]:
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
    audio_file: Annotated[UploadFile, File()],
    episode_guid: Annotated[str, Form()],
    title: Annotated[str | None, Form()] = None,
    duration_ms: Annotated[int | None, Form()] = None,
    feed_url: Annotated[str | None, Form()] = None,
    audio_url: Annotated[str | None, Form()] = None,
    force: Annotated[bool, Form()] = False,
    x_app_key: Annotated[str | None, Header()] = None,
    sync: bool = False,
) -> AnalyzeEpisodeResponse:
    """
    Analyze an episode from uploaded audio file (client-side download).
    
    This ensures the analyzed audio matches what the player will play,
    avoiding dynamic ad insertion mismatches.
    """
    enforce_analyze_rate_limit(request)
    check_app_key(x_app_key)
    

    # Save uploaded file to temp location
    suffix = Path(audio_file.filename or "audio.mp3").suffix or ".mp3"
    if len(suffix) > 8:
        suffix = ".mp3"
    
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
        tmp_path = Path(tmp_file.name)
    
    try:
        # Stream upload to disk
        async with aiofiles.open(tmp_path, "wb") as f:
            chunk_size = 1024 * 1024  # 1MB chunks
            while chunk := await audio_file.read(chunk_size):
                await f.write(chunk)
        
        audio_sha256, audio_md5 = await asyncio.to_thread(file_fingerprints, tmp_path)
        logger.info(
            "Received upload for %s: %s bytes (sha256=%s), checking cached analysis",
            episode_guid,
            tmp_path.stat().st_size,
            audio_sha256,
        )

        # A GUID is not a stable identity for dynamically inserted audio. Only
        # reuse a map after matching the exact uploaded bytes.
        existing = await get_skip_map(episode_guid)
        if existing and not force and existing.get("audio_sha256") == audio_sha256:
            tmp_path.unlink(missing_ok=True)
            if existing["status"] == "ready":
                logger.info("Returning matching cached skip map for %s", episode_guid)
                return AnalyzeEpisodeResponse(
                    status="ready",
                    episode_guid=episode_guid,
                    segments=existing.get("segments") or [],
                    model=existing.get("model"),
                    analyzed_at=_parse_dt(existing.get("analyzed_at")),
                    audio_url=existing.get("audio_url"),
                    analyzed_audio_size_bytes=existing.get("analyzed_audio_size_bytes"),
                    analyzed_audio_duration_ms=existing.get("analyzed_audio_duration_ms"),
                    audio_md5=existing.get("audio_md5"),
                    **_progress_kwargs(existing),
                )
            if existing["status"] == "pending":
                return AnalyzeEpisodeResponse(
                    status="queued",
                    episode_guid=episode_guid,
                    message="Analysis already in progress for this audio",
                    **_progress_kwargs(existing),
                )

        if sync:
            result = await run_analyze_from_file(
                episode_guid=episode_guid,
                audio_path=tmp_path,
                audio_url=audio_url,
                title=title,
                duration_ms=duration_ms,
                feed_url=feed_url,
                audio_sha256=audio_sha256,
                audio_md5=audio_md5,
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
                audio_md5=result.get("audio_md5"),
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
            audio_sha256=audio_sha256,
            audio_md5=audio_md5,
            title=title,
            duration_ms=duration_ms,
            feed_url=feed_url,
        )
        
        queued = await get_skip_map(episode_guid)
        return AnalyzeEpisodeResponse(
            status="queued",
            episode_guid=episode_guid,
            message="Analysis queued (client upload)",
            audio_md5=audio_md5,
            **_progress_kwargs(queued),
        )
        
    except Exception:
        # Clean up on error
        tmp_path.unlink(missing_ok=True)
        logger.exception("Upload analysis failed for %s", episode_guid)
        raise
