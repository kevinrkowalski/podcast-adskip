"""Unit tests for ad detection improvements (merge, filter, position fixing)."""

import os

os.environ["MOCK_ANALYZE"] = "true"
os.environ["DATABASE_PATH"] = "data/test_skip_maps.db"

from app.models.schemas import AdSegment
from app.services.detect_ads import _fix_position_labels, _merge, heuristic_segments


def test_merge_with_min_duration_filter():
    """Test that segments shorter than min_duration_ms are filtered out."""
    segments = [
        AdSegment(start_ms=0, end_ms=2000, type="preroll", confidence=0.8),  # 2s - too short alone
        AdSegment(start_ms=5000, end_ms=10000, type="sponsor", confidence=0.9),  # 5s - within 5s gap, meets min
        AdSegment(start_ms=12000, end_ms=14000, type="midroll", confidence=0.8),  # 2s - within 5s gap
        AdSegment(start_ms=25000, end_ms=31000, type="sponsor", confidence=0.85),  # 6s - separate (>5s gap)
    ]
    
    # Default min_duration_ms = 5000 (5 seconds), gap_ms = 5000
    # First three merge together (all within 5s gaps), fourth stays separate
    result = _merge(segments)
    
    assert len(result) == 2
    # First merged segment: 0-14000 (14s total, merges short segments together)
    assert result[0].start_ms == 0
    assert result[0].end_ms == 14000
    # Second segment stays separate
    assert result[1].start_ms == 25000
    assert result[1].end_ms == 31000


def test_merge_filters_standalone_short_segments():
    """Test that standalone short segments are filtered out."""
    segments = [
        AdSegment(start_ms=0, end_ms=2000, type="preroll", confidence=0.8),  # 2s - too short, isolated
        AdSegment(start_ms=50000, end_ms=56000, type="sponsor", confidence=0.9),  # 6s - OK, isolated
    ]
    
    result = _merge(segments)
    
    # First segment is too short and can't merge with anything, so it's filtered
    assert len(result) == 1
    assert result[0].start_ms == 50000
    assert result[0].end_ms == 56000


def test_merge_filters_low_confidence_segments():
    """Test that segments below MIN_CONFIDENCE_THRESHOLD are filtered out."""
    segments = [
        AdSegment(start_ms=0, end_ms=10000, type="preroll", confidence=0.6),  # Low confidence - filtered
        AdSegment(start_ms=20000, end_ms=30000, type="sponsor", confidence=0.74),  # Just below threshold - filtered
        AdSegment(start_ms=40000, end_ms=50000, type="sponsor", confidence=0.75),  # At threshold - kept
        AdSegment(start_ms=60000, end_ms=70000, type="midroll", confidence=0.9),  # High confidence - kept
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
        AdSegment(start_ms=60000, end_ms=63000, type="sponsor", confidence=0.8),
        AdSegment(start_ms=65000, end_ms=68000, type="sponsor", confidence=0.9),  # 2s gap
        AdSegment(start_ms=69000, end_ms=72000, type="sponsor", confidence=0.85),  # 1s gap
    ]
    
    # Default gap_ms = 5000 (5 seconds)
    result = _merge(segments)
    
    # All three should merge into one because gaps are < 5s
    assert len(result) == 1
    assert result[0].start_ms == 60000
    assert result[0].end_ms == 72000
    assert result[0].confidence == 0.9  # Takes max confidence


def test_merge_distant_segments_stay_separate():
    """Test that segments with large gaps remain separate."""
    segments = [
        AdSegment(start_ms=10000, end_ms=15000, type="sponsor", confidence=0.8),
        AdSegment(start_ms=25000, end_ms=30000, type="midroll", confidence=0.9),  # 10s gap
    ]
    
    result = _merge(segments)
    
    assert len(result) == 2
    assert result[0].start_ms == 10000
    assert result[1].start_ms == 25000


def test_fix_position_labels_preroll_in_middle():
    """Test that 'preroll' labels in the middle of episode are changed to 'midroll'."""
    segments = [
        AdSegment(start_ms=30000, end_ms=35000, type="preroll", confidence=0.9),  # 30s - valid preroll
        AdSegment(start_ms=180000, end_ms=185000, type="preroll", confidence=0.9),  # 3min - wrong!
        AdSegment(start_ms=600000, end_ms=605000, type="preroll", confidence=0.9),  # 10min - wrong!
    ]
    
    total_duration_ms = 1800000  # 30 minute episode
    result = _fix_position_labels(segments, total_duration_ms)
    
    assert result[0].type == "preroll"  # 30s - stays preroll (< 90s)
    assert result[1].type == "midroll"  # 3min - changed to midroll
    assert result[2].type == "midroll"  # 10min - changed to midroll


