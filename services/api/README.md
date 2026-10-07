# Podcast Ad-Skip API

See the root [README](../../README.md) for full run instructions.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set OPENROUTER_API_KEY for real Whisper (OpenRouter STT) + chat labeling.
# Leave empty (or MOCK_ANALYZE=true) for stub mode.
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## OPENROUTER_API_KEY

| Mode | Condition | Behavior |
|------|-----------|----------|
| **Real** | `OPENROUTER_API_KEY` set, `MOCK_ANALYZE` not true | Download → ffmpeg-chunk if >25MB → OpenRouter Whisper turbo `verbose_json` → OpenRouter chat labels (Gemini Flash default) → SQLite |
| **Legacy Groq** | Only `GROQ_API_KEY` (no OpenRouter key) | Same pipeline via Groq SDK (optional; deprecated) |
| **Stub** | No STT key or `MOCK_ANALYZE=true` | Fake transcript + keyword heuristic; no paid calls |

### Models (defaults)

| Role | Model | Notes |
|------|-------|-------|
| Transcription | `openai/whisper-large-v3-turbo` | OpenRouter STT `/audio/transcriptions`, `response_format=verbose_json`, `timestamp_granularities=["segment"]` |
| Ad labels | `google/gemini-2.5-flash` | Cheap OpenRouter chat; override with `OPENROUTER_LLM_MODEL` (e.g. `meta-llama/llama-3.3-70b-instruct`) |

If a future OpenRouter speech model lacked `verbose_json` segments, fall back to: (1) another Whisper-class STT slug that supports timestamps, or (2) chat multimodal `input_audio` only as a last resort (no reliable segment times — pair with heuristics). See root README.

Never commit real keys. `.env` is gitignored.


## App key protection

Protected API routes always require an `APP_KEY`; there is no setting to disable this check. Generate a long random key (for example, `openssl rand -hex 32`) and set it in the API's `.env`. Configure the same value in the mobile app Settings (App Key) or `EXPO_PUBLIC_APP_KEY`. Never commit the key. Without `APP_KEY`, protected routes return **503** (`APP_KEY not configured`); with a missing or incorrect `X-App-Key` header, they return **401**. Health and `/` remain public. OpenAPI docs are disabled when an `APP_KEY` is configured.

`POST /v1/analyze-episode` also has an in-memory per-IP rate limit (default **10 requests / hour**, tunable via `ANALYZE_RATE_LIMIT` / `ANALYZE_RATE_WINDOW_SECONDS`). Exceeding it returns **429** with `Retry-After`. Limit resets on process restart.

## Docker

```bash
docker build -t podcast-adskip-api .
docker run --rm -p 8000:8000 \
  -e OPENROUTER_API_KEY= \
  -e MOCK_ANALYZE=true \
  -v adskip-data:/data podcast-adskip-api
```

Pass `-e OPENROUTER_API_KEY=sk-or-...` for real analysis. Optional: `-e OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`.

## Tests

```bash
MOCK_ANALYZE=true pytest -q
```

Requires `ffmpeg`/`ffprobe` on PATH for >25MB chunking in real mode (optional for stub tests).
