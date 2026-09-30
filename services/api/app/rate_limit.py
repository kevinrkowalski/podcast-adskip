"""Simple in-memory per-IP rate limiter (single-process uvicorn)."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request


class SlidingWindowRateLimiter:
    """Count requests per key inside a sliding time window."""

    def __init__(self, max_requests: int, window_seconds: int) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> tuple[bool, int, int]:
        """Return (allowed, remaining, retry_after_seconds)."""
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.max_requests:
                retry_after = max(1, int(self.window_seconds - (now - q[0])) + 1)
                return False, 0, retry_after
            q.append(now)
            remaining = max(0, self.max_requests - len(q))
            return True, remaining, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


def _get_analyze_limiter() -> SlidingWindowRateLimiter:
    from app.config import get_settings

    s = get_settings()
    # Recreate if settings differ (tests clear get_settings cache and may change env).
    global _analyze_limiter, _analyze_limiter_cfg
    cfg = (s.analyze_rate_limit, s.analyze_rate_window_seconds)
    if _analyze_limiter is None or _analyze_limiter_cfg != cfg:
        _analyze_limiter = SlidingWindowRateLimiter(
            max_requests=max(1, s.analyze_rate_limit),
            window_seconds=max(1, s.analyze_rate_window_seconds),
        )
        _analyze_limiter_cfg = cfg
    return _analyze_limiter


_analyze_limiter: SlidingWindowRateLimiter | None = None
_analyze_limiter_cfg: tuple[int, int] | None = None


def client_ip(request: Request) -> str:
    """Direct client IP only — do not trust X-Forwarded-For (API is not behind a proxy)."""
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def enforce_analyze_rate_limit(request: Request) -> None:
    """Raise 429 when this IP exceeds the configured analyze rate (default 10/hour)."""
    from app.config import get_settings

    limiter = _get_analyze_limiter()
    s = get_settings()
    ip = client_ip(request)
    allowed, _remaining, retry_after = limiter.check(ip)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit exceeded: max {s.analyze_rate_limit} analyze requests "
                f"per IP per {s.analyze_rate_window_seconds}s. Retry in ~{retry_after}s."
            ),
            headers={"Retry-After": str(retry_after)},
        )


def reset_analyze_limiter() -> None:
    """Clear counters (tests)."""
    limiter = _get_analyze_limiter()
    limiter.reset()
