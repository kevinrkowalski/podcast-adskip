import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import fail_interrupted_analyses, init_db
from app.db.learning import delete_expired_transcripts
from app.db.sqlite import delete_expired_skip_maps
from app.routes import analyze, feedback, health, resolve, skip_map, upload

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


async def _cleanup_expired_records() -> None:
    deleted = await delete_expired_skip_maps(settings.skip_map_retention_days)
    if deleted:
        logger.info("Deleted %d expired skip-map records", deleted)
    deleted = await delete_expired_transcripts(settings.skip_map_retention_days)
    if deleted:
        logger.info("Deleted %d expired cached transcripts", deleted)


async def _cleanup_expired_skip_maps_periodically() -> None:
    # Startup already ran a cleanup, so wait a day before the next one.
    while True:
        await asyncio.sleep(24 * 60 * 60)
        try:
            await _cleanup_expired_records()
        except Exception:
            logger.exception("Scheduled skip-map cleanup failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    # Single-process server: no background task survives a restart, so any
    # row still pending now can never finish.
    interrupted = await fail_interrupted_analyses()
    if interrupted:
        logger.warning("Marked %d interrupted pending analyses as error", interrupted)
    try:
        await _cleanup_expired_records()
    except Exception:
        logger.exception("Startup skip-map cleanup failed")

    cleanup_task = asyncio.create_task(_cleanup_expired_skip_maps_periodically())
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task


_docs_enabled = not (settings.app_key or "").strip()

app = FastAPI(
    title="Podcast Ad-Skip API",
    version="0.1.0",
    description="OpenRouter Whisper + LLM skip-map service for personal podcast player",
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(analyze.router)
app.include_router(skip_map.router)
app.include_router(upload.router)
app.include_router(feedback.router)
app.include_router(resolve.router)


@app.get("/")
async def root() -> dict[str, str | None]:
    return {
        "service": "podcast-adskip-api",
        "docs": "/docs" if _docs_enabled else None,
        "health": "/v1/health",
    }
