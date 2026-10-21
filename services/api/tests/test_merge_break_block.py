from app.models.schemas import AdSegment
from app.services.detect_ads import _has_spoken_text_between, _merge, _validated_segments


def _seg(start, end, text):
    return {"start": start, "end": end, "text": text}


# Real SYSK "Short Stuff: The Style Cycle" Whisper spans around the midroll.
SYSK = {
    "duration": 969.3,
    "segments": [
        _seg(378.7049, 381.6049, " That really applies to fashion design."),
        _seg(382.4049, 382.9049, " Yeah, for sure."),
        _seg(383.1649, 383.8049, " Should we take a break?"),
        _seg(384.2049, 386.2049, " Yes, because I'm getting worked up."),
        _seg(386.8049, 387.7049, " All right, we'll be right back."),
        _seg(401.5849, 402.4849, " Hey, everybody."),
        _seg(402.8649, 463.7449, " YouTube Premium ... Terms and conditions apply."),
        _seg(487.7249, 490.34982, " home insurance ... Visit amica.com."),
        _seg(491.4049, 494.0499, " Amica. Empathy is our best policy."),
        _seg(509.6499, 512.7449, " Okay, we're back, everybody."),
        _seg(513.0049, 518.4049, " And this 20-year rule does have sort of data points."),
    ],
}


def test_fractional_whisper_edges_are_not_speech_inside_gap():
    assert not _has_spoken_text_between(SYSK, 387705, 401585)


def test_sysk_break_block_merges_into_one_segment():
    raw = [
        AdSegment(start_ms=383200, end_ms=387700, type="midroll", confidence=0.95),
        AdSegment(start_ms=401600, end_ms=463700, type="sponsor", confidence=1.0),
        AdSegment(start_ms=487700, end_ms=494000, type="sponsor", confidence=1.0),
    ]
    out = _validated_segments(raw, SYSK)
    assert len(out) == 1
    assert abs(out[0].start_ms - 383200) < 500
    assert abs(out[0].end_ms - 494000) < 500
    assert out[0].type == "midroll"


def test_without_cue_long_gap_stays_split():
    tr = {"segments": [_seg(10.0, 20.0, "Brought to you by Acme."), _seg(45.0, 60.0, "Use code X.")]}
    segs = [
        AdSegment(start_ms=10000, end_ms=20000, type="sponsor", confidence=0.9),
        AdSegment(start_ms=45000, end_ms=60000, type="sponsor", confidence=0.9),
    ]
    assert len(_merge(segs, transcript=tr)) == 2


def test_break_block_does_not_bridge_speech():
    tr = {"segments": [
        _seg(10.0, 12.0, "We'll be right back."),
        _seg(20.0, 30.0, "Actually one more editorial thought here."),
        _seg(35.0, 60.0, "Sponsored by Acme."),
    ]}
    segs = [
        AdSegment(start_ms=10000, end_ms=12000, type="midroll", confidence=0.9),
        AdSegment(start_ms=35000, end_ms=60000, type="sponsor", confidence=0.9),
    ]
    assert len(_merge(segs, transcript=tr)) == 2


def test_break_cue_bridges_short_spoken_gap_into_the_ad():
    # Real case: "We'll be right back." at 35:18, Alka-Seltzer ad from 35:32. The 13s in
    # between had a few transcribed words (bumper / sign-off), which used to split them.
    tr = {"segments": [
        _seg(2118.0, 2119.0, "We'll be right back."),
        _seg(2122.0, 2124.0, "Thank you."),
        _seg(2132.0, 2191.0, "You've heard of Alka-Seltzer, right?"),
    ]}
    segs = [
        AdSegment(start_ms=2_118_000, end_ms=2_119_000, type="midroll", confidence=0.95),
        AdSegment(start_ms=2_132_000, end_ms=2_191_000, type="sponsor", confidence=0.95),
    ]
    out = _merge(segs, transcript=tr)
    assert [(s.start_ms, s.end_ms, s.type) for s in out] == [(2_118_000, 2_191_000, "midroll")]


def test_spoken_gap_after_cue_is_bridged_only_up_to_15s():
    tr = {"segments": [
        _seg(10.0, 12.0, "We'll be right back."),
        _seg(14.0, 27.0, "Stay with us, more after this."),
        _seg(28.0, 60.0, "Sponsored by Acme."),
    ]}
    segs = [
        AdSegment(start_ms=10000, end_ms=12000, type="midroll", confidence=0.9),
        AdSegment(start_ms=28000, end_ms=60000, type="sponsor", confidence=0.9),
    ]
    # 16s of speech: could be the host carrying on, so it stays out of the skip.
    assert len(_merge(segs, transcript=tr)) == 2


def test_break_block_gap_limit_is_30s():
    tr = {"segments": [_seg(10.0, 12.0, "Stay with us."), _seg(43.0, 60.0, "Sponsored by Acme.")]}
    segs = [
        AdSegment(start_ms=10000, end_ms=12000, type="midroll", confidence=0.9),
        AdSegment(start_ms=43000, end_ms=60000, type="sponsor", confidence=0.9),
    ]
    assert len(_merge(segs, transcript=tr)) == 2


def test_duplicate_detection_from_overlapping_window_keeps_strong_confidence():
    # Window 2 repeats the tail of window 1, so the same ad is labeled twice. The weaker,
    # partial duplicate must not pull the merged ad below the app's 0.8 auto-skip bar.
    merged = _merge(
        [
            AdSegment(start_ms=100_000, end_ms=120_000, type="sponsor", confidence=0.7),
            AdSegment(start_ms=100_000, end_ms=160_000, type="sponsor", confidence=0.95),
        ]
    )
    assert [(s.start_ms, s.end_ms, s.confidence) for s in merged] == [(100_000, 160_000, 0.95)]

    contained = _merge(
        [
            AdSegment(start_ms=100_000, end_ms=160_000, type="sponsor", confidence=0.95),
            AdSegment(start_ms=110_000, end_ms=130_000, type="sponsor", confidence=0.7),
        ]
    )
    assert [s.confidence for s in contained] == [0.95]


def test_overlap_that_extends_into_uncertain_audio_stays_conservative():
    merged = _merge(
        [
            AdSegment(start_ms=100_000, end_ms=120_000, type="sponsor", confidence=0.95),
            AdSegment(start_ms=110_000, end_ms=160_000, type="sponsor", confidence=0.7),
        ]
    )
    # 120-160s is backed only by the 0.7 detection.
    assert [s.confidence for s in merged] == [0.7]
