"""Feedback endpoint tests (MOCK_ANALYZE, no paid APIs)."""

from fastapi.testclient import TestClient

from app.main import app
from app.routes import feedback as feedback_routes

KEY = {"X-App-Key": "test-secret-key"}

SAMPLE = {
    "kind": "skipped_content",
    "episode_guid": "fb-test-guid",
    "title": "Test Episode",
    "feed_url": "https://example.com/feed.xml",
    "position_ms": 123456,
    "selected_segment": {"start_ms": 1000, "end_ms": 5000, "type": "advertisement", "confidence": 0.9},
    "segments": [{"start_ms": 1000, "end_ms": 5000, "type": "advertisement", "confidence": 0.9}],
    "model": "google/gemini-3.8-flash",
    "analyzed_at": "2026-10-12T10:00:00+00:00",
    "note": "This was the actual interview",
    "client_created_at": "2026-10-12T15:00:00Z",
}


def test_feedback_requires_app_key():
    feedback_routes.reset_feedback_limiter()
    with TestClient(app) as client:
        assert client.post("/v1/feedback", json=SAMPLE).status_code == 401
        assert client.get("/v1/feedback").status_code == 401
        assert client.post("/v1/feedback", json=SAMPLE, headers={"X-App-Key": "wrong"}).status_code == 401


def test_feedback_create_list_delete():
    feedback_routes.reset_feedback_limiter()
    with TestClient(app) as client:
        r = client.post("/v1/feedback", json=SAMPLE, headers=KEY)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["id"] > 0
        assert body["selected_segment"]["start_ms"] == 1000
        fid = body["id"]

        r = client.get("/v1/feedback", params={"episode_guid": "fb-test-guid"}, headers=KEY)
        assert r.status_code == 200
        items = r.json()
        item = next(i for i in items if i["id"] == fid)
        assert item["note"] == SAMPLE["note"]
        assert item["segments"][0]["end_ms"] == 5000
        assert item["kind"] == "skipped_content"

        assert client.delete(f"/v1/feedback/{fid}", headers=KEY).status_code == 200
        assert client.delete(f"/v1/feedback/{fid}", headers=KEY).status_code == 404


def test_feedback_minimal_missed_ad_and_validation():
    feedback_routes.reset_feedback_limiter()
    with TestClient(app) as client:
        r = client.post("/v1/feedback", json={"kind": "missed_ad", "episode_guid": "g2"}, headers=KEY)
        assert r.status_code == 201
        client.delete(f"/v1/feedback/{r.json()['id']}", headers=KEY)
        bad = client.post("/v1/feedback", json={"kind": "nope", "episode_guid": "g"}, headers=KEY)
        assert bad.status_code == 422


def test_feedback_rate_limited():
    feedback_routes.reset_feedback_limiter()
    with TestClient(app) as client:
        ids = []
        for _ in range(feedback_routes.FEEDBACK_RATE_LIMIT):
            r = client.post("/v1/feedback", json={"kind": "missed_ad", "episode_guid": "rl"}, headers=KEY)
            assert r.status_code == 201
            ids.append(r.json()["id"])
        r = client.post("/v1/feedback", json={"kind": "missed_ad", "episode_guid": "rl"}, headers=KEY)
        assert r.status_code == 429
        for fid in ids:
            client.delete(f"/v1/feedback/{fid}", headers=KEY)
    feedback_routes.reset_feedback_limiter()
