"""Storage for report-driven learning: cached transcripts and per-show learned notes.

Tables live in the same SQLite file as skip maps and are created lazily.
"""

from __future__ import annotations

import json
import logging
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from app.config import get_settings

logger = logging.getLogger(__name__)

_CREATE_TRANSCRIPTS = """
CREATE TABLE IF NOT EXISTS transcripts (
    episode_guid TEXT NOT NULL,
    audio_sha256 TEXT NOT NULL,
    audio_md5 TEXT,
    transcript_z BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (episode_guid, audio_sha256)
);
"""

_CREATE_SHOW_NOTES = """
CREATE TABLE IF NOT EXISTS show_notes (
    show_key TEXT PRIMARY KEY,
    notes_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

# Keep at most this many cached transcripts per episode (one per distinct audio copy).
MAX_TRANSCRIPTS_PER_EPISODE = 3


def _db_path() -> Path:
    path = Path(get_settings().database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _connect() -> aiosqlite.Connection:
    db = await aiosqlite.connect(_db_path())
    await db.execute(_CREATE_TRANSCRIPTS)
    await db.execute(_CREATE_SHOW_NOTES)
    return db


async def save_transcript(
    episode_guid: str,
    transcript: dict[str, Any],
    *,
    audio_sha256: str | None,
    audio_md5: str | None,
) -> None:
    """Cache a transcript so later ad reports can be reviewed without re-transcribing."""
    if not audio_sha256 or transcript.get("mock"):
        return
    keep = {
        "duration": transcript.get("duration"),
        "segments": [
            {"start": s.get("start"), "end": s.get("end"), "text": s.get("text")}
            for s in transcript.get("segments") or []
            if isinstance(s, dict)
        ],
    }
    blob = zlib.compress(json.dumps(keep, separators=(",", ":")).encode("utf-8"))
    db = await _connect()
    try:
        await db.execute(
            """INSERT INTO transcripts (episode_guid, audio_sha256, audio_md5, transcript_z, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(episode_guid, audio_sha256) DO UPDATE SET
                 audio_md5 = excluded.audio_md5,
                 transcript_z = excluded.transcript_z,
                 created_at = excluded.created_at""",
            (episode_guid, audio_sha256, audio_md5, blob, _now()),
        )
        await db.execute(
            """DELETE FROM transcripts WHERE episode_guid = ? AND audio_sha256 NOT IN (
                 SELECT audio_sha256 FROM transcripts WHERE episode_guid = ?
                 ORDER BY created_at DESC LIMIT ?)""",
            (episode_guid, episode_guid, MAX_TRANSCRIPTS_PER_EPISODE),
        )
        await db.commit()
    finally:
        await db.close()


async def get_transcript(
    episode_guid: str, *, prefer_md5: str | None = None
) -> tuple[dict[str, Any], str | None] | None:
    """Return (transcript, audio_md5) for an episode, preferring the copy matching prefer_md5."""
    db = await _connect()
    try:
        cur = await db.execute(
            "SELECT transcript_z, audio_md5 FROM transcripts WHERE episode_guid = ? ORDER BY created_at DESC",
            (episode_guid,),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()
    if not rows:
        return None
    chosen = rows[0]
    if prefer_md5:
        for row in rows:
            if row[1] and row[1].lower() == prefer_md5.lower():
                chosen = row
                break
    try:
        return json.loads(zlib.decompress(chosen[0]).decode("utf-8")), chosen[1]
    except (zlib.error, ValueError):
        logger.warning("Ignoring unreadable cached transcript for %s", episode_guid)
        return None


async def delete_expired_transcripts(retention_days: int = 90, *, now: datetime | None = None) -> int:
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=max(1, retention_days))
    db = await _connect()
    try:
        cur = await db.execute("DELETE FROM transcripts WHERE created_at < ?", (cutoff.isoformat(),))
        await db.commit()
        return cur.rowcount
    finally:
        await db.close()


async def get_show_notes(show_key: str | None) -> dict[str, Any] | None:
    if not show_key:
        return None
    db = await _connect()
    try:
        cur = await db.execute("SELECT notes_json FROM show_notes WHERE show_key = ?", (show_key,))
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        return None
    try:
        data = json.loads(row[0])
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


async def save_show_notes(show_key: str, notes: dict[str, Any]) -> None:
    db = await _connect()
    try:
        await db.execute(
            """INSERT INTO show_notes (show_key, notes_json, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(show_key) DO UPDATE SET notes_json = excluded.notes_json,
                 updated_at = excluded.updated_at""",
            (show_key, json.dumps(notes), _now()),
        )
        await db.commit()
    finally:
        await db.close()


async def list_show_notes() -> list[dict[str, Any]]:
    db = await _connect()
    try:
        cur = await db.execute("SELECT show_key, notes_json, updated_at FROM show_notes ORDER BY updated_at DESC")
        rows = await cur.fetchall()
    finally:
        await db.close()
    out = []
    for key, notes_json, updated_at in rows:
        try:
            notes = json.loads(notes_json)
        except ValueError:
            notes = {}
        out.append({"show_key": key, "notes": notes, "updated_at": updated_at})
    return out


async def replace_skip_map_segments(
    episode_guid: str, segments_json: str, *, expect_audio_md5: str
) -> bool:
    """Swap a ready map's segments, only while it still describes the same audio copy.

    Fingerprints, model and analyzed_at stay untouched, so the md5 match (and
    analysis_for_other_audio) behave exactly as before.
    """
    async with aiosqlite.connect(_db_path()) as db:
        cur = await db.execute(
            """UPDATE skip_maps SET segments_json = ?, updated_at = ?
               WHERE episode_guid = ? AND status = 'ready' AND lower(audio_md5) = lower(?)""",
            (segments_json, _now(), episode_guid, expect_audio_md5),
        )
        await db.commit()
        return cur.rowcount > 0
