"""Resolve podcast tracking-redirect chains server-side.

Some phones (OkHttp) hit "Too many follow-up requests" on chains like
podtrac -> pdst.fm -> vpixl -> pscrb.fm (IPv4/IPv6 shadow bounce) -> simplecast.
The app asks this endpoint for the final media URL and downloads that directly.
"""

import asyncio
import ipaddress
import socket
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.auth import check_app_key

router = APIRouter(prefix="/v1", tags=["resolve"])

MAX_HOPS = 15
UA = "PodcastAdSkip/1.0 (Linux; Android) expo-audio"


class ResolveRequest(BaseModel):
    url: str


class ResolveResponse(BaseModel):
    url: str
    hops: int


async def _is_public_host(host: str) -> bool:
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            return False
    return True


async def resolve_redirects(url: str, client: httpx.AsyncClient, *, check_host: bool = True) -> tuple[str, int]:
    """Follow redirects by hand with loop detection. Returns (final_url, hops)."""
    seen: set[str] = set()
    current = url
    for hops in range(MAX_HOPS + 1):
        parts = urlsplit(current)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"Unsupported URL: {current[:200]}")
        if check_host and not await _is_public_host(parts.hostname):
            raise ValueError("URL host is not public")
        if current in seen:
            raise ValueError(f"Redirect loop at {parts.hostname}")
        seen.add(current)
        resp = await client.get(current, headers={"User-Agent": UA, "Range": "bytes=0-0"})
        await resp.aclose()
        if resp.is_redirect and resp.next_request is not None:
            current = str(resp.next_request.url)
            continue
        if resp.status_code >= 400:
            raise ValueError(f"Audio host returned HTTP {resp.status_code}")
        return current, hops
    raise ValueError(f"More than {MAX_HOPS} redirects")


@router.post("/resolve-audio-url", response_model=ResolveResponse)
async def resolve_audio_url(
    body: ResolveRequest,
    x_app_key: Annotated[str | None, Header()] = None,
) -> ResolveResponse:
    check_app_key(x_app_key)
    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=20.0) as client:
            final, hops = await resolve_redirects(body.url.strip(), client)
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ResolveResponse(url=final, hops=hops)
