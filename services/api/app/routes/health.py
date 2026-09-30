from fastapi import APIRouter

from app.config import get_settings
from app.models.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
@router.get("/v1/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    settings = get_settings()
    mock = not settings.has_real_stt
    return HealthResponse(
        status="ok",
        openrouter_configured=settings.has_openrouter,
        groq_configured=bool(settings.groq_api_key) and not settings.mock_analyze,
        llm_configured=settings.has_llm,
        mock_mode=mock or settings.mock_analyze,
    )
