"""Ad-report review (LLM mocked), per-show note learning and prompt injection."""

import asyncio
import json

import pytest

from app.config import Settings
from app.db import learning, sqlite
from app.models.schemas import AdSegment
from app.routes import feedback as feedback_routes
from app.services import analyze_pipeline, detect_ads, feedback_review
from app.services.feedback_review import parse_review, review_feedback, review_window
from app.services.show_notes import merge_learning, notes_prompt_block, show_key

FEED = "https://Feeds.Example.com/show.xml/"
MD5 = "a" * 32
LLM = Settings(openrouter_api_key="test", mock_analyze=False, llm_provider="openrouter")


@pytest.fixture
def db(monkeypatch, tmp_path):
    path = tmp_path / "learn.db"
    for mod in (sqlite, learning, feedback_routes):
        monkeypatch.setattr(mod, "_db_path", lambda: path)
    asyncio.run(sqlite.init_db())
    return path


def _transcript():
    # Show talk, then an undetected ad break at 600-690s, then show talk again.
    segs = []
    for t in range(0, 1200, 30):
        text = "Back to our conversation about the topic."
        if t == 600:
            text = "We'll be right back. This episode is brought to you by Acme Mattress."
        elif 630 <= t < 690:
            text = "Acme Mattress, sleep better tonight. Use code SHOW for 20 percent off."
        segs.append({"start": float(t), "end": float(t + 30), "text": text})
    return {"duration": 1200.0, "segments": segs}


async def _insert_report(**fields):
    db = await feedback_routes._connect()
    try:
        cur = await db.execute(
            """INSERT INTO feedback (kind, episode_guid, title, feed_url, position_ms,
                 selected_segment_json, segments_json, note, created_at, review_status)
               VALUES (?, ?, ?, ?, ?, ?, '[]', ?, '2026-10-22T00:00:00+00:00', 'pending')""",
            (
                fields["kind"], fields.get("guid", "ep1"), "Episode", fields.get("feed_url", FEED),
                fields.get("position_ms"),
                json.dumps(fields["selected"]) if fields.get("selected") else None,
                fields.get("note"),
            ),
        )
        await db.commit()
        return cur.lastrowid
    finally:
        await db.close()


async def _setup_episode(segments, *, md5=MD5, cache_md5=MD5, audio_url=None):
    await sqlite.save_skip_map(
        "ep1", segments, "whisper+llm", audio_url=audio_url, feed_url=FEED,
        analyzed_audio_duration_ms=1_200_000, audio_sha256="sha", audio_md5=md5,
    )
    if cache_md5:
        await learning.save_transcript("ep1", _transcript(), audio_sha256="sha", audio_md5=cache_md5)


def _mock_llm(monkeypatch, reply):
    prompts = []

    async def fake(system, user, settings):
        prompts.append(user)
        return json.dumps(reply)

    monkeypatch.setattr(feedback_review, "_llm_json", fake)
    return prompts


# --- window ---------------------------------------------------------------------------

def test_review_window_is_generous_around_rough_positions():
    assert review_window("missed_ad", 700_000, None) == (460_000, 820_000)
    assert review_window("missed_ad", 30_000, None) == (0, 150_000)
    assert review_window("missed_ad", 1_190_000, None, duration_ms=1_200_000) == (950_000, 1_200_000)
    # A picked segment wins over the playhead (the listener may have scrolled to it).
    assert review_window("skipped_content", 5_000, {"start_ms": 100_000, "end_ms": 160_000}) == (40_000, 220_000)
    assert review_window("missed_ad", None, None) is None
    start, end = review_window("skipped_content", 0, {"start_ms": 0, "end_ms": 3_600_000})
    assert end - start <= feedback_review.MAX_WINDOW_MS


def test_parse_review_tolerates_garbage():
    assert parse_review("not json")["verdict"] == "inconclusive"
    v = parse_review('```json {"verdict":"confirmed","ad_start_s":10,"ad_end_s":5,"sponsors":["A",3]} ```')
    assert v["verdict"] == "confirmed" and v["ad_start_ms"] is None and v["sponsors"] == ["A"]


