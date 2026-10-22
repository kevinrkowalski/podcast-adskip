"""User feedback on skip maps ("Report bad skip").

Self-contained: owns its SQLite table (created lazily in the same database file)
and its own rate limiter, so deploying it only needs this file plus one
`include_router` line in main.py.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

import aiosqlite
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.auth import check_app_key
from app.config import get_settings
from app.db.learning import list_show_notes
from app.rate_limit import SlidingWindowRateLimiter, client_ip
from app.services.feedback_review import ensure_review_columns, review_feedback

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["feedback"])

FEEDBACK_RATE_LIMIT = 30
FEEDBACK_RATE_WINDOW_SECONDS = 3600
_limiter = SlidingWindowRateLimiter(FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_SECONDS)

_CREATE = """
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    episode_guid TEXT NOT NULL,
    title TEXT,
    feed_url TEXT,
    position_ms INTEGER,
    selected_segment_json TEXT,
    segments_json TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    analyzed_at TEXT,
    note TEXT,
    client_created_at TEXT,
    app_version TEXT,
    created_at TEXT NOT NULL
);
"""


class FeedbackSegment(BaseModel):
    start_ms: int
    end_ms: int
    type: str | None = None
    confidence: float | None = None


class FeedbackIn(BaseModel):
    kind: Literal["skipped_content", "missed_ad"]
    episode_guid: str = Field(min_length=1, max_length=2048)
    title: str | None = Field(default=None, max_length=1000)
    feed_url: str | None = Field(default=None, max_length=2048)
    position_ms: int | None = Field(default=None, ge=0)
    selected_segment: FeedbackSegment | None = None
    segments: list[FeedbackSegment] = Field(default_factory=list, max_length=500)
    model: str | None = Field(default=None, max_length=200)
    analyzed_at: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=2000)
    client_created_at: str | None = Field(default=None, max_length=64)
    app_version: str | None = Field(default=None, max_length=64)


class FeedbackOut(FeedbackIn):
    id: int
    created_at: str
    # Server-side review of the report (see services/feedback_review.py).
    review_status: str | None = None
    review: dict[str, Any] | None = None
    reviewed_at: str | None = None
    show_key: str | None = None


def _db_path() -> Path:
    path = Path(get_settings().database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


async def _connect() -> aiosqlite.Connection:
    db = await aiosqlite.connect(_db_path())
    await db.execute(_CREATE)
    await ensure_review_columns(db)
    return db


def _row_out(row: aiosqlite.Row) -> FeedbackOut:
    d: dict[str, Any] = dict(row)
    sel = d.pop("selected_segment_json", None)
    segs = d.pop("segments_json", None) or "[]"
    d["selected_segment"] = json.loads(sel) if sel else None
    d["segments"] = json.loads(segs)
    review = d.pop("review_json", None)
    try:
        d["review"] = json.loads(review) if review else None
    except ValueError:
        d["review"] = None
    return FeedbackOut(**d)


def _enforce_rate_limit(request: Request) -> None:
    allowed, _remaining, retry_after = _limiter.check(client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: max {FEEDBACK_RATE_LIMIT} feedback reports per hour.",
            headers={"Retry-After": str(retry_after)},
        )


def reset_feedback_limiter() -> None:
    _limiter.reset()


@router.post("/feedback", response_model=FeedbackOut, status_code=201)
async def create_feedback(
    body: FeedbackIn,
    request: Request,
    background_tasks: BackgroundTasks,
    x_app_key: Annotated[str | None, Header()] = None,
) -> FeedbackOut:
    check_app_key(x_app_key)
    _enforce_rate_limit(request)
    created_at = datetime.now(timezone.utc).isoformat()
    db = await _connect()
    try:
        cur = await db.execute(
            """INSERT INTO feedback (kind, episode_guid, title, feed_url, position_ms,
                   selected_segment_json, segments_json, model, analyzed_at, note,
                   client_created_at, app_version, created_at, review_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
            (
                body.kind,
                body.episode_guid,
                body.title,
                body.feed_url,
                body.position_ms,
                body.selected_segment.model_dump_json() if body.selected_segment else None,
                json.dumps([s.model_dump() for s in body.segments]),
                body.model,
                body.analyzed_at,
                body.note,
                body.client_created_at,
                body.app_version,
                created_at,
            ),
        )
        await db.commit()
        new_id = cur.lastrowid
    finally:
        await db.close()
    logger.info("Feedback #%s (%s) for %s", new_id, body.kind, body.episode_guid)
    if new_id and get_settings().has_llm:
        # Check the report against the transcript and learn from it, after responding.
        background_tasks.add_task(review_feedback, int(new_id))
    return FeedbackOut(
        id=int(new_id or 0), created_at=created_at, review_status="pending", **body.model_dump()
    )


@router.post("/feedback/{feedback_id}/review")
async def rerun_review(
    feedback_id: int,
    x_app_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """(Re)review one report now and return the verdict."""
    check_app_key(x_app_key)
    result = await review_feedback(feedback_id)
    if result["status"] == "missing":
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"id": feedback_id, **result}


@router.get("/show-notes")
async def read_show_notes(
    x_app_key: Annotated[str | None, Header()] = None,
) -> list[dict[str, Any]]:
    """Per-show notes learned from reviewed reports."""
    check_app_key(x_app_key)
    return await list_show_notes()


@router.get("/feedback", response_model=list[FeedbackOut])
async def list_feedback(
    x_app_key: Annotated[str | None, Header()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    episode_guid: str | None = None,
) -> list[FeedbackOut]:
    check_app_key(x_app_key)
    db = await _connect()
    db.row_factory = aiosqlite.Row
    try:
        if episode_guid:
            cur = await db.execute(
                "SELECT * FROM feedback WHERE episode_guid = ? ORDER BY id DESC LIMIT ?",
                (episode_guid, limit),
            )
        else:
            cur = await db.execute("SELECT * FROM feedback ORDER BY id DESC LIMIT ?", (limit,))
        rows = await cur.fetchall()
    finally:
        await db.close()
    return [_row_out(r) for r in rows]


@router.delete("/feedback/{feedback_id}")
async def delete_feedback(
    feedback_id: int,
    x_app_key: Annotated[str | None, Header()] = None,
) -> dict[str, int]:
    check_app_key(x_app_key)
    db = await _connect()
    try:
        cur = await db.execute("DELETE FROM feedback WHERE id = ?", (feedback_id,))
        await db.commit()
        deleted = cur.rowcount
    finally:
        await db.close()
    if not deleted:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"deleted": deleted}
