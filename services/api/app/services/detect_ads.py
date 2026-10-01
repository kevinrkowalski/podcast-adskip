"""Label ad segments from Whisper verbose transcript via cheap LLM (or heuristics)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.config import Settings
from app.models.schemas import AdSegment, map_legacy_segment_type

logger = logging.getLogger(__name__)

# Minimum confidence threshold to emit an ad segment
MIN_CONFIDENCE_THRESHOLD = 0.75

# Edge window for true intro/outro bumps (first/last ~90s)
INTRO_OUTRO_EDGE_MS = 90_000

# Drop very short intro_outro unless already at an edge
INTRO_OUTRO_MIN_MS = 8_000

# Advertisement keyword-gate: only drop low-confidence ads with zero commercial cues
AD_KEYWORD_GATE_CONFIDENCE = 0.9

AD_KEYWORDS = re.compile(
    r"\b(sponsor|sponsored|brought to you by|advertisement|ad break|"
    r"use code|promo code|squarespace|nordvpn|audible|hellofresh|"
    r"our friends at|paid partnership)\b",
    re.IGNORECASE,
)

# Broader commercial cues for post-LLM ad keyword gate (extends AD_KEYWORDS)
COMMERCIAL_KEYWORDS = re.compile(
    r"\b(sponsor|sponsored|sponsorship|brought to you by|advertisement|ad break|"
    r"use code|promo code|promo|discount|percent off|% off|free trial|"
    r"paid partnership|our friends at|visit|sign up|subscribe at|"
    r"check out|learn more|get yours|special offer|limited time|"
    r"squarespace|nordvpn|audible|hellofresh|betterhelp|shopify|"
    r"policygenius|ramp|athletic greens|ag1|ziprecruiter|indeed|"
    r"linkedin|hulu|disney\+|paramount\+|roku|cash app|venmo|"
    r"amazon|walmart|target|apple|google|microsoft)\b|"
    r"\b(brought to you|thanks to our sponsor|this episode is (brought|sponsored)|"
    r"use (the )?code|promo(tional)? code|coupon code)\b",
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
   - Examples: host-read sponsor reads, mid-roll ad breaks, paid product endorsements

2. **intro_outro** - ONLY true episode open/close bumps
   - Theme music + credits / show ID at the VERY START of the episode, OR
   - Closing theme / credits / show ID at the VERY END of the episode
   - MUST be at the absolute beginning or absolute ending of the show
   - FORBIDDEN (never label as intro_outro):
     * Mid-episode stings, bells, bumper music, segment transitions
     * News stings, production sound design, interstitial music beds
     * Mid-show "you're listening to…", network IDs, act breaks
     * Theme snippets replayed in the middle of the episode
     * Any production chrome that is not the real open or close
   - If it is not clearly the episode open or close, do NOT use intro_outro

3. **self_promotion** - Cross-show / network / subscribe plugs
   - Promotion of other shows/content from the same network or creator
   - "Follow us", "Subscribe", "Check out our other show", Patreon/merchandise plugs
   - Platform/network promotional messages
   - Examples: cross-promo of other podcasts, Patreon plugs

NOT SKIPPABLE:
- Show content, even if promotional in tone ("coming up", "stay tuned")
- Topic transitions, segment introductions, act breaks, news stings
- Mid-show production chrome (bells, bumpers, theme snippets, sound design)
- Brief brand mentions in passing without endorsement
- Host banter about products they personally use (unless explicitly sponsored)
- News or editorial content about companies

CONFIDENCE SCORING:
- 0.9-1.0: Explicit clear segment with all markers
- 0.75-0.89: Clear segment with strong indicators
- 0.5-0.74: Likely segment but missing some markers (use sparingly)
- Below 0.5: Don't include (too ambiguous)

Be EXTREMELY STRICT. Prefer to miss a segment than to mislabel content.
If unsure, return an empty segments list. DO NOT LABEL IT.

Return ONLY valid JSON: {"segments":[{"start_s":number,"end_s":number,"type":"advertisement|intro_outro|self_promotion","confidence":0.5-1.0}]}
Empty list if none found."""