# --- reviewing reports ----------------------------------------------------------------

def test_confirmed_missed_ad_fixes_skip_map_and_learns(db, monkeypatch):
    prompts = _mock_llm(monkeypatch, {
        "verdict": "confirmed", "ad_start_s": 601, "ad_end_s": 689, "ad_type": "midroll",
        "sponsors": ["Acme Mattress"], "break_phrases": ["We'll be right back"], "reason": "ad read",
    })

    async def scenario():
        await _setup_episode([AdSegment(start_ms=0, end_ms=30_000, type="preroll", confidence=0.9)])
        # Listener reported ~1.5 minutes after the break started.
        fid = await _insert_report(kind="missed_ad", position_ms=700_000)
        result = await review_feedback(fid, settings=LLM)
        row = await sqlite.get_skip_map("ep1")
        notes = await learning.get_show_notes(show_key(FEED))
        fb = await feedback_review._load_feedback(fid)
        return result, row, notes, fb

    result, row, notes, fb = asyncio.run(scenario())
    assert result["status"] == "confirmed"
    assert result["review"]["skip_map_updated"] is True
    assert [(s.start_ms, s.end_ms) for s in row["segments"]] == [(0, 30_000), (600_000, 690_000)]
    assert row["audio_md5"] == MD5  # fingerprint untouched
    assert notes["sponsors"][0]["value"] == "Acme Mattress"
    assert notes["ad_positions"][0]["start_ms"] == 600_000
    assert fb["review_status"] == "confirmed" and fb["show_key"] == "feed:feeds.example.com/show.xml"
    # Window only: the ad and its surroundings, not the whole episode.
    assert "[600.0-630.0]" in prompts[0] and "[0.0-30.0]" not in prompts[0]


def test_ad_crossing_window_edge_still_snaps_and_merges(db, monkeypatch):
    # Report at 13:30: window starts at 9:30, the ad really began at 9:00 (already detected).
    _mock_llm(monkeypatch, {"verdict": "confirmed", "ad_start_s": 540, "ad_end_s": 689, "ad_type": "sponsor"})

    async def scenario():
        await _setup_episode([AdSegment(start_ms=540_000, end_ms=600_000, type="sponsor", confidence=0.9)])
        fid = await _insert_report(kind="missed_ad", position_ms=810_000)
        result = await review_feedback(fid, settings=LLM)
        return result, await sqlite.get_skip_map("ep1")

    result, row = asyncio.run(scenario())
    assert result["review"]["window_ms"][0] == 570_000
    assert (result["review"]["ad_start_ms"], result["review"]["ad_end_ms"]) == (570_000, 690_000)
    assert [(s.start_ms, s.end_ms) for s in row["segments"]] == [(540_000, 690_000)]


def test_network_promos_do_not_teach_sponsor_names(db, monkeypatch):
    _mock_llm(monkeypatch, {
        "verdict": "confirmed", "ad_start_s": 600, "ad_end_s": 690, "ad_type": "network",
        "sponsors": ["The New York Times"], "break_phrases": ["We'll be right back"],
    })

    async def scenario():
        await _setup_episode([])
        fid = await _insert_report(kind="missed_ad", position_ms=700_000)
        await review_feedback(fid, settings=LLM)
        return await learning.get_show_notes(show_key(FEED))

    notes = asyncio.run(scenario())
    assert notes["sponsors"] == []
    assert [p["value"] for p in notes["break_phrases"]] == ["We'll be right back"]


def test_brand_also_mentioned_in_show_content_is_not_learned():
    tx = {"segments": [
        {"start": 0.0, "end": 30.0, "text": "Our reporters at The New York Times found this."},
        {"start": 30.0, "end": 60.0, "text": "Subscribe to The New York Times today. Acme Mattress too."},
        {"start": 60.0, "end": 90.0, "text": "Back to the story."},
    ]}
    verdict = {"ad_start_ms": 30_000, "ad_end_ms": 60_000}
    kept = feedback_review.own_brand_filter(["The New York Times", "Acme Mattress"], verdict, tx, (0, 90_000))
    assert kept == ["Acme Mattress"]


