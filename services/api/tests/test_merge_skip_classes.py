"""Ads never merge with intro/outro (or unknown) spans: each keeps its own skip class."""
from app.models.schemas import AdSegment
from app.services.detect_ads import _merge, _validated_segments


def _seg(start, end, text):
    return {"start": start, "end": end, "text": text}


def _shape(segments):
    return [(s.start_ms, s.end_ms, s.type) for s in segments]


def test_ad_adjacent_to_intro_stays_an_ad():
    # Talarico-like: show intro, then a sponsor read right after it.
    tr = {
        "duration": 2400.0,
        "segments": [
            _seg(0.0, 30.0, "From The New York Times, this is The Daily."),
            _seg(31.0, 67.0, "This episode is brought to you by Vanta."),
            _seg(68.0, 90.0, "Today, a conversation with James Talarico."),
        ],
    }
    raw = [
        AdSegment(start_ms=0, end_ms=30_000, type="intro_outro", confidence=0.95),
        AdSegment(start_ms=31_000, end_ms=67_000, type="preroll", confidence=1.0),
    ]
    out = _validated_segments(raw, tr)
    assert _shape(out) == [(0, 30_000, "intro_outro"), (31_000, 67_000, "preroll")]
    assert out[1].confidence == 1.0


def test_ad_adjacent_to_outro_stays_an_ad():
    # Furry-like postroll: the last ad runs straight into the closing credits.
    tr = {
        "duration": 7520.0,
        "segments": [
            _seg(7400.0, 7439.0, "Thanks for listening, see you next week."),
            _seg(7440.0, 7500.0, "This show is sponsored by NOCD."),
            _seg(7501.0, 7520.0, "Music by our friend."),
        ],
    }
    raw = [
        AdSegment(start_ms=7_400_000, end_ms=7_439_000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=7_440_000, end_ms=7_500_000, type="postroll", confidence=0.95),
        AdSegment(start_ms=7_501_000, end_ms=7_520_000, type="intro_outro", confidence=0.9),
    ]
    out = _validated_segments(raw, tr)
    assert _shape(out) == [
        (7_400_000, 7_439_000, "intro_outro"),
        (7_440_000, 7_500_000, "postroll"),
        (7_501_000, 7_520_000, "intro_outro"),
    ]


def test_intro_with_break_cue_does_not_pull_in_the_ad():
    # Cold open ending in a break cue, music, then the ad: the intro is not an ad.
    tr = {
        "duration": 1800.0,
        "segments": [
            _seg(0.0, 40.0, "Welcome to Up First. We'll be right back."),
            _seg(52.0, 110.0, "Support for this podcast comes from Acme."),
        ],
    }
    raw = [
        AdSegment(start_ms=0, end_ms=40_000, type="intro_outro", confidence=0.95),
        AdSegment(start_ms=52_000, end_ms=110_000, type="sponsor", confidence=0.95),
    ]
    assert _shape(_merge(raw, transcript=tr)) == [
        (0, 40_000, "intro_outro"),
        (52_000, 110_000, "sponsor"),
    ]


def test_ad_with_break_cue_next_to_intro_still_forms_one_break_block():
    # Intro, then "we'll be right back" + 12 s music + ad: the cue and ad merge, intro doesn't.
    tr = {
        "segments": [
            _seg(0.0, 20.0, "This is the show."),
            _seg(20.5, 23.0, "We'll be right back."),
            _seg(35.0, 90.0, "Sponsored by Acme."),
        ]
    }
    raw = [
        AdSegment(start_ms=0, end_ms=20_000, type="intro_outro", confidence=0.95),
        AdSegment(start_ms=20_500, end_ms=23_000, type="midroll", confidence=0.95),
        AdSegment(start_ms=35_000, end_ms=90_000, type="sponsor", confidence=0.95),
    ]
    assert _shape(_merge(raw, transcript=tr)) == [
        (0, 20_000, "intro_outro"),
        (20_500, 90_000, "midroll"),
    ]


def test_overlapping_ad_and_intro_labels_are_both_kept():
    # Overlapping windows can label the same audio twice with different classes.
    raw = [
        AdSegment(start_ms=0, end_ms=30_000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=25_000, end_ms=60_000, type="sponsor", confidence=0.95),
    ]
    assert _shape(_merge(raw)) == [(0, 30_000, "intro_outro"), (25_000, 60_000, "sponsor")]


def test_duplicate_ad_detection_merges_across_an_interleaved_intro():
    # A long ad with an intro label inside it: a later overlapping duplicate of the ad
    # still merges into the ad instead of becoming a second fragment.
    raw = [
        AdSegment(start_ms=100_000, end_ms=160_000, type="sponsor", confidence=0.95),
        AdSegment(start_ms=110_000, end_ms=115_000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=150_000, end_ms=170_000, type="sponsor", confidence=0.95),
    ]
    assert _shape(_merge(raw)) == [
        (100_000, 170_000, "sponsor"),
        (110_000, 115_000, "intro_outro"),
    ]


def test_gap_merge_never_swallows_an_intro_between_ads():
    raw = [
        AdSegment(start_ms=0, end_ms=10_000, type="sponsor", confidence=0.95),
        AdSegment(start_ms=12_000, end_ms=14_000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=16_000, end_ms=30_000, type="sponsor", confidence=0.95),
    ]
    assert _shape(_merge(raw)) == [
        (0, 10_000, "sponsor"),
        (12_000, 14_000, "intro_outro"),
        (16_000, 30_000, "sponsor"),
    ]


def test_adjacent_intro_outro_spans_still_merge_together():
    raw = [
        AdSegment(start_ms=0, end_ms=10_000, type="intro_outro", confidence=0.9),
        AdSegment(start_ms=12_000, end_ms=20_000, type="intro_outro", confidence=0.95),
    ]
    assert _shape(_merge(raw)) == [(0, 20_000, "intro_outro")]
