"""Storage for the Omni quiet-gap second pass: audit log + applying additions to a map."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import aiosqlite

from app.db import sqlite as _sqlite
from app.db.sqlite import _decode_segments, _ensure_columns, _now
from app.models.schemas import AdSegment

logger = logging.getLogger(__name__)

_CREATE_LOG = """
CREATE TABLE IF NOT EXISTS omni_gap_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    episode_guid TEXT NOT NULL,
    audio_md5 TEXT,
    run_id TEXT,
    model TEXT,
    gap_start_ms INTEGER,
    gap_end_ms INTEGER,
    clip_start_ms INTEGER,
    clip_end_ms INTEGER,
    start_ms INTEGER,
    end_ms INTEGER,
    type TEXT,
    confidence REAL,
    what TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    latency_ms INTEGER,
    cost_usd REAL
);
"""
_CREATE_LOG_INDEX = "CREATE INDEX IF NOT EXISTS omni_gap_log_guid ON omni_gap_log(episode_guid, id)"

LOG_FIELDS = (
    "episode_guid",
    "audio_md5",
    "run_id",
    "model",
    "gap_start_ms",
    "gap_end_ms",
    "clip_start_ms",
    "clip_end_ms",
    "start_ms",
    "end_ms",
    "type",
    "confidence",
    "what",
    "decision",
    "reason",
    "latency_ms",
    "cost_usd",
)


async def _connect() -> aiosqlite.Connection:
    db = await aiosqlite.connect(_sqlite._db_path())
    db.row_factory = aiosqlite.Row
    await db.execute(_CREATE_LOG)
    await db.execute(_CREATE_LOG_INDEX)
    return db


async def add_log_entries(entries: list[dict[str, Any]]) -> None:
    """Append audit rows (one per Omni answer, skipped gap or failed call)."""
    if not entries:
        return
    now = _now()
    rows = []
    for e in entries:
        what = e.get("what")
        reason = e.get("reason")
        rows.append(
            (
                now,
                *[
                    (str(what)[:300] if k == "what" and what is not None else
                     str(reason)[:300] if k == "reason" and reason is not None else e.get(k))
                    for k in LOG_FIELDS
                ],
            )
        )
    db = await _connect()
    try:
        await db.executemany(
            f"INSERT INTO omni_gap_log (created_at, {', '.join(LOG_FIELDS)}) "
            f"VALUES (?, {', '.join('?' for _ in LOG_FIELDS)})",
            rows,
        )
        await db.commit()
    finally:
        await db.close()


async def list_log_entries(
    *, episode_guid: str | None = None, decision: str | None = None, limit: int = 200
) -> list[dict[str, Any]]:
    db = await _connect()
    try:
        where, args = [], []
        if episode_guid:
            where.append("episode_guid = ?")
            args.append(episode_guid)
        if decision:
            where.append("decision = ?")
            args.append(decision)
        sql = "SELECT * FROM omni_gap_log"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(max(1, min(limit, 1000)))
        cur = await db.execute(sql, args)
        return [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


async def delete_expired_log_entries(retention_days: int = 90, *, now: datetime | None = None) -> int:
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=max(1, retention_days))
    db = await _connect()
    try:
        cur = await db.execute("DELETE FROM omni_gap_log WHERE created_at < ?", (cutoff.isoformat(),))
        await db.commit()
        return cur.rowcount
    finally:
        await db.close()


async def finish_gap_pass(
    episode_guid: str,
    *,
    run_id: str | None,
    audio_md5: str | None,
    status: str,
    merge: Callable[[list[AdSegment]], list[AdSegment]] | None = None,
) -> bool:
    """Apply the gap pass to the stored map, atomically, only if it is still the same map.

    The row must still be ready, describe the same audio bytes (md5) and belong to the
    same analysis run; a newer analysis (or other audio) is never touched. `merge` gets
    the map's *current* segments (a reviewed report may have changed them meanwhile) and
    returns the new list. Fingerprints, model and analyzed_at stay as they were, so
    md5 matching and analysis_for_other_audio behave exactly as before.
    Returns True when the row was updated.
    """
    async with aiosqlite.connect(_sqlite._db_path()) as db:
        db.row_factory = aiosqlite.Row
        await _ensure_columns(db)
        await db.execute("BEGIN IMMEDIATE")
        try:
            cur = await db.execute(
                "SELECT status, segments_json, audio_md5, run_id, gap_pass_status "
                "FROM skip_maps WHERE episode_guid = ?",
                (episode_guid,),
            )
            row = await cur.fetchone()
            same_map = (
                row is not None
                and row["status"] == "ready"
                and row["gap_pass_status"] == "pending"
                and (row["run_id"] or None) == (run_id or None)
                and (row["audio_md5"] or "").lower() == (audio_md5 or "").lower()
            )
            if not same_map:
                await db.rollback()
                return False
            if merge is not None:
                segments = merge(_decode_segments(row["segments_json"]))
                payload = json.dumps([s.model_dump() for s in segments])
                await db.execute(
                    "UPDATE skip_maps SET segments_json = ?, gap_pass_status = ?, updated_at = ? "
                    "WHERE episode_guid = ?",
                    (payload, status, _now(), episode_guid),
                )
            else:
                await db.execute(
                    "UPDATE skip_maps SET gap_pass_status = ? WHERE episode_guid = ?",
                    (status, episode_guid),
                )
            await db.commit()
            return True
        except Exception:
            await db.rollback()
            raise
