from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from app.config import get_settings
from app.models.schemas import AdSegment
from app.services.progress import estimate_progress

logger = logging.getLogger(__name__)

_CREATE = """
CREATE TABLE IF NOT EXISTS skip_maps (
    episode_guid TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    segments_json TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    audio_url TEXT,
    feed_url TEXT,
    title TEXT,
    analyzed_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_MIGRATE_COLS = (
    ("stage", "TEXT"),
    ("started_at", "TEXT"),
    ("stage_updated_at", "TEXT"),
    ("duration_ms", "INTEGER"),
    ("analyzed_audio_size_bytes", "INTEGER"),
    ("analyzed_audio_duration_ms", "INTEGER"),
    ("audio_sha256", "TEXT"),
    ("audio_md5", "TEXT"),
    ("pending_audio_sha256", "TEXT"),
    ("run_id", "TEXT"),
)


class RunSuperseded(Exception):
    """A newer analysis run took over this episode's row; the older run must stop writing."""


def _db_path() -> Path:
    path = Path(get_settings().database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _ensure_columns(db: aiosqlite.Connection) -> None:
    cur = await db.execute("PRAGMA table_info(skip_maps)")
    rows = await cur.fetchall()
    existing = {r[1] for r in rows}
    for name, col_type in _MIGRATE_COLS:
        if name not in existing:
            await db.execute(f"ALTER TABLE skip_maps ADD COLUMN {name} {col_type}")


async def init_db() -> None:
    async with aiosqlite.connect(_db_path()) as db:
        await db.execute(_CREATE)
        await _ensure_columns(db)
        await db.commit()


async def delete_expired_skip_maps(
    retention_days: int = 90,
    *,
    now: datetime | None = None,
) -> int:
    """Delete database records older than the configured retention period."""
    days = max(1, retention_days)
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=days)
    async with aiosqlite.connect(_db_path()) as db:
        cursor = await db.execute(
            # updated_at is the row's latest write (>= analyzed_at). Never delete a row an
            # analysis is still writing to, even if its previous map is old.
            "DELETE FROM skip_maps WHERE status != 'pending' AND updated_at < ?",
            (cutoff.isoformat(),),
        )
        await db.commit()
        return cursor.rowcount


INTERRUPTED_ERROR = "Analysis interrupted (server restarted)"


async def fail_interrupted_analyses() -> int:
    """Mark rows left 'pending' by a previous process as errored.

    Background tasks do not survive a restart, so any pending row at startup
    can never complete and would otherwise block re-analysis forever.
    """
    now = _now()
    async with aiosqlite.connect(_db_path()) as db:
        await _ensure_columns(db)
        cursor = await db.execute(
            """
            UPDATE skip_maps
            SET status = 'error', stage = 'error', error = ?,
                stage_updated_at = ?, updated_at = ?
            WHERE status = 'pending'
            """,
            (INTERRUPTED_ERROR, now, now),
        )
        await db.commit()
        return cursor.rowcount