def _map_legacy_type(legacy_type: str) -> str:
    """Map legacy segment types to new consolidated types."""
    return map_legacy_segment_type(legacy_type)


def _near_intro_outro_edge(
    start_ms: int,
    end_ms: int,
    total_duration_ms: int | None,
    edge_ms: int = INTRO_OUTRO_EDGE_MS,
) -> bool:
    """True if segment sits in the first or last ~edge_ms of the episode."""
    if start_ms < edge_ms:
        return True
    if total_duration_ms is None or total_duration_ms <= 0:
        # Without duration, only allow leading intro_outro (conservative)
        return False
    return end_ms >= max(0, total_duration_ms - edge_ms) or start_ms >= max(
        0, total_duration_ms - edge_ms
    )


def _transcript_text_in_range(
    transcript: dict[str, Any] | None,
    start_ms: int,
    end_ms: int,
) -> str:
    """Concatenate Whisper segment text overlapping [start_ms, end_ms]."""
    if not transcript:
        return ""
    parts: list[str] = []
    for seg in transcript.get("segments") or []:
        try:
            seg_start = int(float(seg.get("start", 0)) * 1000)
            seg_end = int(float(seg.get("end", 0)) * 1000)
        except (TypeError, ValueError):
            continue
        if seg_end <= start_ms or seg_start >= end_ms:
            continue
        text = (seg.get("text") or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts)


def _post_filter_segments(
    segments: list[AdSegment],
    *,
    total_duration_ms: int | None = None,
    transcript: dict[str, Any] | None = None,
) -> list[AdSegment]:
    """Drop mid-show intro_outro chrome and weak ads with no commercial keywords.

    Applied AFTER LLM parse / heuristics, BEFORE _merge finalize.
    """
    kept: list[AdSegment] = []
    for seg in segments:
        if seg.type == "intro_outro":
            duration = seg.end_ms - seg.start_ms
            at_edge = _near_intro_outro_edge(seg.start_ms, seg.end_ms, total_duration_ms)
            if not at_edge:
                logger.debug(
                    "drop mid-show intro_outro %s-%sms (not near edge)",
                    seg.start_ms,
                    seg.end_ms,
                )
                continue
            if duration < INTRO_OUTRO_MIN_MS:
                # Short bumps at true edges are still allowed; log for tuning
                logger.debug(
                    "keep short edge intro_outro %s-%sms (%sms)",
                    seg.start_ms,
                    seg.end_ms,
                    duration,
                )
            kept.append(seg)
            continue

        if seg.type == "advertisement" and seg.confidence < AD_KEYWORD_GATE_CONFIDENCE:
            overlap = _transcript_text_in_range(transcript, seg.start_ms, seg.end_ms)
            if overlap and not COMMERCIAL_KEYWORDS.search(overlap):
                logger.debug(
                    "drop low-confidence ad %s-%sms (conf=%.2f, no commercial keywords)",
                    seg.start_ms,
                    seg.end_ms,
                    seg.confidence,
                )
                continue
            # If we have no overlapping transcript text, keep (don't gut on missing text)

        kept.append(seg)
    return kept


def _finalize(
    segments: list[AdSegment],
    *,
    total_duration_ms: int | None = None,
    transcript: dict[str, Any] | None = None,
) -> list[AdSegment]:
    """Post-filter then merge into skip-ready segments."""
    filtered = _post_filter_segments(
        segments,
        total_duration_ms=total_duration_ms,
        transcript=transcript,
    )
    return _merge(filtered)


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
    return _finalize(out, total_duration_ms=total_duration_ms, transcript=transcript)


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
    merged = _finalize(all_segs, total_duration_ms=total_duration_ms, transcript=transcript)
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
    merged = _finalize(all_segs, total_duration_ms=total_duration_ms, transcript=transcript)
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
    merged = _finalize(all_segs, total_duration_ms=total_duration_ms, transcript=transcript)
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
