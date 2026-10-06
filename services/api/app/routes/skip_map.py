from datetime import datetime

from fastapi import APIRouter, Header

from app.auth import check_app_key
from app.db import get_skip_map
from app.models.schemas import SkipMapResponse

router = APIRouter(prefix="/v1", tags=["skip-map"])


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


@router.get("/skip-map/{episode_guid:path}", response_model=SkipMapResponse)
async def read_skip_map(
    episode_guid: str,
    x_app_key: str | None = Header(default=None),
) -> SkipMapResponse:
    check_app_key(x_app_key)
    row = await get_skip_map(episode_guid)
    if not row:
        return SkipMapResponse(status="missing", episode_guid=episode_guid)
    return SkipMapResponse(
        status=row["status"] if row["status"] in ("ready", "pending", "error") else "missing",
        episode_guid=episode_guid,
        segments=row.get("segments") or [],
        model=row.get("model"),
        analyzed_at=_parse_dt(row.get("analyzed_at")),
        message=row.get("message"),
        audio_url=row.get("audio_url"),
        analyzed_audio_size_bytes=row.get("analyzed_audio_size_bytes"),
        analyzed_audio_duration_ms=row.get("analyzed_audio_duration_ms"),
        stage=row.get("stage"),
        stage_label=row.get("stage_label"),
        progress_pct=row.get("progress_pct"),
        eta_seconds=row.get("eta_seconds"),
        started_at=_parse_dt(row.get("started_at")),
    )