def _decode_segments(segments_json: str | None) -> list[AdSegment]:
    try:
        raw_segments = json.loads(segments_json or "[]")
    except (json.JSONDecodeError, TypeError):
        logger.warning("Ignoring malformed segments JSON in skip-map row")
        return []
    if not isinstance(raw_segments, list):
        logger.warning("Ignoring non-list segments payload in skip-map row")
        return []

    def validate_segment(raw: dict[str, Any]) -> AdSegment:
        segment = AdSegment.model_validate(raw)
        if segment.end_ms <= segment.start_ms:
            raise ValueError("segment end must be after its start")
        return segment

    segments: list[AdSegment] = []
    for raw in raw_segments:
        if not isinstance(raw, dict):
            continue
        try:
            segments.append(validate_segment(raw))
        except (TypeError, ValueError):
            # Old cached maps may contain a newer or unknown type. Keep its timing
            # visible as unclassified, but never turn it into an auto-skippable ad.
            try:
                segments.append(validate_segment({**raw, "type": "unknown"}))
            except (TypeError, ValueError):
                logger.warning("Skipping malformed segment in skip-map row")
    return segments


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    keys = set(row.keys())
    status = row["status"]
    stage = row["stage"] if "stage" in keys else None
    started_at = row["started_at"] if "started_at" in keys else None
    stage_updated_at = row["stage_updated_at"] if "stage_updated_at" in keys else None
    duration_ms = row["duration_ms"] if "duration_ms" in keys else None
    analyzed_audio_size_bytes = (
        row["analyzed_audio_size_bytes"] if "analyzed_audio_size_bytes" in keys else None
    )
    analyzed_audio_duration_ms = (
        row["analyzed_audio_duration_ms"] if "analyzed_audio_duration_ms" in keys else None
    )
    if status == "pending" and not stage:
        stage = "queued"
    progress = estimate_progress(
        status=status,
        stage=stage,
        duration_ms=duration_ms,
        started_at=started_at or (row["created_at"] if status == "pending" else None),
        stage_updated_at=stage_updated_at,
    )
    return {
        "episode_guid": row["episode_guid"],
        "status": status,
        "segments": _decode_segments(row["segments_json"]),
        "model": row["model"],
        "analyzed_at": row["analyzed_at"],
        "message": row["error"],
        "audio_url": row["audio_url"],
        "feed_url": row["feed_url"],
        "title": row["title"],
        "stage": progress.get("stage") or stage,
        "stage_label": progress.get("stage_label"),
        "progress_pct": progress.get("progress_pct"),
        "eta_seconds": progress.get("eta_seconds"),
        "started_at": started_at or (row["created_at"] if status == "pending" else None),
        "duration_ms": duration_ms,
        "analyzed_audio_size_bytes": analyzed_audio_size_bytes,
        "analyzed_audio_duration_ms": analyzed_audio_duration_ms,
        "audio_sha256": row["audio_sha256"] if "audio_sha256" in keys else None,
        "audio_md5": row["audio_md5"] if "audio_md5" in keys else None,
        "pending_audio_sha256": (
            row["pending_audio_sha256"] if "pending_audio_sha256" in keys else None
        ),
    }


async def get_skip_map(episode_guid: str) -> dict[str, Any] | None:
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        await _ensure_columns(db)
        cur = await db.execute(
            "SELECT * FROM skip_maps WHERE episode_guid = ?",
            (episode_guid,),
        )
        row = await cur.fetchone()
        if not row:
            return None
        return _row_to_dict(row)


async def set_status(
    episode_guid: str,
    status: str,
    *,
    audio_url: str | None = None,
    feed_url: str | None = None,
    title: str | None = None,
    error: str | None = None,
    stage: str | None = None,
    duration_ms: int | None = None,
    reset_started: bool = False,
    pending_audio_sha256: str | None = None,
    run_id: str | None = None,
) -> None:
    """Upsert an episode's status.

    Runs identify themselves with `run_id`. A write with ``reset_started=True`` starts a
    new run and takes over the row (a route passing no run_id releases it, so the old run
    can no longer write). Any other write carrying a run_id only applies while that run
    still owns the row, otherwise it raises RunSuperseded. Without that, two concurrent
    analyses of one GUID (e.g. two uploads with different ad variants) interleave their
    stage, error and ready writes.
    """
    now = _now()
    async with aiosqlite.connect(_db_path()) as db:
        await _ensure_columns(db)
        # Preserve started_at unless explicitly resetting a new run.
        cur = await db.execute(
            "SELECT started_at, stage FROM skip_maps WHERE episode_guid = ?",
            (episode_guid,),
        )
        existing = await cur.fetchone()
        prev_started = existing[0] if existing else None
        prev_stage = existing[1] if existing else None

        if reset_started or not prev_started:
            started_at = now
        else:
            started_at = prev_started

        stage_changed = stage is not None and stage != prev_stage
        if stage_changed or reset_started or not existing:
            stage_updated_at = now
        else:
            stage_updated_at = None  # preserve prior via COALESCE below

        cursor = await db.execute(
            """
            INSERT INTO skip_maps (
              episode_guid, status, audio_url, feed_url, title, error,
              stage, started_at, stage_updated_at, duration_ms,
              pending_audio_sha256, run_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(episode_guid) DO UPDATE SET
              status = excluded.status,
              audio_url = COALESCE(excluded.audio_url, skip_maps.audio_url),
              feed_url = COALESCE(excluded.feed_url, skip_maps.feed_url),
              title = COALESCE(excluded.title, skip_maps.title),
              error = excluded.error,
              stage = COALESCE(excluded.stage, skip_maps.stage),
              started_at = COALESCE(?, skip_maps.started_at),
              stage_updated_at = COALESCE(?, skip_maps.stage_updated_at),
              duration_ms = COALESCE(excluded.duration_ms, skip_maps.duration_ms),
              pending_audio_sha256 = CASE WHEN ? THEN excluded.pending_audio_sha256
                ELSE COALESCE(excluded.pending_audio_sha256, skip_maps.pending_audio_sha256)
              END,
              run_id = CASE WHEN ? THEN excluded.run_id ELSE skip_maps.run_id END,
              updated_at = excluded.updated_at
            WHERE ? OR ? IS NULL OR skip_maps.run_id IS ?
            """,
            (
                episode_guid,
                status,
                audio_url,
                feed_url,
                title,
                error,
                stage,
                started_at,
                stage_updated_at if stage_updated_at is not None else now,
                duration_ms,
                pending_audio_sha256,
                run_id,
                now,
                now,
                started_at if (reset_started or not prev_started) else None,
                stage_updated_at,
                # A new run replaces (or clears) the in-flight audio fingerprint.
                1 if reset_started else 0,
                # ...and takes over the row.
                1 if reset_started else 0,
                1 if reset_started else 0,
                run_id,
                run_id,
            ),
        )
        await db.commit()
        if cursor.rowcount == 0:
            raise RunSuperseded(episode_guid)


