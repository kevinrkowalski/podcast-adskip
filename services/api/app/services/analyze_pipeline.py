"""Orchestrate download → Whisper → LLM labels → SQLite cache."""

from __future__ import annotations

import asyncio
import logging
import math
import uuid
from pathlib import Path
from typing import Any

from app.config import Settings, get_settings
from app.db import RunSuperseded, get_skip_map, save_skip_map, set_status
from app.db.learning import get_show_notes, save_transcript
from app.services.audio_fingerprint import file_fingerprints
from app.services.show_notes import notes_prompt_block, show_key
from app.services.detect_ads import heuristic_segments, label_ads_llm
from app.services.transcribe import download_audio, stub_transcript, transcribe_audio

logger = logging.getLogger(__name__)


def _transcript_duration_ms(
    transcript: dict[str, Any], fallback_ms: int | None = None
) -> int | None:
    duration = transcript.get("duration")
    if duration is not None:
        try:
            seconds = float(duration)
            if math.isfinite(seconds) and seconds >= 0:
                return round(seconds * 1000)
        except (TypeError, ValueError):
            pass
    return fallback_ms


def _llm_model_label(settings: Settings) -> str:
    if settings.llm_provider == "gemini" and settings.gemini_ready:
        return settings.gemini_model
    if settings.llm_provider == "groq" and settings.groq_llm_ready:
        return settings.groq_llm_model
    if settings.openrouter_llm_ready:
        return settings.openrouter_llm_model
    if settings.groq_llm_ready:
        return settings.groq_llm_model
    if settings.gemini_ready:
        return settings.gemini_model
    return "heuristic"


async def _stage(
    episode_guid: str,
    stage: str,
    *,
    audio_url: str | None = None,
    feed_url: str | None = None,
    title: str | None = None,
    duration_ms: int | None = None,
    reset_started: bool = False,
    pending_audio_sha256: str | None = None,
    run_id: str | None = None,
) -> None:
    await set_status(
        episode_guid,
        "pending",
        audio_url=audio_url,
        feed_url=feed_url,
        title=title,
        stage=stage,
        duration_ms=duration_ms,
        reset_started=reset_started,
        pending_audio_sha256=pending_audio_sha256,
        run_id=run_id,
    )


async def _learned_notes(feed_url: str | None, podcast_title: str | None) -> str | None:
    """Prompt block of notes learned from this show's reviewed reports (None if none)."""
    try:
        return notes_prompt_block(await get_show_notes(show_key(feed_url, podcast_title)))
    except Exception:
        logger.exception("Could not load learned show notes; analyzing without them")
        return None


async def _cache_transcript(
    episode_guid: str, transcript: dict[str, Any], audio_sha256: str | None, audio_md5: str | None
) -> None:
    """Keep the transcript so ad reports on this episode can be reviewed later."""
    try:
        await save_transcript(episode_guid, transcript, audio_sha256=audio_sha256, audio_md5=audio_md5)
    except Exception:
        logger.exception("Could not cache transcript for %s", episode_guid)


async def _superseded_result(episode_guid: str) -> dict[str, Any]:
    """A newer run owns the row now: report its state instead of writing ours."""
    logger.info("Analysis for %s superseded by a newer run; stopping", episode_guid)
    current = await get_skip_map(episode_guid)
    if current:
        return current
    return {
        "episode_guid": episode_guid,
        "status": "pending",
        "segments": [],
        "model": None,
        "analyzed_at": None,
        "message": None,
        "stage": "queued",
    }


async def _record_failure(episode_guid: str, err: str, run_id: str) -> None:
    try:
        await set_status(episode_guid, "error", error=err, stage="error", run_id=run_id)
    except RunSuperseded:
        # A newer run owns the row; its result must not be replaced by our failure.
        pass


