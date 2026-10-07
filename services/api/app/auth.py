"""Shared X-App-Key auth for protected personal-production routes."""

from __future__ import annotations

import hmac

from fastapi import HTTPException

from app.config import get_settings


def check_app_key(x_app_key: str | None) -> None:
    """Require a configured APP_KEY and a matching header on protected routes."""
    expected = (get_settings().app_key or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="APP_KEY not configured")

    provided = x_app_key if x_app_key is not None else ""
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing X-App-Key")
