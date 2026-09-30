"""Lightweight RSS helpers (optional server-side use)."""

from __future__ import annotations

from typing import Any

import feedparser


def parse_feed(feed_xml_or_url: str) -> dict[str, Any]:
    """Parse RSS/Atom from URL or raw XML. Prefer client-side for v1."""
    parsed = feedparser.parse(feed_xml_or_url)
    channel = {
        "title": getattr(parsed.feed, "title", None),
        "link": getattr(parsed.feed, "link", None),
        "description": getattr(parsed.feed, "description", None),
        "image": None,
    }
    image = getattr(parsed.feed, "image", None)
    if image:
        channel["image"] = getattr(image, "href", None) or getattr(image, "url", None)

    episodes: list[dict[str, Any]] = []
    for entry in parsed.entries:
        enclosure_url = None
        enclosure_type = None
        enclosure_length = None
        for enc in getattr(entry, "enclosures", []) or []:
            href = enc.get("href") or enc.get("url")
            if href:
                enclosure_url = href
                enclosure_type = enc.get("type")
                enclosure_length = enc.get("length")
                break
        if not enclosure_url:
            for link in getattr(entry, "links", []) or []:
                if link.get("rel") == "enclosure" and link.get("href"):
                    enclosure_url = link["href"]
                    enclosure_type = link.get("type")
                    enclosure_length = link.get("length")
                    break

        guid = getattr(entry, "id", None) or getattr(entry, "guid", None) or enclosure_url
        episodes.append(
            {
                "guid": guid,
                "title": getattr(entry, "title", None),
                "pub_date": getattr(entry, "published", None) or getattr(entry, "updated", None),
                "duration": getattr(entry, "itunes_duration", None),
                "enclosure_url": enclosure_url,
                "enclosure_type": enclosure_type,
                "enclosure_length": enclosure_length,
                "description": getattr(entry, "summary", None),
            }
        )

    return {"channel": channel, "episodes": episodes}
