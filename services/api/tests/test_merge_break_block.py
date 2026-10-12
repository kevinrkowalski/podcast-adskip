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


def test_break_block_gap_limit_is_30s():
    tr = {"segments": [_seg(10.0, 12.0, "Stay with us."), _seg(43.0, 60.0, "Sponsored by Acme.")]}
    segs = [
        AdSegment(start_ms=10000, end_ms=12000, type="midroll", confidence=0.9),
        AdSegment(start_ms=43000, end_ms=60000, type="sponsor", confidence=0.9),
    ]
    assert len(_merge(segs, transcript=tr)) == 2
