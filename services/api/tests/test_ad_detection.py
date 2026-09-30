"""Unit tests for ad detection improvements (merge, filter, legacy mapping)."""

import os

os.environ["MOCK_ANALYZE"] = "true"
os.environ["DATABASE_PATH"] = "data/test_skip_maps.db"

from app.models.schemas import AdSegment
from app.services.detect_ads import _map_legacy_type, _merge, _prefer_type, heuristic_segments


def test_legacy_type_mapping():
    """Test that legacy segment types are mapped to new consolidated types."""
    assert _map_legacy_type("sponsor") == "advertisement"
    assert _map_legacy_type("midroll") == "advertisement"
    assert _map_legacy_type("preroll") == "advertisement"
    assert _map_legacy_type("postroll") == "advertisement"
    assert _map_legacy_type("crosspromo") == "self_promotion"
    assert _map_legacy_type("network") == "self_promotion"
    assert _map_legacy_type("unknown") == "advertisement"


def test_type_preference():
    """Test that type priority works: advertisement > self_promotion > intro_outro."""
    assert _prefer_type("advertisement", "self_promotion") == "advertisement"
    assert _prefer_type("advertisement", "intro_outro") == "advertisement"
    assert _prefer_type("self_promotion", "intro_outro") == "self_promotion"
    assert _prefer_type("intro_outro", "advertisement") == "advertisement"
    assert _prefer_type("self_promotion", "advertisement") == "advertisement"
    assert _prefer_type("intro_outro", "self_promotion") == "self_promotion"


def test_merge_with_min_duration_filter():
    """Test that segments shorter than min_duration_ms are filtered out."""
    segments = [
        AdSegment(start_ms=0, end_ms=2000, type="advertisement", confidence=0.8),  # 2s - too short alone
        AdSegment(start_ms=5000, end_ms=10000, type="advertisement", confidence=0.9),  # 5s - within 15s gap, meets min
        AdSegment(start_ms=12000, end_ms=14000, type="advertisement", confidence=0.8),  # 2s - within 15s gap
        AdSegment(start_ms=35000, end_ms=41000, type="advertisement", confidence=0.85),  # 6s - separate (>15s gap)
    ]
    
    # Default min_duration_ms = 5000 (5 seconds), gap_ms = 15000 (15 seconds)
    # First three merge together (all within 15s gaps), fourth stays separate
    result = _merge(segments)
    
    assert len(result) == 2
    # First merged segment: 0-14000 (14s total, merges short segments together)
    assert result[0].start_ms == 0
    assert result[0].end_ms == 14000
    # Second segment stays separate
    assert result[1].start_ms == 35000
    assert result[1].end_ms == 41000


def test_merge_filters_standalone_short_segments():
    """Test that standalone short segments are filtered out."""
    segments = [
        AdSegment(start_ms=0, end_ms=2000, type="advertisement", confidence=0.8),  # 2s - too short, isolated
        AdSegment(start_ms=50000, end_ms=56000, type="advertisement", confidence=0.9),  # 6s - OK, isolated
    ]
    
    result = _merge(segments)
    
    # First segment is too short and can't merge with anything, so it's filtered
    assert len(result) == 1
    assert result[0].start_ms == 50000
    assert result[0].end_ms == 56000


def test_merge_filters_low_confidence_segments():
    """Test that segments below MIN_CONFIDENCE_THRESHOLD are filtered out."""
    segments = [
        AdSegment(start_ms=0, end_ms=10000, type="advertisement", confidence=0.6),  # Low confidence - filtered
        AdSegment(start_ms=20000, end_ms=30000, type="advertisement", confidence=0.74),  # Just below threshold - filtered
        AdSegment(start_ms=40000, end_ms=50000, type="advertisement", confidence=0.75),  # At threshold - kept
        AdSegment(start_ms=60000, end_ms=70000, type="advertisement", confidence=0.9),  # High confidence - kept
    ]
    
    result = _merge(segments)
    
    # Only segments with confidence >= 0.75 should remain
    assert len(result) == 2
    assert result[0].start_ms == 40000
    assert result[0].confidence >= 0.75
    assert result[1].start_ms == 60000
    assert result[1].confidence >= 0.75


def test_merge_nearby_segments():
    """Test that segments within gap_ms are merged together."""
    segments = [
        AdSegment(start_ms=60000, end_ms=63000, type="advertisement", confidence=0.8),
        AdSegment(start_ms=65000, end_ms=68000, type="advertisement", confidence=0.9),  # 2s gap
        AdSegment(start_ms=69000, end_ms=72000, type="advertisement", confidence=0.85),  # 1s gap
    ]
    
    # Default gap_ms = 15000 (15 seconds)
    result = _merge(segments)
    
    # All three should merge into one because gaps are < 15s
    assert len(result) == 1
    assert result[0].start_ms == 60000
    assert result[0].end_ms == 72000
    assert result[0].confidence == 0.9  # Takes max confidence


