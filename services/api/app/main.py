import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import init_db
from app.routes import analyze, health, skip_map

logging.basicConfig(level=logging.INFO)

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    yield


_docs_enabled = not settings.require_app_key

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


@app.get("/")
async def root() -> dict:
    return {
        "service": "podcast-adskip-api",
        "docs": "/docs",
        "health": "/v1/health",
    }
