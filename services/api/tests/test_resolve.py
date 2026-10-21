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


def test_connects_to_the_checked_ip_and_joins_redirects_against_the_original_url(monkeypatch):
    from app.routes import resolve

    async def fake_public_ip(host: str) -> str:
        return {"track.example": "93.184.216.34", "cdn.example": "93.184.216.35"}[host]

    monkeypatch.setattr(resolve, "_public_ip", fake_public_ip)
    seen: list[tuple[str, str, str | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((str(req.url), req.headers["host"], req.extensions.get("sni_hostname")))
        if req.url.host == "93.184.216.34":
            return httpx.Response(302, headers={"location": "https://cdn.example/a.mp3"})
        return httpx.Response(200, content=b"x" * 10)  # ignores Range: must not be buffered

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await resolve.resolve_redirects("https://track.example/r/a.mp3", c)

    assert asyncio.run(run()) == ("https://cdn.example/a.mp3", 1)
    assert seen == [
        ("https://93.184.216.34/r/a.mp3", "track.example", "track.example"),
        ("https://93.184.216.35/a.mp3", "cdn.example", "cdn.example"),
    ]


def test_relative_redirect_resolves_against_original_host(monkeypatch):
    from app.routes import resolve

    async def fake_public_ip(host: str) -> str:
        return "93.184.216.34"

    monkeypatch.setattr(resolve, "_public_ip", fake_public_ip)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/r":
            return httpx.Response(302, headers={"location": "/final.mp3"})
        return httpx.Response(206, content=b"x")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await resolve.resolve_redirects("https://track.example/r", c)

    assert asyncio.run(run()) == ("https://track.example/final.mp3", 1)
