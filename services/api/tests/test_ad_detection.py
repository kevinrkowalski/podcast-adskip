"""Unit tests for ad detection post-filters and merge behavior."""

import os

os.environ["MOCK_ANALYZE"] = "true"
os.environ["DATABASE_PATH"] = "data/test_skip_maps.db"

from app.models.schemas import AdSegment
from app.services.detect_ads import (
    MIN_CONFIDENCE_THRESHOLD,
    _finalize,
    _merge,
    _post_filter_segments,
    heuristic_segments,
)


def test_merge_filters_low_confidence():
    segments = [
        AdSegment(start_ms=0, end_ms=10000, type="advertisement", confidence=0.5),
        AdSegment(start_ms=20000, end_ms=30000, type="advertisement", confidence=0.9),
    ]
    result = _merge(segments)
    assert len(result) == 1
    assert result[0].start_ms == 20000


def test_merge_nearby_within_15s_gap():
    segments = [
        AdSegment(start_ms=60000, end_ms=70000, type="advertisement", confidence=0.8),
        AdSegment(start_ms=80000, end_ms=90000, type="advertisement", confidence=0.9),  # 10s gap
    ]
    result = _merge(segments)
    assert len(result) == 1
    assert result[0].start_ms == 60000
    assert result[0].end_ms == 90000
    assert result[0].confidence == 0.9


def test_merge_distant_stay_separate():
    segments = [
        AdSegment(start_ms=10000, end_ms=20000, type="advertisement", confidence=0.8),
        AdSegment(start_ms=50000, end_ms=60000, type="advertisement", confidence=0.9),  # 30s gap
    ]
    result = _merge(segments)
    assert len(result) == 2


def test_merge_drops_short_standalone():
    segments = [
        AdSegment(start_ms=0, end_ms=2000, type="advertisement", confidence=0.9),
        AdSegment(start_ms=60000, end_ms=70000, type="advertisement", confidence=0.9),
    ]
    result = _merge(segments)
    assert len(result) == 1
    assert result[0].start_ms == 60000


def test_merge_type_priority():
    segments = [
        AdSegment(start_ms=10000, end_ms=20000, type="intro_outro", confidence=0.8),
        AdSegment(start_ms=22000, end_ms=32000, type="advertisement", confidence=0.85),
    ]
    result = _merge(segments)
    assert len(result) == 1
    assert result[0].type == "advertisement"


def test_drop_mid_show_intro_outro():
    segments = [
        AdSegment(start_ms=5000, end_ms=20000, type="intro_outro", confidence=0.95),  # open OK
        AdSegment(start_ms=300000, end_ms=310000, type="intro_outro", confidence=0.95),  # mid sting
        AdSegment(start_ms=1710000, end_ms=1740000, type="intro_outro", confidence=0.95),  # close OK
    ]
    filtered = _post_filter_segments(segments, total_duration_ms=1800000)
    assert [s.start_ms for s in filtered] == [5000, 1710000]


def test_intro_outro_without_duration_keeps_only_leading():
    segments = [
        AdSegment(start_ms=10000, end_ms=25000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=100000, end_ms=115000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=3500000, end_ms=3520000, type="intro_outro", confidence=0.9),
    ]
    filtered = _post_filter_segments(segments, total_duration_ms=None)
    assert len(filtered) == 1
    assert filtered[0].start_ms == 10000


def test_ad_keyword_gate_drops_low_conf_without_cues():
    transcript = {
        "segments": [
            {"start": 300.0, "end": 320.0, "text": "And now back to our story about the weather."},
        ]
    }
    segments = [
        AdSegment(start_ms=300000, end_ms=320000, type="advertisement", confidence=0.8),
    ]
    filtered = _post_filter_segments(
        segments, total_duration_ms=1800000, transcript=transcript
    )
    assert filtered == []


def test_ad_keyword_gate_keeps_high_conf_without_cues():
    transcript = {
        "segments": [
            {"start": 300.0, "end": 320.0, "text": "mumbled unclear host read audio"},
        ]
    }
    segments = [
        AdSegment(start_ms=300000, end_ms=320000, type="advertisement", confidence=0.95),
    ]
    filtered = _post_filter_segments(
        segments, total_duration_ms=1800000, transcript=transcript
    )
    assert len(filtered) == 1


def test_ad_keyword_gate_keeps_low_conf_with_sponsor_language():
    transcript = {
        "segments": [
            {
                "start": 300.0,
                "end": 320.0,
                "text": "This episode is brought to you by Squarespace. Use code POD for 10% off.",
            },
        ]
    }
    segments = [
        AdSegment(start_ms=300000, end_ms=320000, type="advertisement", confidence=0.8),
    ]
    filtered = _post_filter_segments(
        segments, total_duration_ms=1800000, transcript=transcript
    )
    assert len(filtered) == 1


def test_finalize_drops_mid_sting_then_merges():
    segments = [
        AdSegment(start_ms=0, end_ms=15000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=400000, end_ms=405000, type="intro_outro", confidence=0.9),  # sting
        AdSegment(start_ms=600000, end_ms=620000, type="advertisement", confidence=0.9),
        AdSegment(start_ms=625000, end_ms=640000, type="advertisement", confidence=0.85),
    ]
    result = _finalize(segments, total_duration_ms=1800000)
    starts = [s.start_ms for s in result]
    assert 0 in starts
    assert 400000 not in starts
    assert any(s.start_ms == 600000 for s in result)


def test_heuristic_segments_basic():
    transcript = {
        "segments": [
            {"start": 10.0, "end": 25.0, "text": "This episode is sponsored by Squarespace"},
            {"start": 26.0, "end": 40.0, "text": "Use code PODCAST for 10% off"},
            {"start": 300.0, "end": 302.0, "text": "And now a word from our sponsor"},
        ]
    }
    result = heuristic_segments(transcript, 1800000)
    assert len(result) >= 1
    assert all(s.confidence >= MIN_CONFIDENCE_THRESHOLD for s in result)
    assert all(s.type == "advertisement" for s in result)


def test_empty_handling():
    assert _merge([]) == []
    assert _post_filter_segments([]) == []
    assert _finalize([]) == []
