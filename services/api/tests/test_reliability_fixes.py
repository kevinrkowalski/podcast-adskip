"""Regression tests for event-loop, restart, dedupe, rate-limit and labeling fixes."""

import asyncio
import hashlib
import os
import subprocess
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.models.schemas import AdSegment

HEADERS = {"X-App-Key": "test-secret-key"}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- restart recovery -------------------------------------------------------


def test_fail_interrupted_analyses_marks_only_pending_rows(monkeypatch, tmp_path):
    from app.db import sqlite

    monkeypatch.setattr(sqlite, "_db_path", lambda: tmp_path / "restart.db")

    async def _run():
        await sqlite.init_db()
        await sqlite.set_status("stuck", "pending", stage="transcribing", reset_started=True)
        await sqlite.save_skip_map("done", [], "m", audio_sha256="abc")
        changed = await sqlite.fail_interrupted_analyses()
        return changed, await sqlite.get_skip_map("stuck"), await sqlite.get_skip_map("done")

    changed, stuck, done = asyncio.run(_run())
    assert changed == 1
    assert stuck["status"] == "error"
    assert stuck["stage"] == "error"
    assert stuck["message"] == "Analysis interrupted (server restarted)"
    assert done["status"] == "ready"
    assert done["audio_sha256"] == "abc"


def test_startup_unblocks_analysis_left_pending(monkeypatch):
    from app.db import init_db, set_status
    from app.db.sqlite import get_skip_map

    async def _seed():
        await init_db()
        await set_status("restart-guid", "pending", stage="labeling", reset_started=True)

    asyncio.run(_seed())
    with TestClient(app, headers=HEADERS) as client:
        assert asyncio.run(get_skip_map("restart-guid"))["status"] == "error"
        r = client.post(
            "/v1/analyze-episode",
            json={"episode_guid": "restart-guid", "audio_url": "https://example.com/ep.mp3"},
        )
        assert r.status_code == 200
        assert r.json()["message"] == "Analysis queued"


# --- pending fingerprint ----------------------------------------------------


def test_set_status_pending_sha_is_kept_across_stages_and_cleared_by_new_run(monkeypatch, tmp_path):
    from app.db import sqlite

    monkeypatch.setattr(sqlite, "_db_path", lambda: tmp_path / "pending-sha.db")

    async def _run():
        await sqlite.init_db()
        await sqlite.save_skip_map("g", [], "m", audio_sha256="old")
        await sqlite.set_status("g", "pending", stage="queued", reset_started=True, pending_audio_sha256="new")
        await sqlite.set_status("g", "pending", stage="transcribing")
        during = await sqlite.get_skip_map("g")
        # A URL-route run (no uploaded fingerprint) must not inherit a stale one.
        await sqlite.set_status("g", "pending", stage="queued", reset_started=True)
        after = await sqlite.get_skip_map("g")
        return during, after

    during, after = asyncio.run(_run())
    assert during["pending_audio_sha256"] == "new"
    assert during["audio_sha256"] == "old"
    assert after["pending_audio_sha256"] is None
    assert after["audio_sha256"] == "old"


def test_upload_pending_dedupe_uses_in_flight_audio_fingerprint():
    from app.db import save_skip_map, set_status

    old_audio = b"previously-analyzed-audio"
    in_flight_audio = b"audio-being-analyzed-now"
    guid = "pending-sha-upload-guid"

    with TestClient(app, headers=HEADERS) as client:
        async def _seed():
            await save_skip_map(guid, [], "m", audio_sha256=_sha(old_audio))
            await set_status(
                guid,
                "pending",
                stage="transcribing",
                reset_started=True,
                pending_audio_sha256=_sha(in_flight_audio),
            )

        asyncio.run(_seed())

        same = client.post(
            "/v1/analyze-episode-upload",
            files={"audio_file": ("ep.mp3", in_flight_audio, "audio/mpeg")},
            data={"episode_guid": guid},
        )
        assert same.status_code == 200, same.text
        assert same.json()["message"] == "Analysis already in progress for this audio"

        old = client.post(
            "/v1/analyze-episode-upload",
            files={"audio_file": ("ep.mp3", old_audio, "audio/mpeg")},
            data={"episode_guid": guid},
        )
        assert old.status_code == 200, old.text
        assert old.json()["message"] == "Analysis queued (client upload)"


