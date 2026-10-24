"""Read-only audit of the Omni quiet-gap pass (every answer, accepted or not)."""

from typing import Annotated, Any

from fastapi import APIRouter, Header, Query

from app.auth import check_app_key
from app.db.omni_gap import list_log_entries

router = APIRouter(prefix="/v1", tags=["omni-gap"])


@router.get("/omni-gap-log")
async def read_omni_gap_log(
    x_app_key: Annotated[str | None, Header()] = None,
    episode_guid: Annotated[str | None, Query(max_length=1000)] = None,
    decision: Annotated[str | None, Query(max_length=40)] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> dict[str, Any]:
    """Newest first. `decision`: accepted, rejected, discarded, no_ads, skipped_music,
    call_failed, bad_json, pass_failed."""
    check_app_key(x_app_key)
    entries = await list_log_entries(episode_guid=episode_guid, decision=decision, limit=limit)
    return {"entries": entries, "count": len(entries)}
