"""Redirect-chain resolution tests (no network)."""

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routes.resolve import resolve_redirects

KEY = {"X-App-Key": "test-secret-key"}


def _client(routes: dict[str, str]) -> httpx.AsyncClient:
    def handler(req: httpx.Request) -> httpx.Response:
        loc = routes.get(str(req.url))
        if loc:
            return httpx.Response(302, headers={"location": loc})
        return httpx.Response(206, content=b"x")

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_resolves_tracking_chain():
    routes = {
        "https://dts.podtrac.com/redirect.mp3/a": "https://pdst.fm/e/a",
        "https://pdst.fm/e/a": "https://pscrb.fm/rss/p/a",
        "https://pscrb.fm/rss/p/a": "https://prefix-v4.pscrb.fm/shadow/ipv4/a",
        "https://prefix-v4.pscrb.fm/shadow/ipv4/a": "https://cdn.example.com/a.mp3",
    }

    async def run():
        async with _client(routes) as c:
            return await resolve_redirects("https://dts.podtrac.com/redirect.mp3/a", c, check_host=False)

    assert asyncio.run(run()) == ("https://cdn.example.com/a.mp3", 4)


def test_detects_loop():
    routes = {"https://a.example/x": "https://b.example/x", "https://b.example/x": "https://a.example/x"}

    async def run():
        async with _client(routes) as c:
            await resolve_redirects("https://a.example/x", c, check_host=False)

    with pytest.raises(ValueError, match="loop"):
        asyncio.run(run())


def test_endpoint_rejects_private_and_needs_key():
    with TestClient(app) as client:
        assert client.post("/v1/resolve-audio-url", json={"url": "http://127.0.0.1/a.mp3"}).status_code == 401
        r = client.post("/v1/resolve-audio-url", json={"url": "http://127.0.0.1/a.mp3"}, headers=KEY)
        assert r.status_code == 422
        r = client.post("/v1/resolve-audio-url", json={"url": "file:///etc/passwd"}, headers=KEY)
        assert r.status_code == 422
