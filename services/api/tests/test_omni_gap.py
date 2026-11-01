"""Omni quiet-gap second pass. Omni itself is always mocked here (no paid calls)."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import omni_gap as gap_db
from app.db import sqlite
from app.models.schemas import AdSegment
from app.services import omni_gap
from app.services.omni_gap import (
    GapPassJob,
    find_gaps,
    judge,
    merge_additions,
    parse_answer,
)

HAS_FFMPEG = shutil.which("ffmpeg") is not None
APP_KEY = {"X-App-Key": "test-secret-key"}


def seg(a, b, t="sponsor", c=0.95, **kw):
    return AdSegment(start_ms=int(a * 1000), end_ms=int(b * 1000), type=t, confidence=c, **kw)


def speech(a, b, words=None):
    words = words if words is not None else max(3, int((b - a) * 2.5))  # normal talking pace
    return {"start": a, "end": b, "text": " ".join(["word"] * words)}


def transcript(*segments, duration=600.0):
    return {"segments": list(segments), "duration": duration}


@pytest.fixture
def db_path(monkeypatch, tmp_path):
    path = tmp_path / "gap.db"
    monkeypatch.setattr(sqlite, "_db_path", lambda: path)
    asyncio.run(sqlite.init_db())
    return path


# --- gap detection ----------------------------------------------------------------------
def test_find_gaps_quiet_run_between_speech():
    tr = transcript(speech(0, 100), speech(130, 300))
    assert find_gaps(tr, [], 300) == [(100.0, 130.0)]


def test_find_gaps_ignores_short_pauses_and_dense_speech():
    tr = transcript(speech(0, 100), speech(110, 200), speech(215, 300))  # 10 s and 15 s pauses
    assert find_gaps(tr, [], 300) == []


def test_find_gaps_filler_only_text_counts_as_quiet():
    tr = transcript(
        speech(0, 100),
        {"start": 100, "end": 130, "text": "Thank you."},
        {"start": 130, "end": 135, "text": "[Music]"},
        speech(135, 300),
    )
    assert find_gaps(tr, [], 300) == [(100.0, 135.0)]


def test_find_gaps_bridges_one_short_line_inside_music():
    tr = transcript(speech(0, 100), {"start": 112, "end": 114, "text": "This is NPR."}, speech(126, 300))
    # 12 + 12 s quiet joined across a 2 s line (well under 1.5 words / 10 s overall)
    assert find_gaps(tr, [], 300) == [(100.0, 126.0)]


def test_find_gaps_excludes_spans_already_skipped():
    tr = transcript(speech(0, 100), speech(160, 300))
    # main pass already skips 100-130 -> 30 s left
    assert find_gaps(tr, [seg(95, 130)], 300) == [(130.0, 160.0)]
    # main pass skips 100-145 -> only 15 s left: not worth a call
    assert find_gaps(tr, [seg(95, 145)], 300) == []
    # a low-confidence segment the app would not auto-skip does not count as covered
    assert find_gaps(tr, [seg(95, 145, c=0.5)], 300) == [(100.0, 160.0)]


def test_find_gaps_trailing_quiet_to_end_of_audio():
    tr = transcript(speech(0, 250))
    assert find_gaps(tr, [], 300) == [(250.0, 300.0)]


# --- music skip (real ffmpeg) -------------------------------------------------------------
def _make_audio(path: Path, expr_filter: str, seconds: int = 30) -> None:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", expr_filter, "-t", str(seconds),
         "-ac", "1", "-ar", "16000", "-b:a", "32k", str(path)],
        check=True,
    )


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_music_check_steady_bed_is_skipped_and_choppy_audio_is_not(tmp_path):
    steady = tmp_path / "steady.mp3"
    _make_audio(steady, "sine=frequency=440:sample_rate=16000")
    choppy = tmp_path / "choppy.mp3"
    # bursts of sound with pauses, like speech: level jumps between frames
    _make_audio(choppy, "aevalsrc='sin(2*PI*300*t)*gt(sin(2*PI*3*t)+0.3*sin(2*PI*7.3*t),0.2)':s=16000")
    music, change = omni_gap.is_music_only(steady, 0, 30)
    assert music and change is not None and change < omni_gap.MUSIC_MAX_LEVEL_CHANGE_DB
    music, change = omni_gap.is_music_only(choppy, 0, 30)
    assert not music and change is not None and change > omni_gap.MUSIC_MAX_LEVEL_CHANGE_DB


def test_music_check_unmeasurable_is_not_skipped(tmp_path):
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"not audio")
    assert omni_gap.is_music_only(bad, 0, 30)[0] is False


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_cut_clip_has_requested_length(tmp_path):
    src = tmp_path / "src.mp3"
    _make_audio(src, "sine=frequency=440:sample_rate=16000", seconds=60)
    out = tmp_path / "clip.mp3"
    omni_gap.cut_clip(src, 10, 40, out)
    assert abs(omni_gap._ffprobe_duration_s(out) - 30) < 0.5


# --- answer parsing ----------------------------------------------------------------------
def test_parse_answer_handles_broken_json():
    assert parse_answer('{"segments": [{"start_s": 1, "end_s": 9, "type": "sponsor"}]}') == [
        {"start_s": 1, "end_s": 9, "type": "sponsor"}
    ]
    assert parse_answer('```json\n{"segments": []}\n```') == []
    assert parse_answer("Sure! Here you go: {\"segments\": []} hope it helps") == []
    assert parse_answer("{not json") is None
    assert parse_answer("") is None
    assert parse_answer(None) is None
    assert parse_answer('{"segments": "nope"}') is None


# --- acceptance rules ----------------------------------------------------------------------
GAP = (100.0, 130.0)
CLIP = (80.0, 150.0)
MAIN = [seg(40, 95)]  # main-pass ad ends 5 s before the gap


def ans(start, end, t="sponsor", c=0.95):
    # answer times are relative to the clip start
    return {"start_s": start - CLIP[0], "end_s": end - CLIP[0], "type": t, "confidence": c}


def test_judge_accepts_ad_overlapping_gap_next_to_main_ad():
    v = judge(ans(100, 128), gap=GAP, clip=CLIP, main_segments=MAIN)
    assert v.accepted and (v.start_s, v.end_s, v.type) == (100.0, 128.0, "sponsor")


@pytest.mark.parametrize("t", ["intro_outro", "network", "content", "unknown"])
def test_judge_rejects_non_ad_types(t):
    v = judge(ans(100, 128, t=t), gap=GAP, clip=CLIP, main_segments=MAIN)
    assert not v.accepted and "not an ad type" in v.reason


def test_judge_rejects_low_confidence():
    v = judge(ans(100, 128, c=0.84), gap=GAP, clip=CLIP, main_segments=MAIN)
    assert not v.accepted and "confidence" in v.reason


def test_judge_requires_main_pass_ad_nearby():
    far = [seg(10, 80)]  # 20 s before the gap
    v = judge(ans(100, 128), gap=GAP, clip=CLIP, main_segments=far)
    assert not v.accepted and "main-pass ad" in v.reason
    # an intro/outro or a low-confidence ad next door does not count
    v = judge(ans(100, 128), gap=GAP, clip=CLIP, main_segments=[seg(40, 95, t="intro_outro")])
    assert not v.accepted
    v = judge(ans(100, 128), gap=GAP, clip=CLIP, main_segments=[seg(40, 95, c=0.5)])
    assert not v.accepted
    # ad right after the gap counts too
    v = judge(ans(100, 128), gap=GAP, clip=CLIP, main_segments=[seg(140, 200)])
    assert v.accepted


def test_judge_requires_overlap_with_the_gap():
    v = judge(ans(82, 103), gap=GAP, clip=CLIP, main_segments=MAIN)  # only 3 s inside
    assert not v.accepted and "overlaps gap" in v.reason
    v = judge(ans(82, 106), gap=GAP, clip=CLIP, main_segments=MAIN)  # 6 s inside
    assert v.accepted


def test_judge_clamps_to_the_quiet_gap_not_the_padding():
    # The padding around the gap is transcribed speech the main pass already judged:
    # an Omni boundary that runs into it must not skip that content.
    v = judge(
        {"start_s": -10, "end_s": 999, "type": "midroll", "confidence": 0.9},
        gap=GAP, clip=CLIP, main_segments=MAIN,
    )
    assert v.accepted and (v.start_s, v.end_s) == GAP


def test_judge_malformed_answer():
    v = judge({"type": "sponsor", "confidence": 0.9}, gap=GAP, clip=CLIP, main_segments=MAIN)
    assert not v.accepted and v.reason == "malformed answer"


# --- merging ----------------------------------------------------------------------------
TR = transcript(speech(0, 600))


def test_merge_extends_adjacent_ad_and_marks_source():
    out = merge_additions([seg(40, 95)], [seg(96, 128, source="omni_gap")], TR)
    assert [(s.start_ms, s.end_ms, s.type) for s in out] == [(40_000, 128_000, "sponsor")]
    assert out[0].source == "main+omni_gap"


def test_merge_separate_addition_is_omni_gap():
    out = merge_additions([seg(40, 95)], [seg(300, 340, source="omni_gap")], TR)
    assert [(s.start_ms, s.end_ms) for s in out] == [(40_000, 95_000), (300_000, 340_000)]
    assert out[0].source is None and out[1].source == "omni_gap"


def test_merge_never_covers_intro_outro_and_never_removes():
    existing = [seg(0, 30, t="intro_outro", c=0.9), seg(60, 90)]
    out = merge_additions(existing, [seg(20, 58, source="omni_gap")], TR)
    intro = [s for s in out if s.type == "intro_outro"]
    assert [(s.start_ms, s.end_ms) for s in intro] == [(0, 30_000)]
    ads = [s for s in out if s.type != "intro_outro"]
    assert all(s.start_ms >= 30_000 for s in ads)
    # every original segment is still fully covered by a segment of the same kind
    for e in existing:
        assert any(m.start_ms <= e.start_ms and m.end_ms >= e.end_ms and m.type == e.type for m in out) or (
            e.type == "sponsor" and any(m.start_ms <= e.start_ms and m.end_ms >= e.end_ms for m in ads)
        )


def test_merge_does_not_relabel_into_other_app_toggle():
    # crosspromo is 'self promotion' in the app; a sponsor addition must not swallow it
    existing = [seg(60, 90, t="crosspromo")]
    out = merge_additions(existing, [seg(91, 130, t="sponsor", source="omni_gap")], TR)
    assert any(s.start_ms <= 60_000 and s.end_ms >= 90_000 and s.type == "crosspromo" for s in out)
    assert any(s.type == "sponsor" and s.source == "omni_gap" for s in out)


def test_merge_with_nothing_usable_is_unchanged():
    existing = [seg(0, 30, t="intro_outro", c=0.9)]
    assert merge_additions(existing, [seg(5, 25, source="omni_gap")], TR) == existing


# --- the pass end to end (Omni mocked) ------------------------------------------------------
def _job(tmp_path, *, segments=None, run_id="R1", md5="a"*32, tr=None):
    audio = tmp_path / "ep.mp3"
    audio.write_bytes(b"fake audio")
    return GapPassJob(
        episode_guid="ep1",
        audio_path=audio,
        transcript=tr or transcript(speech(0, 100), speech(130, 600)),
        segments=segments if segments is not None else [seg(40, 95)],
        run_id=run_id,
        audio_md5=md5,
        podcast_title="Show",
        episode_title="Ep",
        duration_ms=600_000,
    )


async def _save_ready(job, pending=True):
    await sqlite.set_status(job.episode_guid, "pending", stage="queued", reset_started=True, run_id=job.run_id)
    return await sqlite.save_skip_map(
        job.episode_guid, job.segments, "m", audio_md5=job.audio_md5, run_id=job.run_id,
        gap_pass_status="pending" if pending else None,
    )


@pytest.fixture
def fake_audio(monkeypatch):
    monkeypatch.setattr(omni_gap, "_ffprobe_duration_s", lambda p: 600.0)
    monkeypatch.setattr(omni_gap, "is_music_only", lambda p, a, b: (False, 3.0))
    monkeypatch.setattr(omni_gap, "cut_clip", lambda src, a, b, out: Path(out).write_bytes(b"clip"))


def _mock_omni(monkeypatch, content=None, *, error=None, calls=None, delay=0.0):
    async def fake(clip_path, text, settings):
        if calls is not None:
            calls.append(text)
        if delay:
            await asyncio.sleep(delay)
        if error:
            return dict(content="", latency_s=1.0, cost=0.0, error=error)
        return dict(content=content, latency_s=1.0, cost=0.0012, error=None)

    monkeypatch.setattr(omni_gap, "call_omni", fake)


def test_pass_adds_accepted_ad_and_logs(db_path, tmp_path, monkeypatch, fake_audio):
    job = _job(tmp_path)
    calls: list[str] = []
    # clip is 80-150 s; answer 20-48 s -> 100-128 s absolute
    _mock_omni(monkeypatch, json.dumps({"segments": [
        {"start_s": 20, "end_s": 48, "type": "sponsor", "confidence": 0.97, "what": "Acme mattress"},
        {"start_s": 0, "end_s": 15, "type": "intro_outro", "confidence": 0.99},
    ]}), calls=calls)

    async def scenario():
        saved = await _save_ready(job)
        assert saved["gap_pass_pending"] is True
        result = await omni_gap.run_gap_pass(job)
        return result, await sqlite.get_skip_map("ep1"), await gap_db.list_log_entries(episode_guid="ep1")

    result, row, log = asyncio.run(scenario())
    assert result["added"] == 1 and result["applied"] is True
    assert row["gap_pass_status"] == "done" and row["gap_pass_pending"] is False
    assert [(s.start_ms, s.end_ms, s.source) for s in row["segments"]] == [(40_000, 128_000, "main+omni_gap")]
    assert row["audio_md5"] == "a"*32
    decisions = sorted(e["decision"] for e in log)
    assert decisions == ["accepted", "rejected"]
    rej = next(e for e in log if e["decision"] == "rejected")
    assert "not an ad type" in rej["reason"]
    acc = next(e for e in log if e["decision"] == "accepted")
    assert (acc["start_ms"], acc["end_ms"], acc["type"], acc["confidence"]) == (100_000, 128_000, "sponsor", 0.97)
    assert "70.0s" in calls[0]  # clip length is passed to Omni
    assert not job.audio_path.exists()  # the pass owns and deletes the audio


def test_pass_skips_music_only_gap_without_calling_omni(db_path, tmp_path, monkeypatch, fake_audio):
    monkeypatch.setattr(omni_gap, "is_music_only", lambda p, a, b: (True, 0.7))
    calls: list[str] = []
    _mock_omni(monkeypatch, '{"segments": []}', calls=calls)
    job = _job(tmp_path)

    async def scenario():
        await _save_ready(job)
        await omni_gap.run_gap_pass(job)
        return await sqlite.get_skip_map("ep1"), await gap_db.list_log_entries(episode_guid="ep1")

    row, log = asyncio.run(scenario())
    assert calls == []
    assert [e["decision"] for e in log] == ["skipped_music"]
    assert row["gap_pass_status"] == "done"
    assert [(s.start_ms, s.end_ms) for s in row["segments"]] == [(40_000, 95_000)]


@pytest.mark.parametrize(
    "content,error,decision",
    [("{broken", None, "bad_json"), ("", "no answer within the 600s hung-call limit", "call_failed"),
     ('{"segments": []}', None, "no_ads")],
)
def test_pass_failures_change_nothing_and_clear_flag(db_path, tmp_path, monkeypatch, fake_audio, content, error, decision):
    _mock_omni(monkeypatch, content, error=error)
    job = _job(tmp_path)

    async def scenario():
        await _save_ready(job)
        await omni_gap.run_gap_pass(job)
        return await sqlite.get_skip_map("ep1"), await gap_db.list_log_entries(episode_guid="ep1")

    row, log = asyncio.run(scenario())
    assert [e["decision"] for e in log] == [decision]
    assert row["gap_pass_status"] == "done" and row["gap_pass_pending"] is False
    assert [(s.start_ms, s.end_ms, s.source) for s in row["segments"]] == [(40_000, 95_000, None)]


def test_pass_crash_marks_error_and_logs(db_path, tmp_path, monkeypatch, fake_audio):
    def boom(*a, **k):
        raise RuntimeError("ffmpeg exploded")

    monkeypatch.setattr(omni_gap, "find_gaps", boom)
    job = _job(tmp_path)

    async def scenario():
        await _save_ready(job)
        res = await omni_gap.run_gap_pass(job)
        return res, await sqlite.get_skip_map("ep1"), await gap_db.list_log_entries(episode_guid="ep1")

    res, row, log = asyncio.run(scenario())
    assert res["applied"] is False
    assert row["gap_pass_status"] == "error" and row["gap_pass_pending"] is False
    assert [e["decision"] for e in log] == ["pass_failed"]
    assert len(row["segments"]) == 1


def test_pass_result_discarded_when_map_was_reanalyzed(db_path, tmp_path, monkeypatch, fake_audio):
    job = _job(tmp_path)
    _mock_omni(monkeypatch, json.dumps({"segments": [
        {"start_s": 20, "end_s": 48, "type": "sponsor", "confidence": 0.97}]}))

    async def scenario():
        await _save_ready(job)
        # a new analysis of other audio replaced the map before Omni answered
        await sqlite.set_status("ep1", "pending", stage="queued", reset_started=True, run_id="R2")
        await sqlite.save_skip_map("ep1", [seg(300, 330)], "m", audio_md5="other", run_id="R2")
        await omni_gap.run_gap_pass(job)
        return await sqlite.get_skip_map("ep1"), await gap_db.list_log_entries(episode_guid="ep1")

    row, log = asyncio.run(scenario())
    assert row["audio_md5"] == "other"
    assert [(s.start_ms, s.end_ms) for s in row["segments"]] == [(300_000, 330_000)]
    assert [e["decision"] for e in log] == ["discarded"]


def test_finish_gap_pass_md5_guard(db_path, tmp_path):
    job = _job(tmp_path)

    async def scenario():
        await _save_ready(job)
        wrong = await gap_db.finish_gap_pass("ep1", run_id="R1", audio_md5="zzz", status="done",
                                             merge=lambda cur: [])
        right = await gap_db.finish_gap_pass("ep1", run_id="R1", audio_md5="A"*32, status="done")
        again = await gap_db.finish_gap_pass("ep1", run_id="R1", audio_md5="a"*32, status="done")
        return wrong, right, again, await sqlite.get_skip_map("ep1")

    wrong, right, again, row = asyncio.run(scenario())
    assert (wrong, right, again) == (False, True, False)
    assert len(row["segments"]) == 1


def test_interrupted_passes_are_cleared_at_startup(db_path, tmp_path):
    job = _job(tmp_path)

    async def scenario():
        await _save_ready(job)
        n = await sqlite.fail_interrupted_gap_passes()
        return n, await sqlite.get_skip_map("ep1")

    n, row = asyncio.run(scenario())
    assert n == 1 and row["gap_pass_status"] == "interrupted" and row["gap_pass_pending"] is False


def test_concurrency_is_limited(db_path, tmp_path, monkeypatch, fake_audio):
    tr = transcript(*[speech(i * 60, i * 60 + 30) for i in range(10)])  # 30 s quiet every minute
    job = _job(tmp_path, tr=tr, segments=[seg(i * 60 + 25, i * 60 + 31) for i in range(10)])
    settings = get_settings().model_copy(update={"omni_gap_concurrency": 2})
    live = {"now": 0, "max": 0}

    async def fake_post(self, url, headers=None, json=None):
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        await asyncio.sleep(0.02)
        live["now"] -= 1
        import httpx

        return httpx.Response(200, json={"choices": [{"message": {"content": '{"segments": []}'}}],
                                         "usage": {"cost": 0.001}})

    import httpx

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    async def scenario():
        await _save_ready(job)
        return await omni_gap.run_gap_pass(job, settings)

    res = asyncio.run(scenario())
    assert res["sent"] >= 3
    assert live["max"] <= 2
    assert abs(res["cost"] - 0.001 * res["sent"]) < 1e-9


def test_call_omni_retries_transient_error_once(monkeypatch, tmp_path):
    import httpx

    clip = tmp_path / "c.mp3"
    clip.write_bytes(b"x")
    replies = [httpx.Response(503, text="busy"),
               httpx.Response(200, json={"choices": [{"message": {"content": '{"segments": []}'}}]})]

    async def fake_post(self, url, headers=None, json=None):
        return replies.pop(0)

    async def no_sleep(_):
        return None

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(omni_gap.asyncio, "sleep", no_sleep)
    res = asyncio.run(omni_gap.call_omni(clip, "t", get_settings()))
    assert res["error"] is None and res["content"] == '{"segments": []}'


def test_call_omni_hung_call_gives_up_without_retry(monkeypatch, tmp_path):
    import httpx

    clip = tmp_path / "c.mp3"
    clip.write_bytes(b"x")
    calls = []

    async def fake_post(self, url, headers=None, json=None):
        calls.append(1)
        raise httpx.ReadTimeout("hung")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    res = asyncio.run(omni_gap.call_omni(clip, "t", get_settings()))
    assert len(calls) == 1 and "hung-call limit" in res["error"]


def test_default_call_limit_is_generous():
    s = get_settings()
    assert s.omni_gap_enabled is True
    assert s.omni_gap_model == "qwen/qwen3.8-omni-flash"
    assert s.omni_gap_call_timeout_s >= 600


# --- pipeline: background pass never blocks the main result ------------------------------------
def test_pipeline_returns_before_gap_pass_and_hands_off_audio(db_path, tmp_path, monkeypatch):
    from app.services import analyze_pipeline

    audio = tmp_path / "up.mp3"
    audio.write_bytes(b"uploaded")
    settings = get_settings().model_copy(update={"mock_analyze": False, "openrouter_api_key": "k"})
    tr = transcript(speech(0, 100), speech(130, 600))
    release = asyncio.Event()
    started = {}

    async def fake_transcribe(path, s):
        return tr

    async def fake_label(*a, **k):
        return [seg(40, 95)]

    async def slow_pass(job, s=None):
        started["job"] = job
        assert job.audio_path.exists()
        await release.wait()
        await gap_db.finish_gap_pass(job.episode_guid, run_id=job.run_id, audio_md5=job.audio_md5,
                                     status="done", merge=lambda cur: merge_additions(cur, [seg(100, 128, source="omni_gap")], tr))
        job.audio_path.unlink()
        return {}

    monkeypatch.setattr(analyze_pipeline, "transcribe_audio", fake_transcribe)
    monkeypatch.setattr(analyze_pipeline, "label_ads_llm", fake_label)
    monkeypatch.setattr(omni_gap, "run_gap_pass", slow_pass)

    async def scenario():
        result = await analyze_pipeline.run_analyze_from_file(
            episode_guid="ep1", audio_path=audio, duration_ms=600_000, audio_md5="a"*32, audio_sha256="s",
            settings=settings,
        )
        mid = await sqlite.get_skip_map("ep1")
        assert audio.exists()  # still owned by the background pass
        release.set()
        await omni_gap.wait_for_gap_passes()
        return result, mid, await sqlite.get_skip_map("ep1")

    result, mid, final = asyncio.run(scenario())
    assert result["status"] == "ready" and result["gap_pass_pending"] is True
    assert [(s.start_ms, s.end_ms) for s in result["segments"]] == [(40_000, 95_000)]
    assert mid["gap_pass_pending"] is True
    assert final["gap_pass_pending"] is False and final["gap_pass_status"] == "done"
    assert [(s.start_ms, s.end_ms) for s in final["segments"]] == [(40_000, 128_000)]
    assert not audio.exists()


def test_pipeline_without_real_stt_does_not_schedule(db_path, tmp_path, monkeypatch):
    from app.services import analyze_pipeline

    audio = tmp_path / "up.mp3"
    audio.write_bytes(b"uploaded")
    called = []
    monkeypatch.setattr(omni_gap, "schedule_gap_pass", lambda *a, **k: called.append(1))
    result = asyncio.run(analyze_pipeline.run_analyze_from_file(
        episode_guid="ep1", audio_path=audio, duration_ms=60_000))
    assert result["status"] == "ready" and not result.get("gap_pass_pending")
    assert called == [] and not audio.exists()


def test_pipeline_schedule_failure_clears_flag(db_path, tmp_path, monkeypatch):
    from app.services import analyze_pipeline

    audio = tmp_path / "up.mp3"
    audio.write_bytes(b"uploaded")
    settings = get_settings().model_copy(update={"mock_analyze": False, "openrouter_api_key": "k"})

    async def fake_transcribe(path, s):
        return transcript(speech(0, 100), speech(130, 600))

    async def fake_label(*a, **k):
        return [seg(40, 95)]

    def broken(*a, **k):
        raise RuntimeError("no loop")

    monkeypatch.setattr(analyze_pipeline, "transcribe_audio", fake_transcribe)
    monkeypatch.setattr(analyze_pipeline, "label_ads_llm", fake_label)
    monkeypatch.setattr(analyze_pipeline, "schedule_gap_pass", broken)
    result = asyncio.run(analyze_pipeline.run_analyze_from_file(
        episode_guid="ep1", audio_path=audio, duration_ms=600_000, audio_md5="a"*32, settings=settings))
    row = asyncio.run(sqlite.get_skip_map("ep1"))
    assert result["status"] == "ready" and result["gap_pass_pending"] is False
    assert row["gap_pass_status"] == "error" and not audio.exists()


# --- API -----------------------------------------------------------------------------------
def test_skip_map_endpoint_reports_pending_flag_and_log_endpoint(db_path, tmp_path):
    from app.main import app

    job = _job(tmp_path)

    async def setup():
        await _save_ready(job)
        await gap_db.add_log_entries([dict(episode_guid="ep1", audio_md5="a"*32, run_id="R1",
                                           model="qwen/qwen3.8-omni-flash", gap_start_ms=100_000,
                                           gap_end_ms=130_000, start_ms=100_000, end_ms=128_000,
                                           type="sponsor", confidence=0.97, decision="accepted",
                                           reason="accepted")])

    with TestClient(app) as client:  # startup marks old pending passes interrupted, so seed after it
        asyncio.run(setup())
        r = client.get("/v1/skip-map/ep1", params={"audio_md5": "a"*32}, headers=APP_KEY)
        assert r.status_code == 200 and r.json()["gap_pass_pending"] is True
        assert client.get("/v1/omni-gap-log").status_code == 401
        r = client.get("/v1/omni-gap-log", params={"episode_guid": "ep1"}, headers=APP_KEY)
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1 and body["entries"][0]["decision"] == "accepted"
        r = client.get("/v1/omni-gap-log", params={"decision": "rejected"}, headers=APP_KEY)
        assert r.json()["count"] == 0