def test_merge_distant_segments_stay_separate():
    """Test that segments with large gaps remain separate."""
    segments = [
        AdSegment(start_ms=10000, end_ms=15000, type="advertisement", confidence=0.8),
        AdSegment(start_ms=32000, end_ms=37000, type="advertisement", confidence=0.9),  # 17s gap (> 15s)
    ]
    
    result = _merge(segments)
    
    assert len(result) == 2
    assert result[0].start_ms == 10000
    assert result[1].start_ms == 32000


def test_merge_preserves_type_priority():
    """Test that merge prefers higher-priority types."""
    segments = [
        AdSegment(start_ms=10000, end_ms=13000, type="intro_outro", confidence=0.8),
        AdSegment(start_ms=14000, end_ms=19000, type="advertisement", confidence=0.85),  # 1s gap, within 15s
    ]
    
    result = _merge(segments)
    
    assert len(result) == 1
    assert result[0].type == "advertisement"  # Kept the higher-priority type


def test_merge_type_priority_self_promotion():
    """Test that self_promotion has priority over intro_outro."""
    segments = [
        AdSegment(start_ms=10000, end_ms=15000, type="intro_outro", confidence=0.8),
        AdSegment(start_ms=16000, end_ms=21000, type="self_promotion", confidence=0.85),  # 1s gap, within 15s
    ]
    
    result = _merge(segments)
    
    assert len(result) == 1
    assert result[0].type == "self_promotion"  # Higher priority than intro_outro


def test_merge_type_priority_all_three():
    """Test type priority with all three types nearby."""
    segments = [
        AdSegment(start_ms=10000, end_ms=13000, type="intro_outro", confidence=0.8),
        AdSegment(start_ms=15000, end_ms=18000, type="self_promotion", confidence=0.85),
        AdSegment(start_ms=20000, end_ms=25000, type="advertisement", confidence=0.9),
    ]
    
    result = _merge(segments)
    
    # All should merge (gaps < 15s), advertisement has highest priority
    assert len(result) == 1
    assert result[0].type == "advertisement"


def test_heuristic_segments_with_duration():
    """Test that heuristic_segments applies merge with new default type."""
    transcript = {
        "segments": [
            {"start": 10.0, "end": 12.0, "text": "This episode is sponsored by Squarespace"},
            {"start": 12.0, "end": 13.0, "text": "Use code PODCAST for 10% off"},
            {"start": 13.5, "end": 16.0, "text": "Visit squarespace.com to sign up today"},  # Has keyword
            {"start": 300.0, "end": 301.0, "text": "And now a word from our sponsor"},  # Too short alone
            {"start": 600.0, "end": 610.0, "text": "Thanks to NordVPN for sponsoring this episode"},
        ]
    }
    
    total_duration_ms = 1800000  # 30 minutes
    result = heuristic_segments(transcript, total_duration_ms)
    
    # First three should merge into one segment (small gaps), meets 5s minimum (10-16s = 6s)
    # 300s segment is too short after merge rules (1s, isolated)
    # Last segment should stay (10s duration)
    assert len(result) >= 1
    
    # All segments should be labeled as advertisement (new default for heuristics)
    for seg in result:
        assert seg.type == "advertisement"
    
    # First segment should start around 10s
    first = next((s for s in result if s.start_ms < 20000), None)
    assert first is not None




def test_empty_segments_handling():
    """Test that empty segment lists are handled gracefully."""
    assert _merge([]) == []


def test_realistic_merge_scenario():
    """Test merge scenario with multiple nearby segments."""
    segments = [
        # Several short segments close together
        AdSegment(start_ms=792000, end_ms=793000, type="advertisement", confidence=0.9),  # 13:12-13:13 (1s)
        AdSegment(start_ms=798000, end_ms=798000, type="advertisement", confidence=0.9),  # 13:18-13:18 (0s - invalid)
        # Slightly longer segment but still nearby
        AdSegment(start_ms=900000, end_ms=908000, type="advertisement", confidence=0.9),  # 15:00-15:08 (8s)
        # Long segment nearby
        AdSegment(start_ms=802000, end_ms=894000, type="advertisement", confidence=0.9),  # 13:22-14:54 (92s)
    ]
    
    total_duration_ms = 2400000  # 40 minute episode
    
    # Apply merge (should drop zero-length segments and merge nearby ones)
    merged = _merge(segments)
    
    # Check results
    for seg in merged:
        # All segments should be at least 5 seconds
        duration = seg.end_ms - seg.start_ms
        assert duration >= 5000, f"Segment duration {duration}ms is too short"
    
    # Should have merged nearby segments within the 15s gap
    assert len(merged) <= 2, "Should have merged nearby segments"