async def run_analyze(
    *,
    episode_guid: str,
    audio_url: str,
    title: str | None = None,
    podcast_title: str | None = None,
    podcast_description: str | None = None,
    episode_description: str | None = None,
    duration_ms: int | None = None,
    feed_url: str | None = None,
    force: bool = False,
    settings: Settings | None = None,
) -> dict[str, Any]:
    settings = settings or get_settings()
    run_id = uuid.uuid4().hex
    existing = await get_skip_map(episode_guid)
    await _stage(
        episode_guid,
        "queued",
        audio_url=audio_url,
        feed_url=feed_url,
        title=title,
        duration_ms=duration_ms,
        reset_started=True,
        run_id=run_id,
    )

    audio_path: Path | None = None
    audio_sha256: str | None = None
    audio_md5: str | None = None
    analyzed_audio_size_bytes: int | None = None
    analyzed_audio_duration_ms: int | None = None
    try:
        if settings.has_real_stt:
            backend = "OpenRouter" if settings.openrouter_api_key else "Groq(legacy)"
            logger.info("Real %s analyze for %s", backend, episode_guid)
            await _stage(
                episode_guid,
                "downloading",
                audio_url=audio_url,
                feed_url=feed_url,
                title=title,
                duration_ms=duration_ms,
                run_id=run_id,
            )
            audio_path = await download_audio(audio_url, settings.max_audio_mb)
            audio_sha256, audio_md5 = await asyncio.to_thread(file_fingerprints, audio_path)
            if (
                not force
                and existing
                and existing.get("analyzed_at")
                and existing.get("audio_sha256") == audio_sha256
            ):
                await set_status(episode_guid, "ready", stage="ready", run_id=run_id)
                cached = await get_skip_map(episode_guid)
                return cached or existing

            await _stage(
                episode_guid,
                "transcribing",
                duration_ms=duration_ms,
                run_id=run_id,
            )
            transcript = await transcribe_audio(audio_path, settings)
            analyzed_audio_size_bytes = audio_path.stat().st_size
            await _cache_transcript(episode_guid, transcript, audio_sha256, audio_md5)
            analyzed_audio_duration_ms = _transcript_duration_ms(transcript, duration_ms)
            model_parts = [settings.whisper_model]

            await _stage(
                episode_guid,
                "labeling",
                duration_ms=duration_ms,
                run_id=run_id,
            )
            if settings.has_llm:
                segments = await label_ads_llm(
                    transcript,
                    settings,
                    duration_ms,
                    podcast_title=podcast_title,
                    podcast_description=podcast_description,
                    episode_title=title,
                    episode_description=episode_description,
                    show_notes=await _learned_notes(feed_url, podcast_title),
                )
                model_parts.append(_llm_model_label(settings))
            else:
                segments = heuristic_segments(transcript, duration_ms)
                model_parts.append("heuristic")
            model = "+".join(model_parts)
        else:
            logger.info("No OPENROUTER_API_KEY (or MOCK_ANALYZE) — using stub transcript")
            await _stage(
                episode_guid,
                "transcribing",
                duration_ms=duration_ms,
                run_id=run_id,
            )
            transcript = stub_transcript(duration_ms)
            analyzed_audio_size_bytes = None
            analyzed_audio_duration_ms = _transcript_duration_ms(transcript, duration_ms)
            await _stage(
                episode_guid,
                "labeling",
                duration_ms=duration_ms,
                run_id=run_id,
            )
            segments = heuristic_segments(transcript, duration_ms)
            model = "stub-whisper+heuristic"

        await _stage(episode_guid, "saving", duration_ms=duration_ms, run_id=run_id)
        result = await save_skip_map(
            episode_guid,
            segments,
            model,
            audio_url=audio_url,
            feed_url=feed_url,
            title=title,
            analyzed_audio_size_bytes=analyzed_audio_size_bytes,
            analyzed_audio_duration_ms=analyzed_audio_duration_ms,
            audio_sha256=audio_sha256,
            audio_md5=audio_md5,
            run_id=run_id,
        )
        logger.info(
            "Analyze ready guid=%s segments=%s model=%s",
            episode_guid,
            len(segments),
            model,
        )
        return result
    except RunSuperseded:
        return await _superseded_result(episode_guid)
    except Exception as exc:
        err = str(exc) or exc.__class__.__name__
        logger.exception("analyze failed for %s: %s", episode_guid, err)
        await _record_failure(episode_guid, err, run_id)
        return {
            "episode_guid": episode_guid,
            "status": "error",
            "segments": [],
            "model": None,
            "analyzed_at": None,
            "message": err,
            "stage": "error",
            "stage_label": "Failed",
            "progress_pct": None,
            "eta_seconds": None,
            "started_at": None,
        }
    finally:
        if audio_path is not None:
            try:
                audio_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not delete temp audio %s", audio_path)


