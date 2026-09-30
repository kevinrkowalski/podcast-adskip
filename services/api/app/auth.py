"""Shared X-App-Key auth for protected personal-production routes."""

from __future__ import annotations

import hmac

from fastapi import HTTPException

from app.config import get_settings


def check_app_key(x_app_key: str | None) -> None:
    """Enforce optional / required APP_KEY on protected routes.

    Behavior:
    - ``require_app_key`` true and ``app_key`` empty → 503 misconfig
      (documented: reject at request time so health/startup stay up).
    - ``app_key`` empty and ``require_app_key`` false → open (local LAN).
    - ``app_key`` set → require matching ``X-App-Key`` via constant-time compare.
    """
    settings = get_settings()
    expected = (settings.app_key or "").strip()

    if settings.require_app_key and not expected:
        raise HTTPException(status_code=503, detail="APP_KEY not configured")

    if not expected:
        return

    provided = x_app_key if x_app_key is not None else ""
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing X-App-Key")