async def save_skip_map(
    episode_guid: str,
    segments: list[AdSegment],
    model: str,
    *,
    audio_url: str | None = None,
    feed_url: str | None = None,
    title: str | None = None,
    analyzed_audio_size_bytes: int | None = None,
    analyzed_audio_duration_ms: int | None = None,
    audio_sha256: str | None = None,
    audio_md5: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Store a finished map. With `run_id`, only while that run owns the row (see set_status)."""
    now = _now()
    payload = json.dumps([s.model_dump() for s in segments])
    async with aiosqlite.connect(_db_path()) as db:
        await _ensure_columns(db)
        cursor = await db.execute(
            """
            INSERT INTO skip_maps (
              episode_guid, status, segments_json, model, audio_url, feed_url, title,
              analyzed_at, error, stage, stage_updated_at, analyzed_audio_size_bytes,
              analyzed_audio_duration_ms, audio_sha256, audio_md5, created_at, updated_at
            ) VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, NULL, 'ready', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(episode_guid) DO UPDATE SET
              status = 'ready',
              segments_json = excluded.segments_json,
              model = excluded.model,
              audio_url = COALESCE(excluded.audio_url, skip_maps.audio_url),
              feed_url = COALESCE(excluded.feed_url, skip_maps.feed_url),
              title = COALESCE(excluded.title, skip_maps.title),
              analyzed_at = excluded.analyzed_at,
              error = NULL,
              stage = 'ready',
              stage_updated_at = excluded.stage_updated_at,
              analyzed_audio_size_bytes = excluded.analyzed_audio_size_bytes,
              analyzed_audio_duration_ms = excluded.analyzed_audio_duration_ms,
              audio_sha256 = excluded.audio_sha256,
              audio_md5 = excluded.audio_md5,
              updated_at = excluded.updated_at
            WHERE ? IS NULL OR skip_maps.run_id IS ?
            """,
            (
                episode_guid,
                payload,
                model,
                audio_url,
                feed_url,
                title,
                now,
                now,
                analyzed_audio_size_bytes,
                analyzed_audio_duration_ms,
                audio_sha256,
                audio_md5,
                now,
                now,
                run_id,
                run_id,
            ),
        )
        await db.commit()
        if cursor.rowcount == 0:
            raise RunSuperseded(episode_guid)
    progress = estimate_progress(
        status="ready",
        stage="ready",
        duration_ms=None,
        started_at=None,
    )
    return {
        "episode_guid": episode_guid,
        "status": "ready",
        "segments": segments,
        "model": model,
        "analyzed_at": now,
        "message": None,
        "audio_url": audio_url,
        "analyzed_audio_size_bytes": analyzed_audio_size_bytes,
        "analyzed_audio_duration_ms": analyzed_audio_duration_ms,
        "audio_sha256": audio_sha256,
        "audio_md5": audio_md5,
        **progress,
        "started_at": None,
    }
