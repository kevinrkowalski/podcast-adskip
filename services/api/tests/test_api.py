"""Unit/smoke tests — never call paid APIs (MOCK_ANALYZE)."""

import os

from fastapi import FastAPI
from fastapi.testclient import TestClient as FastAPITestClient

from app.config import get_settings
from app.main import app
from app.services.detect_ads import heuristic_segments
from app.services.transcribe import stub_transcript


class ApiTestClient(FastAPITestClient):
    def __init__(self, app: FastAPI) -> None:
        super().__init__(app, headers={"X-App-Key": "test-secret-key"})


TestClient = ApiTestClient

get_settings.cache_clear()


def test_health():
    with TestClient(app) as client:
        r = client.get("/v1/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["mock_mode"] is True
        assert body["openrouter_configured"] is False


def test_skip_map_missing():
    with TestClient(app) as client:
        r = client.get("/v1/skip-map/does-not-exist-guid")
        assert r.status_code == 200
        assert r.json()["status"] == "missing"


def test_analyze_sync_stub():
    with TestClient(app) as client:
        r = client.post(
            "/v1/analyze-episode?sync=true",
            json={
                "episode_guid": "test-guid-001",
                "audio_url": "https://example.com/ep.mp3",
                "title": "Stub Episode",
                "duration_ms": 1_800_000,
                "force": True,
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ready"
        assert body["episode_guid"] == "test-guid-001"
        assert isinstance(body["segments"], list)
        assert len(body["segments"]) >= 1
        assert body["model"] and "stub" in body["model"]

        cached = client.get("/v1/skip-map/test-guid-001")
        assert cached.status_code == 200
        assert cached.json()["status"] == "missing"


def test_analyze_uploaded_audio_sync_and_skip_map_metadata():
    import asyncio
    import hashlib

    from app.db.sqlite import get_skip_map

    audio = b"test-audio-bytes"
    with TestClient(app) as client:
        response = client.post(
            "/v1/analyze-episode-upload?sync=true",
            files={"audio_file": ("episode.mp3", audio, "audio/mpeg")},
            data={
                "episode_guid": "uploaded-guid",
                "audio_url": "https://example.com/uploaded.mp3",
                "title": "Uploaded episode",
                "podcast_title": "A podcast",
                "podcast_description": "A short show description.",
                "episode_description": "A short episode description.",
                "duration_ms": "1800000",
                "force": "true",
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "ready"
        assert body["audio_url"] == "https://example.com/uploaded.mp3"
        assert body["analyzed_audio_size_bytes"] == len(audio)
        assert body["analyzed_audio_duration_ms"] == 1_800_000

        cached = client.get(
            f"/v1/skip-map/uploaded-guid?audio_md5={hashlib.md5(audio, usedforsecurity=False).hexdigest()}"
        )
        assert cached.status_code == 200
        cached_body = cached.json()
        assert cached_body["status"] == "ready"
        assert cached_body["audio_url"] == body["audio_url"]
        assert cached_body["analyzed_audio_size_bytes"] == len(audio)
        assert cached_body["analyzed_audio_duration_ms"] == 1_800_000
        assert cached_body["audio_md5"] == hashlib.md5(audio, usedforsecurity=False).hexdigest()
        mismatch = client.get(
            f"/v1/skip-map/uploaded-guid?audio_md5={hashlib.md5(b'other audio', usedforsecurity=False).hexdigest()}"
        )
        assert mismatch.json()["status"] == "missing"

        stored = asyncio.run(get_skip_map("uploaded-guid"))
        assert stored is not None
        assert stored["audio_sha256"] == hashlib.sha256(audio).hexdigest()

        # Identical bytes reuse the cached result without a new analysis.
        same_audio = client.post(
            "/v1/analyze-episode-upload?sync=true",
            files={"audio_file": ("episode.mp3", audio, "audio/mpeg")},
            data={"episode_guid": "uploaded-guid", "duration_ms": "1800000"},
        )
        assert same_audio.status_code == 200, same_audio.text
        assert same_audio.json()["analyzed_at"] == body["analyzed_at"]

        # Force bypasses the server cache even when the uploaded bytes are identical.
        forced_audio = client.post(
            "/v1/analyze-episode-upload?sync=true",
            files={"audio_file": ("episode.mp3", audio, "audio/mpeg")},
            data={"episode_guid": "uploaded-guid", "duration_ms": "1800000", "force": "true"},
        )
        assert forced_audio.status_code == 200, forced_audio.text
        assert forced_audio.json()["analyzed_at"] != body["analyzed_at"]

        # A different injected-ad variant has different bytes and must refresh the map.
        changed_audio = b"same episode, different inserted ad"
        changed = client.post(
            "/v1/analyze-episode-upload?sync=true",
            files={"audio_file": ("episode.mp3", changed_audio, "audio/mpeg")},
            data={"episode_guid": "uploaded-guid", "duration_ms": "1800000"},
        )
        assert changed.status_code == 200, changed.text
        assert changed.json()["analyzed_at"] != body["analyzed_at"]
        stored = asyncio.run(get_skip_map("uploaded-guid"))
        assert stored is not None
        assert stored["audio_sha256"] == hashlib.sha256(changed_audio).hexdigest()
        assert stored["audio_md5"] == hashlib.md5(changed_audio, usedforsecurity=False).hexdigest()


def test_url_analysis_cache_revalidates_downloaded_audio(monkeypatch, tmp_path):
    import asyncio

    from app.config import Settings
    from app.db import sqlite
    from app.services import analyze_pipeline

    database_path = tmp_path / "url-cache.db"
    monkeypatch.setattr(sqlite, "_db_path", lambda: database_path)
    audio_bytes = [b"variant one"]
    transcription_calls = 0

    async def fake_download_audio(_url, _max_mb):
        path = tmp_path / f"download-{len(list(tmp_path.glob('download-*.mp3')))}.mp3"
        path.write_bytes(audio_bytes[0])
        return path

    async def fake_transcribe_audio(_path, _settings):
        nonlocal transcription_calls
        transcription_calls += 1
        return {"text": "episode transcript", "segments": [], "duration": 10}

    monkeypatch.setattr(analyze_pipeline, "download_audio", fake_download_audio)
    monkeypatch.setattr(analyze_pipeline, "transcribe_audio", fake_transcribe_audio)
    settings = Settings(openrouter_api_key="test-key", llm_provider="stub", mock_analyze=False)

    async def _run():
        await sqlite.init_db()
        first = await analyze_pipeline.run_analyze(
            episode_guid="url-hash-guid",
            audio_url="https://example.com/episode.mp3",
            settings=settings,
        )
        same = await analyze_pipeline.run_analyze(
            episode_guid="url-hash-guid",
            audio_url="https://example.com/episode.mp3",
            settings=settings,
        )
        audio_bytes[0] = b"variant two with inserted ad"
        changed = await analyze_pipeline.run_analyze(
            episode_guid="url-hash-guid",
            audio_url="https://example.com/episode.mp3",
            settings=settings,
        )
        return first, same, changed

    first, same, changed = asyncio.run(_run())
    assert first["status"] == same["status"] == changed["status"] == "ready"
    assert transcription_calls == 2
    assert same["audio_sha256"] == first["audio_sha256"]
    assert changed["audio_sha256"] != first["audio_sha256"]


def test_heuristic_labels_sponsor_text():
    tx = stub_transcript(1_800_000)
    segs = heuristic_segments(tx)
    assert any(s.start_ms == 0 for s in segs)
    assert any(s.type in ("preroll", "sponsor") for s in segs)


def test_segment_taxonomy_includes_intro_outro_and_unknown():
    from app.models.schemas import AdSegment
    from app.services.detect_ads import _parse_llm_json

    intro = AdSegment(start_ms=0, end_ms=12_000, type="intro_outro", confidence=0.95)
    assert intro.type == "intro_outro"
    parsed = _parse_llm_json(
        '{"segments":[{"start_s":1,"end_s":3,"type":"unrecognized-label","confidence":0.9}]}'
    )
    assert parsed[0].type == "unknown"


def test_merge_combines_nearby_segments_across_categories():
    from app.models.schemas import AdSegment
    from app.services.detect_ads import _merge

    segments = [
        AdSegment(start_ms=100_000, end_ms=115_000, type="crosspromo", confidence=0.9),
        AdSegment(start_ms=118_000, end_ms=125_000, type="network", confidence=1.0),
        AdSegment(start_ms=128_000, end_ms=140_000, type="sponsor", confidence=0.95),
        AdSegment(start_ms=150_000, end_ms=160_000, type="crosspromo", confidence=0.9),
    ]

    merged = _merge(segments)
    assert [(segment.start_ms, segment.end_ms) for segment in merged] == [
        (100_000, 140_000),
        (150_000, 160_000),
    ]
    assert merged[0].type == "network"
    assert merged[0].confidence == 0.9


def test_merge_uses_eight_second_gap_boundary():
    from app.models.schemas import AdSegment
    from app.services.detect_ads import _merge

    merged = _merge(
        [
            AdSegment(start_ms=0, end_ms=10_000, type="network", confidence=0.9),
            AdSegment(start_ms=18_000, end_ms=20_000, type="crosspromo", confidence=0.9),
            AdSegment(start_ms=28_001, end_ms=30_000, type="network", confidence=0.9),
        ]
    )

    assert [(segment.start_ms, segment.end_ms) for segment in merged] == [
        (0, 20_000),
        (28_001, 30_000),
    ]


def test_low_confidence_segments_are_dropped_before_merge():
    from app.models.schemas import AdSegment
    from app.services.detect_ads import _validated_segments

    transcript = {
        "duration": 100,
        "segments": [
            {"start": 10, "end": 12, "text": "Sponsored by Acme."},
            {"start": 14, "end": 17, "text": "An uncertain nearby promotion."},
        ],
    }
    actual = _validated_segments(
        [
            AdSegment(start_ms=10_000, end_ms=12_000, type="sponsor", confidence=0.9),
            AdSegment(start_ms=14_000, end_ms=17_000, type="crosspromo", confidence=0.2),
        ],
        transcript,
    )

    assert [(segment.start_ms, segment.end_ms) for segment in actual] == [(10_000, 12_000)]
    assert actual[0].confidence == 0.9


def test_mid_episode_intro_outro_is_reclassified_from_transcript_evidence():
    from app.models.schemas import AdSegment
    from app.services.detect_ads import _validated_segments

    transcript = {
        "duration": 600,
        "segments": [
            {"start": 0, "end": 10, "text": "Welcome to the show."},
            {"start": 120, "end": 125, "text": "After the break, we'll be right back."},
            {"start": 150, "end": 155, "text": "Let's continue the discussion."},
        ],
    }
    actual = _validated_segments(
        [
            AdSegment(start_ms=0, end_ms=10_000, type="intro_outro", confidence=0.95),
            AdSegment(start_ms=120_000, end_ms=125_000, type="intro_outro", confidence=0.95),
            AdSegment(start_ms=150_000, end_ms=155_000, type="intro_outro", confidence=0.95),
        ],
        transcript,
    )

    assert [segment.type for segment in actual] == ["intro_outro", "midroll", "unknown"]


def test_stored_skip_maps_tolerate_obsolete_or_malformed_segments():
    from app.db.sqlite import _decode_segments

    segments = _decode_segments(
        '[{"start_ms":1000,"end_ms":3000,"type":"advertisement","confidence":0.95},'
        '{"start_ms":4000,"end_ms":2000,"type":"sponsor","confidence":0.9}]'
    )
    assert len(segments) == 1
    assert segments[0].type == "unknown"
    assert _decode_segments("not-json") == []


def test_segment_sample_text_uses_overlapping_transcript_spans():
    from app.models.schemas import AdSegment
    from app.services.detect_ads import _with_sample_text

    transcript = {
        "segments": [
            {"start": 1, "end": 3, "text": "Brought to you by Acme."},
            {"start": 3, "end": 5, "text": "Visit Acme today!"},
            {"start": 6, "end": 8, "text": "Unrelated episode discussion."},
        ]
    }
    labeled = _with_sample_text(
        [AdSegment(start_ms=1_000, end_ms=5_000, type="sponsor", confidence=0.9)],
        transcript,
    )

    assert labeled[0].sample_text == "Brought to you by Acme. Visit Acme today!"


def test_classifier_context_is_cleaned_and_separated_from_timed_transcript():
    from app.services.detect_ads import _context_block, _user_content

    context = _context_block(
        podcast_title="The Science Show",
        podcast_description="<p>Science &amp; culture</p>",
        episode_title="A new discovery",
        episode_description=None,
    )
    assert context is not None
    assert "Science & culture" in context
    prompt = _user_content("[10.0-12.0] Welcome to the show.", context)
    assert "background context only" in prompt
    assert "Timed transcript (use this as the sole source" in prompt
    assert prompt.endswith("[10.0-12.0] Welcome to the show.")


def test_heuristic_ignores_incidental_ad_mentions_and_keeps_explicit_brief_ads():
    for text in (
        "We mentioned the sponsor last week.",
        "I use Squarespace for my website.",
        "The episode discusses an advertisement from last year.",
    ):
        incidental = {
            "duration": 20,
            "segments": [{"start": 2, "end": 4, "text": text}],
        }
        assert heuristic_segments(incidental) == []

    brief = {
        "duration": 20,
        "segments": [{"start": 2, "end": 4, "text": "Brought to you by Acme."}],
    }
    detected = heuristic_segments(brief)
    assert len(detected) == 1
    assert detected[0].start_ms == 2_000
    assert detected[0].end_ms == 4_000


def test_empty_or_invalid_llm_result_does_not_fall_back_to_keyword_guess():
    from app.models.schemas import AdSegment
    from app.services.detect_ads import _finish_labeling

    transcript = {
        "duration": 20,
        "segments": [{"start": 2, "end": 4, "text": "Brought to you by Acme."}],
    }
    invalid_llm_segment = AdSegment(
        start_ms=10_000,
        end_ms=14_000,
        type="sponsor",
        confidence=0.95,
    )

    assert _finish_labeling([], transcript, None) == []
    assert _finish_labeling([invalid_llm_segment], transcript, None) == []


def test_llm_boundaries_snap_to_transcript_spans_and_episode_duration():
    from app.services.detect_ads import _validated_segments
    from app.models.schemas import AdSegment

    transcript = {
        "duration": 8,
        "segments": [
            {"start": 0, "end": 4, "text": "intro"},
            {"start": 4.5, "end": 8, "text": "advertisement"},
        ],
    }
    proposed = [AdSegment(start_ms=3_400, end_ms=30_000, type="sponsor", confidence=0.9)]
    actual = _validated_segments(proposed, transcript)
    assert len(actual) == 1
    assert actual[0].start_ms == 4_500
    assert actual[0].end_ms == 8_000


def test_llm_boundaries_outside_transcript_are_rejected():
    from app.services.detect_ads import _validated_segments
    from app.models.schemas import AdSegment

    transcript = {"duration": 10, "segments": [{"start": 1, "end": 8, "text": "speech"}]}
    proposed = [AdSegment(start_ms=20_000, end_ms=25_000, type="sponsor", confidence=0.95)]
    assert _validated_segments(proposed, transcript) == []


def test_plan_chunk_count_and_merge():
    from app.services.transcribe import merge_transcripts, plan_chunk_count

    limit = 25 * 1024 * 1024
    assert plan_chunk_count(limit // 2, 25) == 1
    assert plan_chunk_count(limit, 25) == 1
    assert plan_chunk_count(int(limit * 1.5), 25) >= 2
    assert plan_chunk_count(limit * 3, 25) >= 3

    merged = merge_transcripts(
        [
            (
                {
                    "text": "hello",
                    "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "hello"}],
                    "duration": 1.0,
                },
                0.0,
            ),
            (
                {
                    "text": "world",
                    "segments": [{"id": 0, "start": 0.5, "end": 2.0, "text": "world"}],
                    "duration": 2.0,
                },
                100.0,
            ),
        ]
    )
    assert "hello" in merged["text"] and "world" in merged["text"]
    assert merged["segments"][0]["start"] == 0.0
    assert merged["segments"][1]["start"] == 100.5
    assert merged["segments"][1]["end"] == 102.0
    assert merged["duration"] == 102.0


def test_queued_async_analyze():
    with TestClient(app) as client:
        r = client.post(
            "/v1/analyze-episode",
            json={
                "episode_guid": "test-guid-async",
                "audio_url": "https://example.com/ep2.mp3",
                "force": True,
            },
        )
        assert r.status_code == 200
        assert r.json()["status"] == "queued"


def test_settings_openrouter_defaults():
    get_settings.cache_clear()
    s = get_settings()
    assert s.openrouter_base_url.rstrip("/") == "https://openrouter.ai/api/v1"
    assert "whisper" in s.whisper_model
    assert s.llm_provider in ("openrouter", "stub", "groq", "gemini")


def test_app_key_missing_or_wrong_returns_401():
    """With APP_KEY set, missing/wrong header → 401; correct → ok."""
    os.environ["APP_KEY"] = "test-secret-key"
    get_settings.cache_clear()
    try:
        with TestClient(app) as client:
            r = client.get("/v1/skip-map/any-guid", headers={"X-App-Key": ""})
            assert r.status_code == 401

            r = client.get("/v1/skip-map/any-guid", headers={"X-App-Key": "wrong"})
            assert r.status_code == 401

            r = client.get("/v1/skip-map/any-guid", headers={"X-App-Key": "test-secret-key"})
            assert r.status_code == 200
            assert r.json()["status"] == "missing"

            # health stays public
            assert client.get("/v1/health").status_code == 200

            r = client.post(
                "/v1/analyze-episode?sync=true",
                headers={"X-App-Key": ""},
                json={
                    "episode_guid": "auth-test-guid",
                    "audio_url": "https://example.com/ep.mp3",
                    "force": True,
                },
            )
            assert r.status_code == 401

            r = client.post(
                "/v1/analyze-episode?sync=true",
                headers={"X-App-Key": "test-secret-key"},
                json={
                    "episode_guid": "auth-test-guid",
                    "audio_url": "https://example.com/ep.mp3",
                    "force": True,
                },
            )
            assert r.status_code == 200
            assert r.json()["status"] == "ready"
    finally:
        os.environ["APP_KEY"] = "test-secret-key"
        get_settings.cache_clear()


def test_missing_app_key_fails_closed_with_503():
    """An unset APP_KEY rejects protected routes while public routes stay up."""
    os.environ["APP_KEY"] = ""
    get_settings.cache_clear()
    try:
        with TestClient(app) as client:
            r = client.get("/v1/skip-map/any-guid")
            assert r.status_code == 503
            assert "APP_KEY not configured" in r.json()["detail"]

            r = client.post(
                "/v1/analyze-episode",
                json={
                    "episode_guid": "misconfig-guid",
                    "audio_url": "https://example.com/ep.mp3",
                },
            )
            assert r.status_code == 503

            # public routes still work
            assert client.get("/v1/health").status_code == 200
            assert client.get("/").status_code == 200
    finally:
        os.environ["APP_KEY"] = "test-secret-key"
        get_settings.cache_clear()


def test_analyze_rate_limit_returns_429():
    """After N analyze POSTs from one IP, further requests get 429."""
    os.environ["APP_KEY"] = "test-secret-key"
    os.environ["ANALYZE_RATE_LIMIT"] = "3"
    os.environ["ANALYZE_RATE_WINDOW_SECONDS"] = "3600"
    get_settings.cache_clear()
    from app.rate_limit import reset_analyze_limiter

    reset_analyze_limiter()
    try:
        with TestClient(app) as client:
            payload = {
                "episode_guid": "rate-limit-guid",
                "audio_url": "https://example.com/ep.mp3",
                "force": True,
            }
            for i in range(3):
                r = client.post("/v1/analyze-episode", json={**payload, "episode_guid": f"rl-{i}"})
                assert r.status_code == 200, r.text
            r = client.post("/v1/analyze-episode", json={**payload, "episode_guid": "rl-overflow"})
            assert r.status_code == 429
            assert "Rate limit" in r.json()["detail"]
            assert "Retry-After" in r.headers
            # health unaffected
            assert client.get("/v1/health").status_code == 200
            # skip-map unaffected
            assert client.get("/v1/skip-map/any").status_code == 200
    finally:
        os.environ.pop("ANALYZE_RATE_LIMIT", None)
        os.environ.pop("ANALYZE_RATE_WINDOW_SECONDS", None)
        get_settings.cache_clear()
        reset_analyze_limiter()


def test_expired_skip_maps_are_deleted_only_after_retention(monkeypatch, tmp_path):
    import asyncio
    from datetime import datetime, timedelta, timezone

    import aiosqlite
    from app.db import sqlite

    database_path = tmp_path / "retention.db"
    monkeypatch.setattr(sqlite, "_db_path", lambda: database_path)
    now = datetime(2026, 10, 8, tzinfo=timezone.utc)

    async def _seed_and_cleanup():
        await sqlite.init_db()
        expired = (now - timedelta(days=91)).isoformat()
        boundary = (now - timedelta(days=90)).isoformat()
        recent = (now - timedelta(days=89)).isoformat()
        async with aiosqlite.connect(database_path) as db:
            await db.executemany(
                """
                INSERT INTO skip_maps (
                    episode_guid, status, analyzed_at, created_at, updated_at
                ) VALUES (?, 'ready', ?, ?, ?)
                """,
                [
                    ("expired-analyzed", expired, expired, expired),
                    ("expired-fallback", None, expired, expired),
                    ("retention-boundary", boundary, boundary, boundary),
                    ("recent", recent, recent, recent),
                ],
            )
            await db.commit()

        deleted = await sqlite.delete_expired_skip_maps(90, now=now)
        async with aiosqlite.connect(database_path) as db:
            cursor = await db.execute("SELECT episode_guid FROM skip_maps ORDER BY episode_guid")
            remaining = {row[0] for row in await cursor.fetchall()}
        return deleted, remaining

    deleted, remaining = asyncio.run(_seed_and_cleanup())
    assert deleted == 2
    assert remaining == {"recent", "retention-boundary"}


def test_pending_skip_map_includes_progress_fields():
    """While pending, skip-map exposes stage + honest ETA (not fake 0–100 alone)."""
    import asyncio

    from app.db import init_db, set_status
    from app.db.sqlite import get_skip_map

    async def _seed():
        await init_db()
        await set_status(
            "progress-guid",
            "pending",
            stage="transcribing",
            duration_ms=1_800_000,
            reset_started=True,
        )
        return await get_skip_map("progress-guid")

    row = asyncio.run(_seed())
    assert row is not None
    assert row["status"] == "pending"
    assert row["stage"] == "transcribing"
    assert row["stage_label"] == "Transcribing"
    assert row["progress_pct"] is not None
    assert 0 <= row["progress_pct"] < 100
    assert row["eta_seconds"] is not None and row["eta_seconds"] > 0

    with TestClient(app) as client:
        r = client.get("/v1/skip-map/progress-guid")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "pending"
        assert body["stage"] == "transcribing"
        assert body["stage_label"] == "Transcribing"
        assert body["eta_seconds"] >= 5
        assert body["progress_pct"] is not None
