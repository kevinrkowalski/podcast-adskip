from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from app.config import get_settings
from app.models.schemas import AdSegment
from app.services.progress import estimate_progress

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
)


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


def _row_to_dict(row: aiosqlite.Row) -> dict:
    keys = set(row.keys())
    status = row["status"]
    stage = row["stage"] if "stage" in keys else None
    started_at = row["started_at"] if "started_at" in keys else None
    stage_updated_at = row["stage_updated_at"] if "stage_updated_at" in keys else None
    duration_ms = row["duration_ms"] if "duration_ms" in keys else None
    analyzed_audio_size_bytes = row["analyzed_audio_size_bytes"] if "analyzed_audio_size_bytes" in keys else None
    analyzed_audio_duration_ms = row["analyzed_audio_duration_ms"] if "analyzed_audio_duration_ms" in keys else None
    if status == "pending" and not stage:
        stage = "queued"
    progress = estimate_progress(
        status=status if status in ("ready", "pending", "error", "queued") else status,
        stage=stage,
        duration_ms=duration_ms,
        started_at=started_at or (row["created_at"] if status == "pending" else None),
        stage_updated_at=stage_updated_at,
    )
    return {
        "episode_guid": row["episode_guid"],
        "status": status,
        "segments": [AdSegment.model_validate(s) for s in json.loads(row["segments_json"] or "[]")],
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
    }


async def get_skip_map(episode_guid: str) -> dict | None:
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
) -> None:
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

        await db.execute(
            """
            INSERT INTO skip_maps (
              episode_guid, status, audio_url, feed_url, title, error,
              stage, started_at, stage_updated_at, duration_ms,
              created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              updated_at = excluded.updated_at
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
                now,
                now,
                started_at if (reset_started or not prev_started) else None,
                stage_updated_at,
            ),
        )
        await db.commit()


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
) -> dict:
    now = _now()
    payload = json.dumps([s.model_dump() for s in segments])
    async with aiosqlite.connect(_db_path()) as db:
        await _ensure_columns(db)
        await db.execute(
            """
            INSERT INTO skip_maps (
              episode_guid, status, segments_json, model, audio_url, feed_url, title,
              analyzed_at, error, stage, stage_updated_at, 
              analyzed_audio_size_bytes, analyzed_audio_duration_ms,
              created_at, updated_at
            ) VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, NULL, 'ready', ?, ?, ?, ?, ?)
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
              analyzed_audio_size_bytes = COALESCE(excluded.analyzed_audio_size_bytes, skip_maps.analyzed_audio_size_bytes),
              analyzed_audio_duration_ms = COALESCE(excluded.analyzed_audio_duration_ms, skip_maps.analyzed_audio_duration_ms),
              updated_at = excluded.updated_at
            """,
            (episode_guid, payload, model, audio_url, feed_url, title, now, now, 
             analyzed_audio_size_bytes, analyzed_audio_duration_ms, now, now),
        )
        await db.commit()
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
        **progress,
        "started_at": None,
        "analyzed_audio_size_bytes": analyzed_audio_size_bytes,
        "analyzed_audio_duration_ms": analyzed_audio_duration_ms,
    }