def test_review_on_other_audio_copy_never_edits_map_and_downgrades_rejects(db, monkeypatch):
    _mock_llm(monkeypatch, {"verdict": "rejected", "reason": "no ad"})

    async def scenario():
        await _setup_episode([], md5=MD5, cache_md5="b" * 32)
        fid = await _insert_report(kind="missed_ad", position_ms=700_000)
        result = await review_feedback(fid, settings=LLM)
        return result, await sqlite.get_skip_map("ep1"), await learning.get_show_notes(show_key(FEED))

    result, row, notes = asyncio.run(scenario())
    assert result["status"] == "inconclusive"
    assert result["review"]["same_audio_as_skip_map"] is False
    assert row["segments"] == []
    assert notes is None


def test_missing_transcript_is_inconclusive_not_an_error(db, monkeypatch):
    _mock_llm(monkeypatch, {"verdict": "confirmed"})

    async def scenario():
        await _setup_episode([], cache_md5=None, audio_url=None)
        fid = await _insert_report(kind="missed_ad", position_ms=700_000)
        return await review_feedback(fid, settings=LLM)

    result = asyncio.run(scenario())
    assert result["status"] == "inconclusive"
    assert "Transcript unavailable" in result["review"]["reason"]


def test_confirmed_skipped_content_drops_skip_and_learns_not_ad(db, monkeypatch):
    _mock_llm(monkeypatch, {
        "verdict": "confirmed", "not_ad_description": "Listener mail segment", "sponsors": ["Ignored"],
    })
    wrong = AdSegment(start_ms=300_000, end_ms=360_000, type="sponsor", confidence=0.8)
    keep = AdSegment(start_ms=600_000, end_ms=690_000, type="midroll", confidence=0.9)

    async def scenario():
        await _setup_episode([wrong, keep])
        fid = await _insert_report(
            kind="skipped_content", position_ms=320_000, selected={"start_ms": 300_000, "end_ms": 360_000},
        )
        result = await review_feedback(fid, settings=LLM)
        return result, await sqlite.get_skip_map("ep1"), await learning.get_show_notes(show_key(FEED))

    result, row, notes = asyncio.run(scenario())
    assert result["status"] == "confirmed"
    assert [(s.start_ms, s.end_ms) for s in row["segments"]] == [(600_000, 690_000)]
    assert [n["value"] for n in notes["not_ads"]] == ["Listener mail segment"]
    assert notes["sponsors"] == []  # no ad there, so nothing to learn about sponsors


def test_no_llm_leaves_report_pending(db):
    async def scenario():
        fid = await _insert_report(kind="missed_ad", position_ms=1000)
        return await review_feedback(fid, settings=Settings(mock_analyze=True))

    assert asyncio.run(scenario())["status"] == "pending"


# --- notes ----------------------------------------------------------------------------

def test_notes_dedupe_count_and_stay_bounded():
    notes = None
    for i in range(60):
        notes = merge_learning(notes, sponsors=[f"Brand {i}", "Acme", "acme "], verdict="confirmed")
    assert len(notes["sponsors"]) == 30
    assert notes["sponsors"][0]["value"] == "Acme"
    assert notes["sponsors"][0]["count"] == 120
    assert notes["confirmed_reports"] == 60
    notes = merge_learning(notes, ad_position={"start_ms": 600_000, "end_ms": 690_000})
    notes = merge_learning(notes, ad_position={"start_ms": 620_000, "end_ms": 700_000})
    assert len(notes["ad_positions"]) == 1 and notes["ad_positions"][0]["start_ms"] == 620_000
    assert len(merge_learning(None, sponsors=["x" * 500])["sponsors"][0]["value"]) == 80