async def run_analyze_from_file(
    *,
    episode_guid: str,
    audio_path: Path,
    audio_url: str | None = None,
    title: str | None = None,
    podcast_title: str | None = None,
    podcast_description: str | None = None,
    episode_description: str | None = None,
    duration_ms: int | None = None,
    feed_url: str | None = None,
    audio_sha256: str | None = None,
    audio_md5: str | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Analyze a client-uploaded audio file and persist its source metadata."""
    settings = settings or get_settings()
    run_id = uuid.uuid4().hex
    if audio_sha256 is None or audio_md5 is None:
        calculated_sha256, calculated_md5 = await asyncio.to_thread(file_fingerprints, audio_path)
        audio_sha256 = audio_sha256 or calculated_sha256
        audio_md5 = audio_md5 or calculated_md5
    try:
        await _stage(
            episode_guid,
            "queued",
            audio_url=audio_url,
            feed_url=feed_url,
            title=title,
            duration_ms=duration_ms,
            reset_started=True,
            pending_audio_sha256=audio_sha256,
            run_id=run_id,
        )
        audio_size_bytes = audio_path.stat().st_size
        if settings.has_real_stt:
            await _stage(episode_guid, "transcribing", duration_ms=duration_ms, run_id=run_id)
            transcript = await transcribe_audio(audio_path, settings)
            analyzed_audio_duration_ms = _transcript_duration_ms(transcript, duration_ms)
            await _cache_transcript(episode_guid, transcript, audio_sha256, audio_md5)
            model_parts = [settings.whisper_model]
            await _stage(episode_guid, "labeling", duration_ms=duration_ms, run_id=run_id)
            if settings.has_llm:
                segments = await label_ads_llm(
                    transcript,
                    settings,
                    duration_ms,
                    podcast_title=podcast_title,
                    podcast_description=podcast_description,
                    episode_title=title,
                    episode_description=episode_description,
                    show_notes=await _learned_notes(feed_url, podcast_title),
                )
                model_parts.append(_llm_model_label(settings))
            else:
                segments = heuristic_segments(transcript, duration_ms)
                model_parts.append("heuristic")
            model = "+".join(model_parts)
        else:
            await _stage(episode_guid, "transcribing", duration_ms=duration_ms, run_id=run_id)
            transcript = stub_transcript(duration_ms)
            analyzed_audio_duration_ms = _transcript_duration_ms(transcript, duration_ms)
            await _stage(episode_guid, "labeling", duration_ms=duration_ms, run_id=run_id)
            segments = heuristic_segments(transcript, duration_ms)
            model = "stub-whisper+heuristic"

        await _stage(episode_guid, "saving", duration_ms=duration_ms, run_id=run_id)
        return await save_skip_map(
            episode_guid,
            segments,
            model,
            audio_url=audio_url,
            feed_url=feed_url,
            title=title,
            analyzed_audio_size_bytes=audio_size_bytes,
            analyzed_audio_duration_ms=analyzed_audio_duration_ms,
            audio_sha256=audio_sha256,
            audio_md5=audio_md5,
            run_id=run_id,
        )
    except RunSuperseded:
        return await _superseded_result(episode_guid)
    except Exception as exc:
        err = str(exc) or exc.__class__.__name__
        logger.exception("uploaded analyze failed for %s: %s", episode_guid, err)
        await _record_failure(episode_guid, err, run_id)
        return {
            "episode_guid": episode_guid,
            "status": "error",
            "segments": [],
            "model": None,
            "analyzed_at": None,
            "message": err,
            "stage": "error",
            "stage_label": "Failed",
            "progress_pct": None,
            "eta_seconds": None,
            "started_at": None,
            "audio_url": audio_url,
            "analyzed_audio_size_bytes": None,
            "analyzed_audio_duration_ms": None,
        }
    finally:
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not delete uploaded audio %s", audio_path)
