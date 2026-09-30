"""Label ad segments from Whisper verbose transcript via cheap LLM (or heuristics)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.config import Settings
from app.models.schemas import AdSegment

logger = logging.getLogger(__name__)

AD_KEYWORDS = re.compile(
    r"\b(sponsor|sponsored|brought to you by|advertisement|ad break|"
    r"use code|promo code|squarespace|nordvpn|audible|hellofresh|"
    r"our friends at|paid partnership)\b",
    re.IGNORECASE,
)

SYSTEM_PROMPT = """You label podcast ad/sponsor segments from a timed transcript.
Return ONLY valid JSON: {"segments":[{"start_s":number,"end_s":number,"type":"sponsor|midroll|preroll|postroll|crosspromo|network|unknown","confidence":0-1}]}
Merge contiguous ad talk. Prefer precision over recall. Empty list if none."""


def heuristic_segments(transcript: dict[str, Any]) -> list[AdSegment]:
    """Keyword/heuristic fallback used when no LLM key (and for mock smoke tests)."""
    out: list[AdSegment] = []
    for seg in transcript.get("segments") or []:
        text = seg.get("text") or ""
        if AD_KEYWORDS.search(text):
            start_ms = int(float(seg.get("start", 0)) * 1000)
            end_ms = int(float(seg.get("end", 0)) * 1000)
            if end_ms > start_ms:
                kind = "preroll" if start_ms < 30_000 else "sponsor"
                out.append(
                    AdSegment(
                        start_ms=start_ms,
                        end_ms=end_ms,
                        type=kind,
                        confidence=0.7,
                    )
                )
    return _merge(out)


def _merge(segments: list[AdSegment], gap_ms: int = 2000) -> list[AdSegment]:
    if not segments:
        return []
    ordered = sorted(segments, key=lambda s: s.start_ms)
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
    return merged


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


async def label_ads_llm(transcript: dict[str, Any], settings: Settings) -> list[AdSegment]:
    """Label ads: OpenRouter chat (default) → Gemini direct → Groq LLM → heuristics."""
    if settings.llm_provider == "gemini" and settings.gemini_ready:
        return await _label_gemini(transcript, settings)
    if settings.llm_provider == "groq" and settings.groq_llm_ready:
        return await _label_groq_llm(transcript, settings)
    if settings.openrouter_llm_ready:
        return await _label_openrouter(transcript, settings)
    if settings.groq_llm_ready:
        return await _label_groq_llm(transcript, settings)
    if settings.gemini_ready:
        return await _label_gemini(transcript, settings)
    return heuristic_segments(transcript)


def _openrouter_headers(settings: Settings) -> dict[str, str]:
    headers: dict[str, str] = {}
    if settings.openrouter_http_referer:
        headers["HTTP-Referer"] = settings.openrouter_http_referer
    if settings.openrouter_app_title:
        headers["X-Title"] = settings.openrouter_app_title
    return headers


async def _label_openrouter(transcript: dict[str, Any], settings: Settings) -> list[AdSegment]:
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
    return _merge(all_segs) or heuristic_segments(transcript)


async def _label_groq_llm(transcript: dict[str, Any], settings: Settings) -> list[AdSegment]:
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
    return _merge(all_segs) or heuristic_segments(transcript)


async def _label_gemini(transcript: dict[str, Any], settings: Settings) -> list[AdSegment]:
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
    return _merge(all_segs) or heuristic_segments(transcript)


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