# --- rate limiting ----------------------------------------------------------


@pytest.fixture
def rate_limit(request):
    from app.rate_limit import reset_analyze_limiter

    os.environ["ANALYZE_RATE_LIMIT"] = str(request.param)
    os.environ["ANALYZE_RATE_WINDOW_SECONDS"] = "3600"
    get_settings.cache_clear()
    reset_analyze_limiter()
    yield
    os.environ.pop("ANALYZE_RATE_LIMIT", None)
    os.environ.pop("ANALYZE_RATE_WINDOW_SECONDS", None)
    get_settings.cache_clear()
    reset_analyze_limiter()


@pytest.mark.parametrize("rate_limit", [1], indirect=True)
def test_rate_limit_ignores_cache_hits_and_already_pending(rate_limit):
    from app.db import save_skip_map, set_status

    cached_audio = b"rl-cached-audio"
    pending_audio = b"rl-pending-audio"
    with TestClient(app, headers=HEADERS) as client:
        async def _seed():
            await save_skip_map("rl-cache-guid", [], "m", audio_sha256=_sha(cached_audio))
            await set_status(
                "rl-pending-guid",
                "pending",
                stage="transcribing",
                reset_started=True,
                pending_audio_sha256=_sha(pending_audio),
            )

        asyncio.run(_seed())

        for _ in range(3):
            r = client.post(
                "/v1/analyze-episode-upload",
                files={"audio_file": ("ep.mp3", cached_audio, "audio/mpeg")},
                data={"episode_guid": "rl-cache-guid"},
            )
            assert r.status_code == 200 and r.json()["status"] == "ready", r.text

            r = client.post(
                "/v1/analyze-episode-upload",
                files={"audio_file": ("ep.mp3", pending_audio, "audio/mpeg")},
                data={"episode_guid": "rl-pending-guid"},
            )
            assert r.status_code == 200 and r.json()["status"] == "queued", r.text

            r = client.post(
                "/v1/analyze-episode",
                json={"episode_guid": "rl-pending-guid", "audio_url": "https://example.com/a.mp3"},
            )
            assert r.json()["message"] == "Analysis already in progress", r.text

        payload = {"audio_url": "https://example.com/a.mp3", "force": True}
        r = client.post("/v1/analyze-episode", json={**payload, "episode_guid": "rl-real-1"})
        assert r.status_code == 200, r.text
        r = client.post("/v1/analyze-episode", json={**payload, "episode_guid": "rl-real-2"})
        assert r.status_code == 429


@pytest.mark.parametrize("rate_limit", [2], indirect=True)
def test_rate_limit_counts_bad_app_keys(rate_limit):
    with TestClient(app, headers=HEADERS) as client:
        payload = {"episode_guid": "rl-bad-key", "audio_url": "https://example.com/a.mp3"}
        bad = {"X-App-Key": "wrong"}
        assert client.post("/v1/analyze-episode", json=payload, headers=bad).status_code == 401
        r = client.post(
            "/v1/analyze-episode-upload",
            files={"audio_file": ("ep.mp3", b"x", "audio/mpeg")},
            data={"episode_guid": "rl-bad-key"},
            headers=bad,
        )
        assert r.status_code == 401
        assert client.post("/v1/analyze-episode", json=payload, headers=bad).status_code == 429
        assert client.post("/v1/analyze-episode", json=payload).status_code == 429


# --- transcription / labeling -----------------------------------------------


