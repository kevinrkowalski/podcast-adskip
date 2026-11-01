"""Per-show notes learned from reviewed ad reports, and their prompt block."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

MAX_SPONSORS = 30
MAX_BREAK_PHRASES = 15
MAX_NOT_ADS = 15
MAX_AD_POSITIONS = 10
MAX_ITEM_CHARS = 80
# Items shown to the labeling model (the most frequent / recent ones).
PROMPT_SPONSORS = 20
PROMPT_PHRASES = 10
PROMPT_NOT_ADS = 8
PROMPT_POSITIONS = 6
# Hints not seen again for this long stop being used (sponsors change, shows move breaks).
LEARNED_MAX_AGE_DAYS = 365

_LIST_LIMITS = {
    "sponsors": MAX_SPONSORS,
    "break_phrases": MAX_BREAK_PHRASES,
    "not_ads": MAX_NOT_ADS,
}


def show_key(feed_url: str | None, fallback_title: str | None = None) -> str | None:
    """Stable key for a show: its normalized feed URL (scheme, www and trailing slash ignored)."""
    if feed_url and feed_url.strip():
        raw = feed_url.strip()
        parts = urlsplit(raw if "://" in raw else f"https://{raw}")
        host = (parts.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host:
            path = parts.path.rstrip("/")
            query = f"?{parts.query}" if parts.query else ""
            return f"feed:{host}{path}{query}"
    if fallback_title and fallback_title.strip():
        return "title:" + re.sub(r"\s+", " ", fallback_title.strip().lower())[:200]
    return None


def _clean_item(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", value)
    text = re.sub(r"\s+", " ", text).strip().strip("\"'“”‘’")
    if not text or len(text) < 2:
        return None
    return text[:MAX_ITEM_CHARS].rstrip()


def empty_notes() -> dict[str, Any]:
    return {
        "sponsors": [],
        "break_phrases": [],
        "not_ads": [],
        "ad_positions": [],
        "confirmed_reports": 0,
        "rejected_reports": 0,
    }


def _as_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _fresh(items: list[Any], now: str) -> list[dict[str, Any]]:
    """Entries seen within LEARNED_MAX_AGE_DAYS of `now` (entries without a date are kept)."""
    try:
        cutoff = _as_utc(now) - timedelta(days=LEARNED_MAX_AGE_DAYS)
    except ValueError:
        cutoff = None
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            stale = cutoff is not None and _as_utc(str(item["last_seen"])) < cutoff
        except (KeyError, ValueError):
            stale = False
        if not stale:
            out.append(item)
    return out


def _rank(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda i: (i.get("count", 1), i.get("last_seen", "")), reverse=True)


def _add_values(items: list[dict[str, Any]], values: list[Any], limit: int, now: str) -> list[dict[str, Any]]:
    by_key = {str(i.get("value", "")).casefold(): i for i in items if i.get("value")}
    for raw in values:
        value = _clean_item(raw)
        if not value:
            continue
        key = value.casefold()
        if key in by_key:
            by_key[key]["count"] = int(by_key[key].get("count", 1)) + 1
            by_key[key]["last_seen"] = now
        else:
            by_key[key] = {"value": value, "count": 1, "last_seen": now}
    return _rank(list(by_key.values()))[:limit]


def merge_learning(
    notes: dict[str, Any] | None,
    *,
    sponsors: list[Any] | None = None,
    break_phrases: list[Any] | None = None,
    not_ads: list[Any] | None = None,
    ad_position: dict[str, Any] | None = None,
    verdict: str | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    """Fold one reviewed report into a show's notes (deduped, bounded)."""
    now = now or datetime.now(timezone.utc).isoformat()
    out = empty_notes()
    if isinstance(notes, dict):
        for key in _LIST_LIMITS:
            if isinstance(notes.get(key), list):
                out[key] = [i for i in _fresh(notes[key], now) if i.get("value")]
        if isinstance(notes.get("ad_positions"), list):
            out["ad_positions"] = _fresh(notes["ad_positions"], now)
        out["confirmed_reports"] = int(notes.get("confirmed_reports") or 0)
        out["rejected_reports"] = int(notes.get("rejected_reports") or 0)
    out["sponsors"] = _add_values(out["sponsors"], list(sponsors or []), MAX_SPONSORS, now)
    out["break_phrases"] = _add_values(out["break_phrases"], list(break_phrases or []), MAX_BREAK_PHRASES, now)
    out["not_ads"] = _add_values(out["not_ads"], list(not_ads or []), MAX_NOT_ADS, now)
    if ad_position:
        try:
            start_ms = int(ad_position["start_ms"])
            end_ms = int(ad_position["end_ms"])
        except (KeyError, TypeError, ValueError):
            start_ms = end_ms = -1
        if 0 <= start_ms < end_ms:
            entry: dict[str, Any] = {"start_ms": start_ms, "end_ms": end_ms, "last_seen": now}
            dur = ad_position.get("episode_duration_ms")
            if isinstance(dur, int) and dur > 0:
                entry["fraction"] = round(start_ms / dur, 3)
            # Replace an existing entry for (roughly) the same break instead of duplicating it.
            kept = [
                p for p in out["ad_positions"]
                if abs(int(p.get("start_ms", -10**9)) - start_ms) > 60_000
            ]
            out["ad_positions"] = (kept + [entry])[-MAX_AD_POSITIONS:]
    if verdict == "confirmed":
        out["confirmed_reports"] += 1
    elif verdict == "rejected":
        out["rejected_reports"] += 1
    return out


def _fmt(ms: int) -> str:
    s = max(0, ms // 1000)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def notes_prompt_block(notes: dict[str, Any] | None, *, now: str | None = None) -> str | None:
    """Short hint block for the labeling prompt, or None when nothing useful was learned.
    Hints not seen for LEARNED_MAX_AGE_DAYS are left out."""
    if not isinstance(notes, dict):
        return None
    now = now or datetime.now(timezone.utc).isoformat()
    lines: list[str] = []

    def values(key: str, limit: int) -> list[str]:
        items = notes.get(key) if isinstance(notes.get(key), list) else []
        return [str(i["value"]) for i in _rank([i for i in _fresh(items, now) if i.get("value")])[:limit]]

    sponsors = values("sponsors", PROMPT_SPONSORS)
    if sponsors:
        lines.append("- Advertisers confirmed in this show's ads: " + "; ".join(sponsors))
    phrases = values("break_phrases", PROMPT_PHRASES)
    if phrases:
        lines.append("- Phrases this show uses going into or out of ad breaks: " + "; ".join(f'"{p}"' for p in phrases))
    positions = _fresh(notes.get("ad_positions") or [], now)[-PROMPT_POSITIONS:]
    if positions:
        spots = ", ".join(
            f"{_fmt(int(p['start_ms']))}-{_fmt(int(p['end_ms']))}"
            for p in sorted(positions, key=lambda p: int(p.get("start_ms", 0)))
            if "start_ms" in p and "end_ms" in p
        )
        if spots:
            lines.append(f"- Ad breaks previously missed in this show's episodes were near: {spots} (positions vary by episode)")
    not_ads = values("not_ads", PROMPT_NOT_ADS)
    if not_ads:
        lines.append("- Recurring show content that is NOT an ad (do not label it): " + "; ".join(not_ads))
    if not lines:
        return None
    return "Learned show notes (from listener reports on earlier episodes; hints only):\n" + "\n".join(lines)