def test_show_key_normalizes_feed_urls():
    assert show_key("https://www.Example.com/feed/") == show_key("http://example.com/feed")
    assert show_key(None, "My Show") == "title:my show"
    assert show_key(None) is None


def test_prompt_block_only_when_notes_exist():
    assert notes_prompt_block(None) is None
    assert notes_prompt_block(merge_learning(None)) is None
    block = notes_prompt_block(merge_learning(
        None, sponsors=["Acme"], break_phrases=["stay with us"], not_ads=["Listener mail"],
        ad_position={"start_ms": 600_000, "end_ms": 690_000},
    ))
    assert "Acme" in block and '"stay with us"' in block and "Listener mail" in block and "10:00-11:30" in block
    assert detect_ads._system_prompt(None) == detect_ads.SYSTEM_PROMPT
    assert "Learned show notes" in detect_ads._system_prompt(block)
    content = detect_ads._user_content("[0.0-1.0] hi", None, block)
    assert content.startswith("Learned show notes") and content.endswith("[0.0-1.0] hi")
    assert detect_ads._user_content("[0.0-1.0] hi", None, None) == "[0.0-1.0] hi"


def test_analysis_caches_transcript_and_gives_other_shows_no_notes(db, monkeypatch, tmp_path):
    seen = {}

    async def fake_transcribe(path, settings):
        return _transcript()

    async def fake_label(transcript, settings, duration_ms=None, **kw):
        seen.update(kw)
        return []

    monkeypatch.setattr(analyze_pipeline, "transcribe_audio", fake_transcribe)
    monkeypatch.setattr(analyze_pipeline, "label_ads_llm", fake_label)

    async def scenario():
        await learning.save_show_notes(show_key(FEED), merge_learning(None, sponsors=["Acme"]))
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio bytes")
        await analyze_pipeline.run_analyze_from_file(
            episode_guid="ep2", audio_path=audio, feed_url=FEED, settings=LLM,
        )
        audio.write_bytes(b"other")
        await analyze_pipeline.run_analyze_from_file(
            episode_guid="ep3", audio_path=audio, feed_url="https://other.example/feed", settings=LLM,
        )
        return await learning.get_transcript("ep2")

    cached = asyncio.run(scenario())
    assert cached is not None and len(cached[0]["segments"]) == 40
    # The second (other show) analysis ran last and got no notes.
    assert seen["show_notes"] is None


def test_analysis_passes_notes_for_known_show(db, monkeypatch, tmp_path):
    seen = {}

    async def fake_transcribe(path, settings):
        return _transcript()

    async def fake_label(transcript, settings, duration_ms=None, **kw):
        seen.update(kw)
        return []

    monkeypatch.setattr(analyze_pipeline, "transcribe_audio", fake_transcribe)
    monkeypatch.setattr(analyze_pipeline, "label_ads_llm", fake_label)

    async def scenario():
        await learning.save_show_notes(show_key(FEED), merge_learning(None, sponsors=["Acme"]))
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"audio bytes")
        await analyze_pipeline.run_analyze_from_file(episode_guid="ep2", audio_path=audio, feed_url=FEED, settings=LLM)

    asyncio.run(scenario())
    assert "Acme" in seen["show_notes"]


def test_feedback_api_exposes_review_fields(db):
    from fastapi.testclient import TestClient

    from app.main import app

    feedback_routes.reset_feedback_limiter()
    with TestClient(app) as client:
        key = {"X-App-Key": "test-secret-key"}
        r = client.post("/v1/feedback", json={"kind": "missed_ad", "episode_guid": "api-g", "position_ms": 5}, headers=key)
        assert r.status_code == 201 and r.json()["review_status"] == "pending"
        fid = r.json()["id"]
        r = client.post(f"/v1/feedback/{fid}/review", headers=key)
        assert r.status_code == 200 and r.json()["status"] == "pending"  # mock mode: no LLM
        assert client.post("/v1/feedback/999999/review", headers=key).status_code == 404
        assert client.get("/v1/show-notes", headers=key).json() == []
        assert client.get("/v1/show-notes").status_code == 401
