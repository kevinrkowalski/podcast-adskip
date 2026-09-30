"""Honest analyze progress: stage labels + ETA from typical stage durations."""

from __future__ import annotations

from datetime import datetime, timezone

# Ordered pipeline stages (excluding terminal ready/error).
PIPELINE_STAGES = ("queued", "downloading", "transcribing", "labeling", "saving")

STAGE_LABELS: dict[str, str] = {
    "queued": "Queued",
    "downloading": "Downloading",
    "transcribing": "Transcribing",
    "labeling": "Finding ads",
    "saving": "Saving",
    "ready": "Ready",
    "error": "Failed",
}

# Progress percent at the *start* of each stage (honest stage-based, not fake smooth).
STAGE_PCT_START: dict[str, float] = {
    "queued": 0.0,
    "downloading": 5.0,
    "transcribing": 15.0,
    "labeling": 75.0,
    "saving": 92.0,
    "ready": 100.0,
}


def stage_label(stage: str | None) -> str | None:
    if not stage:
        return None
    return STAGE_LABELS.get(stage, stage.replace("_", " ").title())


def typical_stage_seconds(duration_ms: int | None) -> dict[str, float]:
    """Typical wall time per stage, scaled lightly by episode length."""
    dur_sec = max(60.0, (duration_ms or 1_800_000) / 1000.0)
    # Whisper-class APIs are often much faster than realtime; clamp extremes.
    transcribe = max(25.0, min(240.0, dur_sec * 0.08))
    download = max(8.0, min(45.0, 10.0 + dur_sec * 0.008))
    return {
        "queued": 3.0,
        "downloading": download,
        "transcribing": transcribe,
        "labeling": 22.0,
        "saving": 2.0,
    }


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def estimate_progress(
    *,
    status: str,
    stage: str | None,
    duration_ms: int | None,
    started_at: str | None,
    stage_updated_at: str | None = None,
    now: datetime | None = None,
) -> dict:
    """Return progress_pct, eta_seconds, stage_label for API responses."""
    label = stage_label(stage)
    if status == "ready":
        return {
            "stage": "ready",
            "stage_label": STAGE_LABELS["ready"],
            "progress_pct": 100.0,
            "eta_seconds": 0,
        }
    if status == "error":
        return {
            "stage": stage or "error",
            "stage_label": STAGE_LABELS["error"],
            "progress_pct": None,
            "eta_seconds": None,
        }
    if status not in ("pending", "queued"):
        return {
            "stage": stage,
            "stage_label": label,
            "progress_pct": None,
            "eta_seconds": None,
        }

    current = stage if stage in PIPELINE_STAGES else "queued"
    typical = typical_stage_seconds(duration_ms)
    now = now or datetime.now(timezone.utc)

    # Remaining = leftover of current stage + all later stages.
    try:
        idx = PIPELINE_STAGES.index(current)
    except ValueError:
        idx = 0
        current = "queued"

    stage_start = _parse_iso(stage_updated_at) or _parse_iso(started_at)
    elapsed_in_stage = 0.0
    if stage_start is not None:
        elapsed_in_stage = max(0.0, (now - stage_start).total_seconds())

    cur_typical = typical[current]
    # Don't assume we're done with a stage until the pipeline advances it.
    remaining_current = max(cur_typical * 0.15, cur_typical - elapsed_in_stage)
    remaining = remaining_current + sum(typical[s] for s in PIPELINE_STAGES[idx + 1 :])

    # If overall job is running long past total typical, keep a modest floor ETA.
    overall_start = _parse_iso(started_at)
    total_typical = sum(typical[s] for s in PIPELINE_STAGES)
    if overall_start is not None:
        overall_elapsed = max(0.0, (now - overall_start).total_seconds())
        if overall_elapsed > total_typical:
            # Still working — don't claim "0 left".
            remaining = max(remaining, 30.0)

    # Stage-based percent + partial credit within current stage.
    pct_start = STAGE_PCT_START[current]
    next_stages = PIPELINE_STAGES[idx + 1 :]
    pct_end = STAGE_PCT_START[next_stages[0]] if next_stages else 100.0
    frac = 0.0 if cur_typical <= 0 else min(0.9, elapsed_in_stage / cur_typical)
    progress_pct = round(pct_start + (pct_end - pct_start) * frac, 1)

    return {
        "stage": current,
        "stage_label": STAGE_LABELS[current],
        "progress_pct": progress_pct,
        "eta_seconds": int(max(5, round(remaining))),
    }
