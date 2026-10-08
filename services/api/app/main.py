import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import init_db
from app.db.sqlite import delete_expired_skip_maps
from app.routes import analyze, health, skip_map, upload

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


async def _cleanup_expired_skip_maps_periodically() -> None:
    while True:
        try:
            deleted = await delete_expired_skip_maps(settings.skip_map_retention_days)
            if deleted:
                logger.info("Deleted %d expired skip-map records", deleted)
        except Exception:
            logger.exception("Scheduled skip-map cleanup failed")
        await asyncio.sleep(24 * 60 * 60)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    try:
        deleted = await delete_expired_skip_maps(settings.skip_map_retention_days)
        if deleted:
            logger.info("Deleted %d expired skip-map records", deleted)
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


@app.get("/")
async def root() -> dict:
    return {
        "service": "podcast-adskip-api",
        "docs": "/docs" if _docs_enabled else None,
        "health": "/v1/health",
    }
