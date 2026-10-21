"""Concurrent analyses of one GUID: only the newest run may write the row."""

import asyncio

import pytest

from app.db import sqlite
from app.models.schemas import AdSegment


@pytest.fixture
def db_path(monkeypatch, tmp_path):
    path = tmp_path / "runs.db"
    monkeypatch.setattr(sqlite, "_db_path", lambda: path)
    asyncio.run(sqlite.init_db())
    return path


SEG_A = [AdSegment(start_ms=0, end_ms=30_000, type="sponsor", confidence=0.9)]
SEG_B = [AdSegment(start_ms=60_000, end_ms=90_000, type="sponsor", confidence=0.9)]


def test_superseded_run_cannot_write_stage_result_or_error(db_path):
    async def scenario():
        await sqlite.set_status("g", "pending", stage="queued", reset_started=True, run_id="A")
        # A second upload (other ad variant) starts its own run.
        await sqlite.set_status("g", "pending", stage="queued", reset_started=True, run_id="B")

        with pytest.raises(sqlite.RunSuperseded):
            await sqlite.set_status("g", "pending", stage="labeling", run_id="A")
        with pytest.raises(sqlite.RunSuperseded):
            await sqlite.save_skip_map("g", SEG_A, "m", audio_sha256="a", run_id="A")
        with pytest.raises(sqlite.RunSuperseded):
            await sqlite.set_status("g", "error", error="boom", stage="error", run_id="A")

        await sqlite.save_skip_map("g", SEG_B, "m", audio_sha256="b", run_id="B")
        return await sqlite.get_skip_map("g")

    row = asyncio.run(scenario())
    assert row is not None
    assert row["status"] == "ready"
    assert row["audio_sha256"] == "b"
    assert [(s.start_ms, s.end_ms) for s in row["segments"]] == [(60_000, 90_000)]


def test_route_reset_without_run_id_releases_the_old_run(db_path):
    async def scenario():
        await sqlite.set_status("g", "pending", stage="queued", reset_started=True, run_id="A")
        # The analyze route marks a forced re-run pending before its task claims the row.
        await sqlite.set_status("g", "pending", stage="queued", reset_started=True)
        with pytest.raises(sqlite.RunSuperseded):
            await sqlite.set_status("g", "pending", stage="labeling", run_id="A")
        # Writes without a run_id (routes, startup cleanup) still apply.
        await sqlite.set_status("g", "error", error="x", stage="error")
        return await sqlite.get_skip_map("g")

    row = asyncio.run(scenario())
    assert row is not None and row["status"] == "error"


def test_pipeline_stops_when_superseded(db_path, monkeypatch, tmp_path):
    from app.services import analyze_pipeline

    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"audio-a")

    async def scenario():
        original_stage = analyze_pipeline._stage

        async def stage_then_take_over(episode_guid, stage, **kwargs):
            await original_stage(episode_guid, stage, **kwargs)
            if stage == "queued":
                # Another run takes over right after this one starts.
                await sqlite.set_status(
                    episode_guid, "pending", stage="queued", reset_started=True, run_id="other"
                )

        monkeypatch.setattr(analyze_pipeline, "_stage", stage_then_take_over)
        result = await analyze_pipeline.run_analyze_from_file(
            episode_guid="g", audio_path=audio, duration_ms=60_000
        )
        return result, await sqlite.get_skip_map("g")

    result, row = asyncio.run(scenario())
    assert result["status"] == "pending"
    assert row is not None and row["status"] == "pending"
    assert not row["segments"]
