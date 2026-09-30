"""OpenRouter (primary) / legacy Groq Whisper transcription.

Uses OpenRouter `/audio/transcriptions` with Whisper-class models and
`response_format=verbose_json` + segment timestamps. Downloads episode audio,
splits into ≤MAX_AUDIO_MB chunks when needed (OpenRouter multipart ≈25 MB),
then merges timed segments.

Fallback: if only GROQ_API_KEY is set (no OpenRouter), uses the Groq SDK
directly with the same chunking path.
"""

from __future__ import annotations

import asyncio
import logging
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

# Allow larger downloads than the Whisper per-file cap; we chunk before upload.
DEFAULT_DOWNLOAD_CAP_MB = 500


async def download_audio(
    audio_url: str,
    max_mb: int,
    *,
    download_cap_mb: int = DEFAULT_DOWNLOAD_CAP_MB,
) -> Path:
    """Stream audio to a temp file. Rejects only if over download_cap_mb."""
    max_bytes = download_cap_mb * 1024 * 1024
    suffix = Path(audio_url.split("?")[0]).suffix or ".mp3"
    if len(suffix) > 8:
        suffix = ".mp3"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path = Path(tmp.name)
    tmp.close()

    downloaded = 0
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=180.0) as client:
            async with client.stream("GET", audio_url) as resp:
                resp.raise_for_status()
                with tmp_path.open("wb") as f:
                    async for chunk in resp.aiter_bytes(64 * 1024):
                        downloaded += len(chunk)
                        if downloaded > max_bytes:
                            raise ValueError(
                                f"Audio exceeds download cap of {download_cap_mb} MB"
                            )
                        f.write(chunk)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    size_mb = downloaded / (1024 * 1024)
    logger.info("Downloaded %.1f MB to %s (whisper chunk limit %s MB)", size_mb, tmp_path, max_mb)
    return tmp_path


def _ffprobe_duration_s(path: Path) -> float | None:
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            text=True,
            timeout=60,
        ).strip()
        return float(out) if out else None
    except (subprocess.SubprocessError, ValueError) as exc:
        logger.warning("ffprobe failed: %s", exc)
        return None


def plan_chunk_count(file_size: int, max_mb: int) -> int:
    """How many equal-time chunks keep each piece under max_mb (approx)."""
    limit = max_mb * 1024 * 1024
    if file_size <= limit:
        return 1
    # +5% slack so borderline bitrate spikes stay under the API limit
    return max(2, math.ceil(file_size / (limit * 0.95)))


def split_audio_chunks(audio_path: Path, max_mb: int) -> list[tuple[Path, float]]:
    """Return [(chunk_path, start_offset_s), ...]. Single entry if under limit.

    Uses ffmpeg when available. Raises ValueError if chunking is required but ffmpeg missing.
    """
    size = audio_path.stat().st_size
    n = plan_chunk_count(size, max_mb)
    if n == 1:
        return [(audio_path, 0.0)]

    if not shutil.which("ffmpeg"):
        raise ValueError(
            f"Audio is {size / (1024 * 1024):.1f} MB (>{max_mb} MB STT upload limit) "
            "but ffmpeg is not installed to chunk it"
        )

    duration = _ffprobe_duration_s(audio_path)
    if not duration or duration <= 0:
        raise ValueError("Could not determine audio duration for chunking")

    chunk_dur = duration / n
    out_dir = Path(tempfile.mkdtemp(prefix="adskip-chunks-"))
    chunks: list[tuple[Path, float]] = []
    suffix = audio_path.suffix or ".mp3"

    for i in range(n):
        start = i * chunk_dur
        # Slight overlap avoided — Whisper timestamps are absolute within chunk;
        # we offset when merging. Use stream copy when possible for speed.
        out = out_dir / f"chunk_{i:03d}{suffix}"
        cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{chunk_dur:.3f}",
            "-i",
            str(audio_path),
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            str(out),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        except subprocess.CalledProcessError:
            # Re-encode if copy fails (odd containers / keyframe issues)
            cmd_re = [
                "ffmpeg",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-t",
                f"{chunk_dur:.3f}",
                "-i",
                str(audio_path),
                "-acodec",
                "libmp3lame",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(out.with_suffix(".mp3")),
            ]
            subprocess.run(cmd_re, check=True, capture_output=True, timeout=600)
            out = out.with_suffix(".mp3")

        if not out.exists() or out.stat().st_size == 0:
            raise ValueError(f"Chunk {i} empty after ffmpeg")
        # If a single chunk is still over limit, re-encode smaller
        if out.stat().st_size > max_mb * 1024 * 1024:
            smaller = out.with_name(out.stem + "_sm.mp3")
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(out),
                    "-acodec",
                    "libmp3lame",
                    "-b:a",
                    "48k",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(smaller),
                ],
                check=True,
                capture_output=True,
                timeout=600,
            )
            if out != audio_path:
                out.unlink(missing_ok=True)
            out = smaller
            if out.stat().st_size > max_mb * 1024 * 1024:
                raise ValueError(
                    f"Chunk {i} still exceeds {max_mb} MB after re-encode "
                    f"({out.stat().st_size / (1024 * 1024):.1f} MB)"
                )
        chunks.append((out, start))
        logger.info("Chunk %s/%s offset=%.1fs size=%.1fMB", i + 1, n, start, out.stat().st_size / (1024 * 1024))

    return chunks


