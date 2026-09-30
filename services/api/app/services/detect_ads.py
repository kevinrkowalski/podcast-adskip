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

WHAT IS AN AD - STRICT CRITERIA:
An ad segment MUST have CLEAR commercial intent with at least TWO of:
1. Brand/product name mentioned (Squarespace, NordVPN, HelloFresh, etc.)
2. Explicit sponsorship language ("sponsored by", "brought to you by", "thanks to our sponsor")
3. Call-to-action ("visit", "use code", "sign up", "get X% off")
4. Promotional offer (discount code, free trial, special deal)

NOT AN AD:
- Show content, even if promotional in tone ("coming up", "stay tuned")
- Topic transitions or segment introductions
- Brief brand mentions in passing without endorsement
- Music, sound effects, or silence
- Host banter about products they personally use (unless explicitly sponsored)
- News or editorial content about companies

LABEL TYPES:
- preroll: ONLY ads in first 90 seconds
- postroll: ONLY ads in final 2 minutes  
- sponsor: Host-read product endorsements (use this for clear sponsorships)
- midroll: Generic mid-episode ad breaks
- crosspromo: Cross-promotion of other shows/content
- network: Network/platform promotional messages

CONFIDENCE SCORING:
- 0.9-1.0: Explicit sponsor read with brand + offer + CTA
- 0.75-0.89: Clear ad with brand + endorsement language
- 0.5-0.74: Likely ad but missing some markers (use sparingly)
- Below 0.5: Don't include (too ambiguous)

Be EXTREMELY STRICT. Prefer to miss an ad than to mislabel content as an ad.
If unsure whether something is an ad, DO NOT LABEL IT.

Return ONLY valid JSON: {"segments":[{"start_s":number,"end_s":number,"type":"sponsor|midroll|preroll|postroll|crosspromo|network","confidence":0.5-1.0}]}
Empty list if none found."""


def heuristic_segments(transcript: dict[str, Any], total_duration_ms: int | None = None) -> list[AdSegment]:
    """Keyword/heuristic fallback used when no LLM key (and for mock smoke tests)."""
    out: list[AdSegment] = []
    for seg in transcript.get("segments") or []:
        text = seg.get("text") or ""
        if AD_KEYWORDS.search(text):
            start_ms = int(float(seg.get("start", 0)) * 1000)
            end_ms = int(float(seg.get("end", 0)) * 1000)
            if end_ms > start_ms:
                kind = "sponsor"
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
    return _fix_position_labels(merged, total_duration_ms)


def _merge(segments: list[AdSegment], gap_ms: int = 5000, min_duration_ms: int = 5000) -> list[AdSegment]:
    """Merge nearby segments and filter too-short ones.
    
    Args:
        segments: Input ad segments
        gap_ms: Maximum gap between segments to merge (default 5s)
        min_duration_ms: Minimum segment duration to keep (default 5s, increased from 3s)
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
                type=last.type if last.type != "unknown" else seg.type,
                confidence=max(last.confidence, seg.confidence),
            )
        else:
            merged.append(seg)
    # Filter out segments shorter than min_duration_ms
    return [s for s in merged if (s.end_ms - s.start_ms) >= min_duration_ms]


def _fix_position_labels(segments: list[AdSegment], total_duration_ms: int | None = None) -> list[AdSegment]:
    """Fix misclassified preroll/postroll based on actual position in episode.
    
    Args:
        segments: Input ad segments (should already be merged/filtered)
        total_duration_ms: Total episode duration; if None, uses the last segment's end time
    
    Returns:
        Segments with corrected position-based labels
    """
    if not segments:
        return []
    
    # Estimate total duration if not provided
    if total_duration_ms is None:
        total_duration_ms = max(s.end_ms for s in segments) + 60_000  # add buffer
    
    PREROLL_THRESHOLD_MS = 90_000  # First 90 seconds
    POSTROLL_THRESHOLD_MS = 120_000  # Last 2 minutes
    
    fixed = []
    for seg in segments:
        new_type = seg.type
        
        # Fix preroll: only valid in first 90 seconds
        if seg.type == "preroll" and seg.start_ms > PREROLL_THRESHOLD_MS:
            new_type = "midroll"  # Change mid-episode "preroll" to "midroll"
        
        # Fix postroll: only valid in last 2 minutes
        if seg.type == "postroll":
            time_from_end = total_duration_ms - seg.start_ms
            if time_from_end > POSTROLL_THRESHOLD_MS:
                new_type = "midroll"  # Change early "postroll" to "midroll"
        
        # Promote midroll/unknown/sponsor at start to preroll
        if seg.type in ("midroll", "unknown", "sponsor") and seg.start_ms < PREROLL_THRESHOLD_MS:
            new_type = "preroll"
        
        # Promote midroll/unknown/sponsor at end to postroll
        if seg.type in ("midroll", "unknown", "sponsor"):
            time_from_end = total_duration_ms - seg.start_ms
            if time_from_end < POSTROLL_THRESHOLD_MS:
                new_type = "postroll"
        
        fixed.append(
            AdSegment(
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                type=new_type,
                confidence=seg.confidence,
            )
        )
    
    return fixed


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
    return _fix_position_labels(merged, total_duration_ms)


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
    return _fix_position_labels(merged, total_duration_ms)


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
    return _fix_position_labels(merged, total_duration_ms)


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
            out.append(
                AdSegment(
                    start_ms=start_ms,
                    end_ms=end_ms,
                    type=s.get("type") or "unknown",
                    confidence=float(s.get("confidence", 0.8)),
                )
            )
        except (TypeError, ValueError):
            continue
    return out
