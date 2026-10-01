"""Unit/smoke tests — never call paid APIs (MOCK_ANALYZE)."""

import os

os.environ["MOCK_ANALYZE"] = "true"
os.environ["DATABASE_PATH"] = "data/test_skip_maps.db"
os.environ["OPENROUTER_API_KEY"] = ""
os.environ["GROQ_API_KEY"] = ""
os.environ["APP_KEY"] = ""
os.environ["REQUIRE_APP_KEY"] = "false"

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services.detect_ads import heuristic_segments
from app.services.transcribe import stub_transcript

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
        assert cached.json()["status"] == "ready"
        assert len(cached.json()["segments"]) >= 1


def test_heuristic_labels_sponsor_text():
    tx = stub_transcript(1_800_000)
    segs = heuristic_segments(tx)
    assert any(s.start_ms == 0 for s in segs)
    assert any(s.type == "advertisement" for s in segs)


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
    os.environ["REQUIRE_APP_KEY"] = "false"
    get_settings.cache_clear()
    try:
        with TestClient(app) as client:
            r = client.get("/v1/skip-map/any-guid")
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
        os.environ["APP_KEY"] = ""
        os.environ["REQUIRE_APP_KEY"] = "false"
        get_settings.cache_clear()


def test_require_app_key_without_key_returns_503():
    """REQUIRE_APP_KEY=true with empty APP_KEY → 503 on protected routes."""
    os.environ["APP_KEY"] = ""
    os.environ["REQUIRE_APP_KEY"] = "true"
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
        os.environ["APP_KEY"] = ""
        os.environ["REQUIRE_APP_KEY"] = "false"
        get_settings.cache_clear()


def test_analyze_rate_limit_returns_429():
    """After N analyze POSTs from one IP, further requests get 429."""
    os.environ["APP_KEY"] = ""
    os.environ["REQUIRE_APP_KEY"] = "false"
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


def test_adsegment_maps_legacy_types():
    from app.models.schemas import AdSegment, map_legacy_segment_type

    assert map_legacy_segment_type("sponsor") == "advertisement"
    assert map_legacy_segment_type("midroll") == "advertisement"
    assert map_legacy_segment_type("preroll") == "advertisement"
    assert map_legacy_segment_type("postroll") == "advertisement"
    assert map_legacy_segment_type("crosspromo") == "self_promotion"
    assert map_legacy_segment_type("network") == "self_promotion"
    assert map_legacy_segment_type("advertisement") == "advertisement"

    seg = AdSegment.model_validate(
        {"start_ms": 0, "end_ms": 5000, "type": "sponsor", "confidence": 0.9}
    )
    assert seg.type == "advertisement"
    seg2 = AdSegment.model_validate(
        {"start_ms": 10, "end_ms": 20, "type": "crosspromo", "confidence": 0.8}
    )
    assert seg2.type == "self_promotion"


def test_get_skip_map_accepts_legacy_sponsor_type(tmp_path, monkeypatch):
    """Legacy segments_json with type=sponsor must not 500 on get_skip_map."""
    import asyncio
    import json

    db_path = tmp_path / "legacy_skip_maps.db"
    monkeypatch.setenv("DATABASE_PATH", str(db_path))
    monkeypatch.setenv("MOCK_ANALYZE", "true")
    monkeypatch.setenv("APP_KEY", "")
    monkeypatch.setenv("REQUIRE_APP_KEY", "false")
    get_settings.cache_clear()

    from app.db import sqlite as sqlite_db

    async def _run():
        await sqlite_db.init_db()
        now = sqlite_db._now()
        legacy = json.dumps(
            [
                {"start_ms": 0, "end_ms": 15000, "type": "sponsor", "confidence": 0.9},
                {"start_ms": 100000, "end_ms": 120000, "type": "midroll", "confidence": 0.85},
                {"start_ms": 200000, "end_ms": 210000, "type": "crosspromo", "confidence": 0.8},
            ]
        )
        async with __import__("aiosqlite").connect(db_path) as db:
            await db.execute(
                """
                INSERT INTO skip_maps (
                  episode_guid, status, segments_json, model, analyzed_at,
                  created_at, updated_at
                ) VALUES (?, 'ready', ?, 'legacy-test', ?, ?, ?)
                """,
                ("legacy-sponsor-guid", legacy, now, now, now),
            )
            await db.commit()

        result = await sqlite_db.get_skip_map("legacy-sponsor-guid")
        assert result is not None
        assert result["status"] == "ready"
        types = [s.type for s in result["segments"]]
        assert types == ["advertisement", "advertisement", "self_promotion"]

        # Soft-migrate: stored JSON should now use canonical types
        async with __import__("aiosqlite").connect(db_path) as db:
            cur = await db.execute(
                "SELECT segments_json FROM skip_maps WHERE episode_guid = ?",
                ("legacy-sponsor-guid",),
            )
            row = await cur.fetchone()
            stored = json.loads(row[0])
            assert [s["type"] for s in stored] == [
                "advertisement",
                "advertisement",
                "self_promotion",
            ]

    asyncio.run(_run())
    get_settings.cache_clear()