def test_fix_position_labels_preroll_threshold():
    """Test that preroll is only valid in first 90 seconds."""
    segments = [
        AdSegment(start_ms=10000, end_ms=15000, type="preroll", confidence=0.9),  # 10s - valid
        AdSegment(start_ms=85000, end_ms=88000, type="preroll", confidence=0.9),  # 85s - valid
        AdSegment(start_ms=95000, end_ms=100000, type="preroll", confidence=0.9),  # 95s - invalid
    ]
    
    total_duration_ms = 1800000
    result = _fix_position_labels(segments, total_duration_ms)
    
    assert result[0].type == "preroll"
    assert result[1].type == "preroll"
    assert result[2].type == "midroll"  # Changed because > 90s


def test_fix_position_labels_postroll():
    """Test that postroll labels are fixed based on position from end."""
    segments = [
        AdSegment(start_ms=600000, end_ms=605000, type="postroll", confidence=0.9),  # 10min - too early
        AdSegment(start_ms=1680000, end_ms=1685000, type="postroll", confidence=0.9),  # Last 2min - valid
    ]
    
    total_duration_ms = 1800000  # 30 minute episode
    result = _fix_position_labels(segments, total_duration_ms)
    
    assert result[0].type == "midroll"  # 10 minutes from end - changed
    assert result[1].type == "postroll"  # Last 2 minutes - stays postroll


def test_fix_position_labels_promotes_midroll_at_start():
    """Test that midroll at the start gets promoted to preroll."""
    segments = [
        AdSegment(start_ms=15000, end_ms=20000, type="midroll", confidence=0.8),  # 15s - should be preroll
        AdSegment(start_ms=300000, end_ms=305000, type="midroll", confidence=0.8),  # 5min - stays midroll
    ]
    
    total_duration_ms = 1800000
    result = _fix_position_labels(segments, total_duration_ms)
    
    assert result[0].type == "preroll"  # Promoted
    assert result[1].type == "midroll"  # Unchanged


def test_fix_position_labels_promotes_midroll_at_end():
    """Test that midroll near the end gets promoted to postroll."""
    segments = [
        AdSegment(start_ms=300000, end_ms=305000, type="midroll", confidence=0.8),  # 5min - stays midroll
        AdSegment(start_ms=1700000, end_ms=1705000, type="midroll", confidence=0.8),  # Last 100s - postroll
    ]
    
    total_duration_ms = 1800000  # 30 minute episode
    result = _fix_position_labels(segments, total_duration_ms)
    
    assert result[0].type == "midroll"  # Unchanged
    assert result[1].type == "postroll"  # Promoted


def test_heuristic_segments_with_duration():
    """Test that heuristic_segments applies merge and position fixing."""
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
    
    # First segment should be labeled preroll (starts at 10s)
    first = next((s for s in result if s.start_ms < 20000), None)
    assert first is not None
    assert first.type == "preroll"
    
    # Last segment should be sponsor/midroll (at 10 minutes, not near end)
    last = next((s for s in result if s.start_ms >= 600000), None)
    assert last is not None
    assert last.type in ("midroll", "sponsor")


def test_merge_preserves_type_priority():
    """Test that merge prefers specific types over 'unknown'."""
    segments = [
        AdSegment(start_ms=10000, end_ms=13000, type="unknown", confidence=0.8),
        AdSegment(start_ms=14000, end_ms=19000, type="sponsor", confidence=0.85),
    ]
    
    result = _merge(segments)
    
    assert len(result) == 1
    assert result[0].type == "sponsor"  # Kept the more specific type


def test_empty_segments_handling():
    """Test that empty segment lists are handled gracefully."""
    assert _merge([]) == []
    assert _fix_position_labels([]) == []
    assert _fix_position_labels([], 1800000) == []


def test_realistic_bad_detection_scenario():
    """Test the exact scenario from the user's screenshot."""
    segments = [
        # Several near-zero-length segments labeled as preroll
        AdSegment(start_ms=792000, end_ms=793000, type="preroll", confidence=0.9),  # 13:12-13:13 (1s)
        AdSegment(start_ms=798000, end_ms=798000, type="preroll", confidence=0.9),  # 13:18-13:18 (0s!)
        # Slightly longer segment but still mid-episode
        AdSegment(start_ms=900000, end_ms=908000, type="preroll", confidence=0.9),  # 15:00-15:08 (8s)
        # Long sponsor segment
        AdSegment(start_ms=802000, end_ms=894000, type="sponsor", confidence=0.9),  # 13:22-14:54 (92s)
    ]
    
    total_duration_ms = 2400000  # 40 minute episode
    
    # First apply merge (should drop very short segments and merge nearby ones)
    merged = _merge(segments)
    
    # Should filter out the 0s and 1s segments (< 5s threshold)
    # Remaining segments should be fixed for position
    fixed = _fix_position_labels(merged, total_duration_ms)
    
    # Check results
    for seg in fixed:
        # No preroll should exist at 13+ minutes
        if seg.start_ms > 90000:  # After 90 seconds
            assert seg.type != "preroll", f"Found preroll at {seg.start_ms}ms - should be midroll/sponsor"
        
        # All segments should be at least 5 seconds
        duration = seg.end_ms - seg.start_ms
        assert duration >= 5000, f"Segment duration {duration}ms is too short"
    
    # Should have merged some of the nearby segments
    assert len(fixed) <= 2, "Should have merged nearby segments"
