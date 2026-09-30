"""Orchestrate download → Whisper → LLM labels → SQLite cache."""

from __future__ import annotations

import logging
from pathlib import Path

from app.config import Settings, get_settings
from app.db import save_skip_map, set_status
from app.services.detect_ads import heuristic_segments, label_ads_llm
from app.services.transcribe import download_audio, stub_transcript, transcribe_audio

logger = logging.getLogger(__name__)


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
    )


async def run_analyze(
    *,
    episode_guid: str,
    audio_url: str,
    title: str | None = None,
    duration_ms: int | None = None,
    feed_url: str | None = None,
    settings: Settings | None = None,
) -> dict:
    settings = settings or get_settings()
    await _stage(
        episode_guid,
        "queued",
        audio_url=audio_url,
        feed_url=feed_url,
        title=title,
        duration_ms=duration_ms,
        reset_started=True,
    )

    audio_path: Path | None = None
    audio_size_bytes: int | None = None
    audio_duration_ms: int | None = None
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
            )
            audio_path = await download_audio(audio_url, settings.max_audio_mb)
            audio_size_bytes = audio_path.stat().st_size

            await _stage(
                episode_guid,
                "transcribing",
                duration_ms=duration_ms,
            )
            transcript = await transcribe_audio(audio_path, settings)
            if transcript.get("duration"):
                audio_duration_ms = int(transcript["duration"] * 1000)
            model_parts = [settings.whisper_model]

            await _stage(
                episode_guid,
                "labeling",
                duration_ms=duration_ms,
            )
            if settings.has_llm:
                segments = await label_ads_llm(transcript, settings)
                model_parts.append(_llm_model_label(settings))
            else:
                segments = heuristic_segments(transcript)
                model_parts.append("heuristic")
            model = "+".join(model_parts)
        else:
            logger.info("No OPENROUTER_API_KEY (or MOCK_ANALYZE) — using stub transcript")
            await _stage(
                episode_guid,
                "transcribing",
                duration_ms=duration_ms,
            )
            transcript = stub_transcript(duration_ms)
            await _stage(
                episode_guid,
                "labeling",
                duration_ms=duration_ms,
            )
            segments = heuristic_segments(transcript)
            model = "stub-whisper+heuristic"

        await _stage(episode_guid, "saving", duration_ms=duration_ms)
        result = await save_skip_map(
            episode_guid,
            segments,
            model,
            audio_url=audio_url,
            feed_url=feed_url,
            title=title,
            analyzed_audio_size_bytes=audio_size_bytes,
            analyzed_audio_duration_ms=audio_duration_ms,
        )
        logger.info(
            "Analyze ready guid=%s segments=%s model=%s size=%s duration_ms=%s",
            episode_guid,
            len(segments),
            model,
            audio_size_bytes,
            audio_duration_ms,
        )
        return result
    except Exception as exc:  # noqa: BLE001 — surface to cache + API
        err = str(exc) or exc.__class__.__name__
        logger.exception("analyze failed for %s: %s", episode_guid, err)
        await set_status(episode_guid, "error", error=err, stage="error")
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
