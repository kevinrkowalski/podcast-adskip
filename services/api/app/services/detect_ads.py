"""Label ad segments from Whisper verbose transcript via cheap LLM (or heuristics)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.config import Settings
from app.models.schemas import AdSegment

logger = logging.getLogger(__name__)

# Minimum confidence threshold to emit an ad segment
MIN_CONFIDENCE_THRESHOLD = 0.75

AD_KEYWORDS = re.compile(
    r"\b(sponsor|sponsored|brought to you by|advertisement|ad break|"
    r"use code|promo code|squarespace|nordvpn|audible|hellofresh|"
    r"our friends at|paid partnership)\b",
    re.IGNORECASE,
)

SYSTEM_PROMPT = """You label podcast ad/sponsor segments from a timed transcript.

SEGMENT TYPES (only these three):

1. **advertisement** - Paid/external brand ads
   - MUST have CLEAR commercial intent with at least TWO of:
     * Brand/product name mentioned (Squarespace, NordVPN, HelloFresh, etc.)
     * Explicit sponsorship language ("sponsored by", "brought to you by", "thanks to our sponsor")
     * Call-to-action ("visit", "use code", "sign up", "get X% off")
     * Promotional offer (discount code, free trial, special deal)
   - Examples: sponsor reads, mid-roll ad breaks, paid product endorsements

2. **intro_outro** - Show open/close bumps worth skipping
   - Theme music, credits, show announcements ("you're listening to...")
   - NOT paid ads, just podcast production elements
   - Often at start/end but can appear anywhere based on content
   - Examples: theme songs, network stings, episode previews/recaps

3. **self_promotion** - Cross-show / network / subscribe plugs
   - Promotion of other shows/content from the same network or creator
   - "Follow us", "Subscribe", "Check out our other show"
   - Platform/network promotional messages
   - Examples: cross-promo of other podcasts, Patreon/merchandise plugs

NOT SKIPPABLE:
- Show content, even if promotional in tone ("coming up", "stay tuned")
- Topic transitions or segment introductions
- Brief brand mentions in passing without endorsement
- Host banter about products they personally use (unless explicitly sponsored)
- News or editorial content about companies

CONFIDENCE SCORING:
- 0.9-1.0: Explicit clear segment with all markers
- 0.75-0.89: Clear segment with strong indicators
- 0.5-0.74: Likely segment but missing some markers (use sparingly)
- Below 0.5: Don't include (too ambiguous)

Be EXTREMELY STRICT. Prefer to miss a segment than to mislabel content.
If unsure, DO NOT LABEL IT.

