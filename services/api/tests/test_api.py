"""Unit/smoke tests — never call paid APIs (MOCK_ANALYZE)."""

import os

os.environ["MOCK_ANALYZE"] = "true"
os.environ["DATABASE_PATH"] = "data/test_skip_maps.db"
os.environ["OPENROUTER_API_KEY"] = ""
os.environ["GROQ_API_KEY"] = ""
os.environ["APP_KEY"] = "test-secret-key"

from fastapi.testclient import TestClient as FastAPITestClient

from app.config import get_settings
from app.main import app
from app.services.detect_ads import heuristic_segments
from app.services.transcribe import stub_transcript


class ApiTestClient(FastAPITestClient):
    def __init__(self, app):
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
        assert stored["audio_sha256"] == hashlib.sha256(audio).hexdigest()

        # Identical bytes reuse the cached result without a new analysis.
        same_audio = client.post(
            "/v1/analyze-episode-upload?sync=true",
            files={"audio_file": ("episode.mp3", audio, "audio/mpeg")},
            data={"episode_guid": "uploaded-guid", "duration_ms": "1800000"},
        )
        assert same_audio.status_code == 200, same_audio.text
        assert same_audio.json()["analyzed_at"] == body["analyzed_at"]

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