def test_split_audio_chunks_removes_temp_dir_on_failure(monkeypatch, tmp_path):
    import tempfile

    from app.services import transcribe

    audio = tmp_path / "big.mp3"
    audio.write_bytes(b"\0" * (3 * 1024 * 1024))
    created = []
    real_mkdtemp = tempfile.mkdtemp

    def _mkdtemp(**kwargs):
        path = real_mkdtemp(dir=tmp_path, **kwargs)
        created.append(path)
        return path

    def _fail(*_args, **_kwargs):
        raise subprocess.TimeoutExpired("ffmpeg", 300)

    monkeypatch.setattr(transcribe.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(transcribe, "_ffprobe_duration_s", lambda _path: 100.0)
    monkeypatch.setattr(transcribe.tempfile, "mkdtemp", _mkdtemp)
    monkeypatch.setattr(transcribe.subprocess, "run", _fail)

    with pytest.raises(subprocess.TimeoutExpired):
        transcribe.split_audio_chunks(audio, 1)
    assert created and not os.path.exists(created[0])


def test_openrouter_llm_call_runs_off_the_event_loop(monkeypatch):
    import openai

    from app.services import detect_ads

    call_threads = []

    class _FakeOpenAI:
        def __init__(self, **_kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        def _create(self, **_kwargs):
            call_threads.append(threading.get_ident())
            message = SimpleNamespace(content='{"segments":[]}')
            return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(openai, "OpenAI", _FakeOpenAI)
    transcript = {"duration": 30, "segments": [{"start": 0, "end": 10, "text": "hello"}]}

    async def _run():
        loop_thread = threading.get_ident()
        result = await detect_ads._label_openrouter(transcript, get_settings())
        return loop_thread, result

    loop_thread, result = asyncio.run(_run())
    assert result == []
    assert call_threads and all(t != loop_thread for t in call_threads)


def test_gemini_empty_candidates_or_parts_are_treated_as_no_segments(monkeypatch):
    import httpx

    from app.services import detect_ads

    responses = iter([{"candidates": []}, {"candidates": [{"content": {"parts": []}}]}, {}])

    class _FakeResponse:
        def __init__(self, data):
            self._data = data

        def raise_for_status(self):
            return None

        def json(self):
            return self._data

    class _FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def post(self, *_args, **_kwargs):
            return _FakeResponse(next(responses))

    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    transcript = {
        "duration": 400,
        "segments": [{"start": float(s), "end": float(s + 5), "text": "talk"} for s in (0, 150, 300)],
    }
    assert asyncio.run(detect_ads._label_gemini(transcript, get_settings())) == []


def test_merge_never_combines_unknown_with_ad_segments():
    from app.services.detect_ads import _merge

    ads_around_strong_unknown = _merge(
        [
            AdSegment(start_ms=0, end_ms=30_000, type="sponsor", confidence=0.8),
            AdSegment(start_ms=32_000, end_ms=50_000, type="unknown", confidence=0.95),
            AdSegment(start_ms=52_000, end_ms=60_000, type="sponsor", confidence=0.8),
        ]
    )
    assert [(s.start_ms, s.end_ms, s.type) for s in ads_around_strong_unknown] == [
        (0, 30_000, "sponsor"),
        (32_000, 50_000, "unknown"),
        (52_000, 60_000, "sponsor"),
    ]

    # Speechless-gap bridging must not absorb an unknown span into an ad either.
    transcript = {"segments": [{"start": 10.0, "end": 20.0, "text": "[music]"}]}
    bridged = _merge(
        [
            AdSegment(start_ms=0, end_ms=5_000, type="unknown", confidence=0.7),
            AdSegment(start_ms=20_000, end_ms=30_000, type="sponsor", confidence=0.9),
        ],
        transcript=transcript,
    )
    assert [s.type for s in bridged] == ["unknown", "sponsor"]

    unknowns = _merge(
        [
            AdSegment(start_ms=0, end_ms=5_000, type="unknown", confidence=0.7),
            AdSegment(start_ms=8_000, end_ms=12_000, type="unknown", confidence=0.9),
        ]
    )
    assert [(s.start_ms, s.end_ms, s.type) for s in unknowns] == [(0, 12_000, "unknown")]


def test_windows_overlap_previous_window_tail():
    from app.services.detect_ads import _windows

    transcript = {
        "segments": [
            {"start": float(t), "end": float(t + 10), "text": f"line {t}"} for t in range(0, 300, 10)
        ]
    }
    chunks = _windows(transcript)
    assert len(chunks) >= 2
    assert chunks[0].splitlines()[-1].startswith("[120.0-")
    second = chunks[1].splitlines()
    assert second[0].startswith("[110.0-")
    assert second[1].startswith("[120.0-")
    assert second[2].startswith("[130.0-")
    assert not any(line.startswith("[100.0-") for line in second)
    # Every transcript line still appears in at least one window.
    joined = "\n".join(chunks)
    assert all(f"line {t}" in joined for t in range(0, 300, 10))