def merge_transcripts(parts: list[tuple[dict, float]]) -> dict:
    """Merge verbose_json transcripts with per-chunk time offsets (seconds)."""
    all_segments: list[dict] = []
    texts: list[str] = []
    total_duration = 0.0
    for idx, (tx, offset) in enumerate(parts):
        if tx.get("text"):
            texts.append(str(tx["text"]).strip())
        for seg in tx.get("segments") or []:
            if isinstance(seg, dict):
                start = float(seg.get("start", 0)) + offset
                end = float(seg.get("end", 0)) + offset
                all_segments.append(
                    {
                        "id": len(all_segments),
                        "start": start,
                        "end": end,
                        "text": seg.get("text", ""),
                    }
                )
            else:
                start = float(getattr(seg, "start", 0)) + offset
                end = float(getattr(seg, "end", 0)) + offset
                all_segments.append(
                    {
                        "id": len(all_segments),
                        "start": start,
                        "end": end,
                        "text": getattr(seg, "text", ""),
                    }
                )
        dur = tx.get("duration")
        if dur is not None:
            total_duration = max(total_duration, float(dur) + offset)
        elif all_segments:
            total_duration = max(total_duration, all_segments[-1]["end"])
        logger.debug("Merged chunk %s (+%.1fs) segs=%s", idx, offset, len(tx.get("segments") or []))

    return {
        "text": " ".join(texts),
        "segments": all_segments,
        "duration": total_duration or None,
    }


def _normalize_transcription(result: object) -> dict:
    if hasattr(result, "model_dump"):
        return result.model_dump()  # type: ignore[no-any-return]
    if isinstance(result, dict):
        return result
    segments = []
    for seg in getattr(result, "segments", None) or []:
        if isinstance(seg, dict):
            segments.append(seg)
        else:
            segments.append(
                {
                    "id": getattr(seg, "id", None),
                    "start": getattr(seg, "start", 0),
                    "end": getattr(seg, "end", 0),
                    "text": getattr(seg, "text", ""),
                }
            )
    return {
        "text": getattr(result, "text", ""),
        "segments": segments,
        "duration": getattr(result, "duration", None),
    }


def _openrouter_headers(settings: Settings) -> dict[str, str]:
    headers: dict[str, str] = {}
    if settings.openrouter_http_referer:
        headers["HTTP-Referer"] = settings.openrouter_http_referer
    if settings.openrouter_app_title:
        headers["X-Title"] = settings.openrouter_app_title
    return headers


def _transcribe_openrouter_sync(audio_path: Path, settings: Settings) -> dict:
    """OpenRouter STT via OpenAI-compatible multipart (verbose_json segments).

    Model default: openai/whisper-large-v3-turbo — affordable Whisper-class STT
    with segment timestamps on OpenRouter (DeepInfra / Groq providers).
    """
    from openai import OpenAI

    client = OpenAI(
        base_url=settings.openrouter_base_url.rstrip("/"),
        api_key=settings.openrouter_api_key,
        default_headers=_openrouter_headers(settings) or None,
    )
    with audio_path.open("rb") as f:
        result = client.audio.transcriptions.create(
            file=(audio_path.name, f),
            model=settings.whisper_model,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    return _normalize_transcription(result)


def _transcribe_groq_sync(audio_path: Path, settings: Settings) -> dict:
    """Legacy Groq Whisper path (optional when only GROQ_API_KEY is set)."""
    from groq import Groq

    # Legacy Groq model ids omit the openai/ prefix
    model = settings.whisper_model
    if model.startswith("openai/"):
        model = model.split("/", 1)[1]

    client = Groq(api_key=settings.groq_api_key)
    with audio_path.open("rb") as f:
        result = client.audio.transcriptions.create(
            file=(audio_path.name, f),
            model=model,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    return _normalize_transcription(result)


def _transcribe_file_sync(audio_path: Path, settings: Settings) -> dict:
    if settings.openrouter_api_key:
        return _transcribe_openrouter_sync(audio_path, settings)
    if settings.groq_api_key:
        return _transcribe_groq_sync(audio_path, settings)
    raise RuntimeError("No OPENROUTER_API_KEY or GROQ_API_KEY configured for transcription")


async def transcribe_audio(audio_path: Path, settings: Settings) -> dict:
    """Whisper verbose_json via OpenRouter (preferred) or legacy Groq; chunk if over max_audio_mb."""
    chunks = split_audio_chunks(audio_path, settings.max_audio_mb)
    owned_dirs: set[Path] = set()
    try:
        parts: list[tuple[dict, float]] = []
        for path, offset in chunks:
            if path.parent.name.startswith("adskip-chunks-"):
                owned_dirs.add(path.parent)
            tx = await asyncio.to_thread(_transcribe_file_sync, path, settings)
            parts.append((tx, offset))
        if len(parts) == 1 and parts[0][1] == 0.0:
            return parts[0][0]
        return merge_transcripts(parts)
    finally:
        for d in owned_dirs:
            shutil.rmtree(d, ignore_errors=True)


# Back-compat alias used by older imports / docs
async def transcribe_groq(audio_path: Path, settings: Settings) -> dict:
    return await transcribe_audio(audio_path, settings)


def stub_transcript(duration_ms: int | None = None) -> dict:
    """Deterministic mock transcript for local/dev without API keys."""
    duration_s = (duration_ms or 1_800_000) / 1000.0
    segments = [
        {
            "id": 0,
            "start": 0.0,
            "end": 15.0,
            "text": "This episode is brought to you by Acme VPN. Use code PODCAST.",
        },
        {
            "id": 1,
            "start": 15.0,
            "end": 45.0,
            "text": "Welcome back to the show. Today we talk about science.",
        },
        {
            "id": 2,
            "start": 600.0,
            "end": 660.0,
            "text": "A word from our sponsor SquareSpace. Build your website today.",
        },
        {
            "id": 3,
            "start": 660.0,
            "end": min(duration_s, 1200.0),
            "text": "And we're back with more content for you.",
        },
    ]
    return {
        "text": " ".join(s["text"] for s in segments),
        "segments": segments,
        "duration": duration_s,
        "mock": True,
    }