Return ONLY valid JSON: {"segments":[{"start_s":number,"end_s":number,"type":"advertisement|intro_outro|self_promotion","confidence":0.5-1.0}]}
Empty list if none found."""


def _map_legacy_type(legacy_type: str) -> str:
    """Map legacy segment types to new consolidated types."""
    legacy_to_new = {
        "sponsor": "advertisement",
        "midroll": "advertisement",
        "preroll": "advertisement",
        "postroll": "advertisement",
        "crosspromo": "self_promotion",
        "network": "self_promotion",
        "unknown": "advertisement",
    }
    return legacy_to_new.get(legacy_type, "advertisement")


def heuristic_segments(transcript: dict[str, Any], total_duration_ms: int | None = None) -> list[AdSegment]:
    """Keyword/heuristic fallback used when no LLM key (and for mock smoke tests)."""
    out: list[AdSegment] = []
    for seg in transcript.get("segments") or []:
        text = seg.get("text") or ""
        if AD_KEYWORDS.search(text):
            start_ms = int(float(seg.get("start", 0)) * 1000)
            end_ms = int(float(seg.get("end", 0)) * 1000)
            if end_ms > start_ms:
                kind = "advertisement"
                # Use MIN_CONFIDENCE_THRESHOLD for consistency
                out.append(
                    AdSegment(
                        start_ms=start_ms,
                        end_ms=end_ms,
                        type=kind,
                        confidence=MIN_CONFIDENCE_THRESHOLD,
                    )
                )
    merged = _merge(out)
    return merged


def _prefer_type(type_a: str, type_b: str) -> str:
    """Choose higher-priority type: advertisement > self_promotion > intro_outro."""
    priority = {"advertisement": 3, "self_promotion": 2, "intro_outro": 1}
    return type_a if priority.get(type_a, 0) >= priority.get(type_b, 0) else type_b


def _merge(segments: list[AdSegment], gap_ms: int = 15000, min_duration_ms: int = 5000) -> list[AdSegment]:
    """Merge nearby segments and filter too-short ones.
    
    Args:
        segments: Input ad segments
        gap_ms: Maximum gap between segments to merge (default 15s, increased from 5s per requirements)
        min_duration_ms: Minimum segment duration to keep (default 5s)
    """
    if not segments:
        return []
    
    # First filter by confidence threshold
    filtered = [s for s in segments if s.confidence >= MIN_CONFIDENCE_THRESHOLD]
    if not filtered:
        return []
    
    ordered = sorted(filtered, key=lambda s: s.start_ms)
    merged = [ordered[0]]
    for seg in ordered[1:]:
        last = merged[-1]
        if seg.start_ms <= last.end_ms + gap_ms:
            merged[-1] = AdSegment(
                start_ms=last.start_ms,
                end_ms=max(last.end_ms, seg.end_ms),
                type=_prefer_type(last.type, seg.type),
                confidence=max(last.confidence, seg.confidence),
            )
        else:
            merged.append(seg)
    # Filter out segments shorter than min_duration_ms
    return [s for s in merged if (s.end_ms - s.start_ms) >= min_duration_ms]




def _windows(transcript: dict[str, Any], window_s: float = 120.0) -> list[str]:
    lines: list[str] = []
    for seg in transcript.get("segments") or []:
        lines.append(f"[{seg.get('start', 0):.1f}-{seg.get('end', 0):.1f}] {seg.get('text', '').strip()}")
    # chunk by approximate time windows for the LLM
    chunks: list[str] = []
    buf: list[str] = []
    start = 0.0
    for seg in transcript.get("segments") or []:
        t = float(seg.get("start", 0))
        if buf and t - start > window_s:
            chunks.append("\n".join(buf))
            buf = []
            start = t
        buf.append(f"[{seg.get('start', 0):.1f}-{seg.get('end', 0):.1f}] {seg.get('text', '').strip()}")
    if buf:
        chunks.append("\n".join(buf))
    return chunks or ["\n".join(lines)]


async def label_ads_llm(transcript: dict[str, Any], settings: Settings, total_duration_ms: int | None = None) -> list[AdSegment]:
    """Label ads: OpenRouter chat (default) → Gemini direct → Groq LLM → heuristics."""
    if settings.llm_provider == "gemini" and settings.gemini_ready:
        return await _label_gemini(transcript, settings, total_duration_ms)
    if settings.llm_provider == "groq" and settings.groq_llm_ready:
        return await _label_groq_llm(transcript, settings, total_duration_ms)
    if settings.openrouter_llm_ready:
        return await _label_openrouter(transcript, settings, total_duration_ms)
    if settings.groq_llm_ready:
        return await _label_groq_llm(transcript, settings, total_duration_ms)
    if settings.gemini_ready:
        return await _label_gemini(transcript, settings, total_duration_ms)
    return heuristic_segments(transcript, total_duration_ms)


def _openrouter_headers(settings: Settings) -> dict[str, str]:
    headers: dict[str, str] = {}
    if settings.openrouter_http_referer:
        headers["HTTP-Referer"] = settings.openrouter_http_referer
    if settings.openrouter_app_title:
        headers["X-Title"] = settings.openrouter_app_title
    return headers


async def _label_openrouter(transcript: dict[str, Any], settings: Settings, total_duration_ms: int | None = None) -> list[AdSegment]:
    """Cheap OpenRouter chat model (default google/gemini-2.5-flash)."""
    from openai import OpenAI

    api_key = settings.openrouter_api_key or settings.llm_api_key
    client = OpenAI(
        base_url=settings.openrouter_base_url.rstrip("/"),
        api_key=api_key,
        default_headers=_openrouter_headers(settings) or None,
    )
    all_segs: list[AdSegment] = []
    for chunk in _windows(transcript):
        completion = client.chat.completions.create(
            model=settings.openrouter_llm_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": chunk},
            ],
            temperature=0.1,
            response_format={"type": "json_object"},
        )
        content = completion.choices[0].message.content or "{}"
        all_segs.extend(_parse_llm_json(content))
    merged = _merge(all_segs)
    if not merged:
        return heuristic_segments(transcript, total_duration_ms)
    return merged


async def _label_groq_llm(transcript: dict[str, Any], settings: Settings, total_duration_ms: int | None = None) -> list[AdSegment]:
    """Legacy Groq Llama labeling."""
    from groq import Groq

    client = Groq(api_key=settings.llm_api_key or settings.groq_api_key)
    all_segs: list[AdSegment] = []
    for chunk in _windows(transcript):
        completion = client.chat.completions.create(
            model=settings.groq_llm_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": chunk},
            ],
            temperature=0.1,
            response_format={"type": "json_object"},
        )
        content = completion.choices[0].message.content or "{}"
        all_segs.extend(_parse_llm_json(content))
    merged = _merge(all_segs)
    if not merged:
        return heuristic_segments(transcript, total_duration_ms)
    return merged


async def _label_gemini(transcript: dict[str, Any], settings: Settings, total_duration_ms: int | None = None) -> list[AdSegment]:
    """Optional direct Gemini path. Uses REST to avoid hard dependency on google-genai."""
    import httpx

    key = settings.gemini_api_key or settings.llm_api_key
    model = settings.gemini_model
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    all_segs: list[AdSegment] = []
    async with httpx.AsyncClient(timeout=60.0) as client:
        for chunk in _windows(transcript):
            body = {
                "contents": [{"parts": [{"text": SYSTEM_PROMPT + "\n\n" + chunk}]}],
                "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
            }
            resp = await client.post(url, params={"key": key}, json=body)
            resp.raise_for_status()
            data = resp.json()
            text = (
                data.get("candidates", [{}])[0]
                .get("content", {})
                .get("parts", [{}])[0]
                .get("text", "{}")
            )
            all_segs.extend(_parse_llm_json(text))
    merged = _merge(all_segs)
    if not merged:
        return heuristic_segments(transcript, total_duration_ms)
    return merged


def _parse_llm_json(content: str) -> list[AdSegment]:
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []
    segs = data.get("segments") if isinstance(data, dict) else data
    out: list[AdSegment] = []
    for s in segs or []:
        try:
            if "start_ms" in s:
                start_ms = int(s["start_ms"])
                end_ms = int(s["end_ms"])
            else:
                start_ms = int(float(s.get("start_s", 0)) * 1000)
                end_ms = int(float(s.get("end_s", 0)) * 1000)
            if end_ms <= start_ms:
                continue
            # Map legacy types to new consolidated types
            raw_type = s.get("type") or "advertisement"
            segment_type = _map_legacy_type(raw_type) if raw_type not in ["advertisement", "intro_outro", "self_promotion"] else raw_type
            out.append(
                AdSegment(
                    start_ms=start_ms,
                    end_ms=end_ms,
                    type=segment_type,
                    confidence=float(s.get("confidence", 0.8)),
                )
            )
        except (TypeError, ValueError):
            continue
    return out
