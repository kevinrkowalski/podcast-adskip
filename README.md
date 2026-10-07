# Podcast AdSkip

Personal Android podcast finder/player with **cloud AI ad-skip**.

- **Mobile:** Expo SDK 57 (TypeScript) — search (Apple iTunes), subscribe (RSS `feedUrl` + enclosure), play with auto-seek over ad segments
- **API:** Python FastAPI — OpenRouter Whisper `openai/whisper-large-v3-turbo` (`verbose_json` segments) → cheap OpenRouter chat labels → skip-map cached by episode GUID (SQLite). Client seeks; **no FFmpeg rewrite** in v1. Audio **>25 MB is ffmpeg-chunked** before STT (OpenRouter multipart limit).

Design notes: [`docs/RECOMMENDATION.md`](docs/RECOMMENDATION.md)

---

## Repo layout

```
podcast-adskip/
├── apps/mobile/          # Expo app (Search, Library, Player)
├── services/api/         # FastAPI skip-map service
├── docs/RECOMMENDATION.md
└── README.md
```

---

## Quick start — API

```bash
cd services/api
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Put your real key in .env (never commit it):
#   OPENROUTER_API_KEY=sk-or-...
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

- Health: http://localhost:8000/v1/health  
- Docs: http://localhost:8000/docs  

### Env (`services/api/.env`)

| Variable | Purpose |
|----------|---------|
| **`OPENROUTER_API_KEY`** | **Required for real Whisper STT + (default) chat labeling.** Leave empty for stub/mock mode. |
| `OPENROUTER_BASE_URL` | Default `https://openrouter.ai/api/v1` |
| `WHISPER_MODEL` | Default `openai/whisper-large-v3-turbo` (affordable Whisper-class on OpenRouter with `verbose_json` segments) |
| `OPENROUTER_LLM_MODEL` | Default `google/gemini-2.5-flash` (cheap chat). Alt: `meta-llama/llama-3.3-70b-instruct` |
| `LLM_PROVIDER` | `openrouter` (default), `groq`, `gemini`, or `stub` |
| `GROQ_API_KEY` | **Legacy / optional.** Used only when OpenRouter key is absent. Prefer OpenRouter. |
| `LLM_API_KEY` / `GEMINI_API_KEY` | Optional direct Gemini / override keys |
| `MOCK_ANALYZE` | `true` forces stub even if keys exist |
| `APP_KEY` | Required shared secret for protected API routes (`X-App-Key`); generate with `openssl rand -hex 32` and set the same value in the mobile app |
| `CORS_ORIGINS` | `*` or comma-separated origins |
| `DATABASE_PATH` | SQLite file (default `data/skip_maps.db`) |
| `MAX_AUDIO_MB` | Per-chunk STT upload limit (default `25` for OpenRouter multipart); larger files are **chunked with ffmpeg** |

**Without `OPENROUTER_API_KEY` (and without legacy `GROQ_API_KEY`) the API returns stub skip-maps** (keyword heuristic on fake transcript) so you can develop the client free of charge.

### Transcription path (OpenRouter)

Primary: OpenRouter **Speech-to-Text** `POST /api/v1/audio/transcriptions` (OpenAI-compatible multipart), model **`openai/whisper-large-v3-turbo`**, with:

- `response_format=verbose_json`
- `timestamp_granularities=["segment"]`

This yields timed `segments[]` used for ad labeling. Providers on OpenRouter that support Whisper timestamps include DeepInfra and Groq.

**Fallback if STT/`verbose_json` is unavailable for a model:** pick another Whisper-class OpenRouter STT slug that documents segment timestamps (e.g. `openai/whisper-large-v3`). Chat Completions multimodal `input_audio` is **not** a substitute for segment times — use it only as a last-resort transcript dump paired with keyword heuristics (documented here so we do not silently lose skip precision).

### Smoke tests (mocked — no paid APIs)

```bash
cd services/api && source .venv/bin/activate
MOCK_ANALYZE=true pytest -q
```

### Docker (optional)

```bash
cd services/api
docker build -t podcast-adskip-api .
docker run --rm -p 8000:8000 \
  -e OPENROUTER_API_KEY= \
  -e MOCK_ANALYZE=true \
  -v adskip-data:/data podcast-adskip-api
```

### API surface

- `GET /v1/health` — reports `openrouter_configured`, `groq_configured` (legacy), `llm_configured`, `mock_mode`
- `POST /v1/analyze-episode` — body `{ episode_guid, audio_url, title?, duration_ms?, feed_url?, force? }`; downloads audio on the API server.
- `POST /v1/analyze-episode-upload` — multipart upload used by the client's **Prepare** flow; analyzes the exact file downloaded by the client for playback.
- Both analysis endpoints queue by default (`status: queued`); add `?sync=true` for blocking calls (tests). Ready skip maps and analyzed-audio metadata are cached in SQLite.
- `GET /v1/skip-map/{episode_guid}` → `ready | pending | missing | error`, including audio URL/size/duration metadata when available.

Skip-map segment: `{ start_ms, end_ms, type, confidence }`

---

## Quick start — Mobile (Expo)

```bash
cd apps/mobile
cp .env.example .env
# Set EXPO_PUBLIC_API_URL:
#   Android emulator → http://10.0.2.2:8000
#   Physical device  → http://<your-computer-LAN-IP>:8000
npm install
npx expo start
```

Screens:

1. **Search** — iTunes podcast search → Subscribe  
2. **Library** — subscriptions → open show → RSS episodes  
3. **Player** — play/pause/seek, **Auto-skip ads** toggle, **Prepare ad-skip** (calls API)

### Playback: expo-audio

`src/player/trackPlayer.ts` is the app's playback facade and uses **`expo-audio`** for native playback, seeking, background audio, and lock-screen controls. If the native audio module is unavailable, it falls back to a stub clock for UI and skip-map development; that fallback does not play audio. The app does not use RNTP or a headless playback service.

For native Android playback, build and run the app with its native configuration:

```bash
cd apps/mobile
npx expo run:android
```

Or build a sideloadable APK with EAS:

```bash
cd apps/mobile
npx eas-cli build -p android --profile preview
```

The `expo-audio` config plugin enables background playback. `app.json` also configures audio background modes/permissions and Android cleartext traffic for local API development. Use `npx expo start` to run the JavaScript development server.

Typecheck / skip helper smoke:

```bash
cd apps/mobile
npm run typecheck
npm run skip-smoke
```

### EAS APK (sideload)

1. Install EAS CLI: `npm i -g eas-cli` and `eas login`
2. In `apps/mobile`: `eas init` (replace `extra.eas.projectId` in `app.json`)
3. Build the preview APK:

```bash
cd apps/mobile
eas build -p android --profile preview
```

---

## Ad-skip pipeline (v1)

1. Client plays the episode from its enclosure URL (or the local analysis download, if available).
2. On play, the client looks up `GET /v1/skip-map/{guid}` and can queue server-side analysis with `POST /v1/analyze-episode` if needed. **Prepare** instead downloads on the client and sends that file to `POST /v1/analyze-episode-upload`.
3. The API transcribes, labels, and caches segments in SQLite; large audio is chunked when needed.
4. Client polls until `ready`, filters segments using show preferences, and seeks to `end_ms` when playback enters an enabled segment.
5. Toggle **Auto-skip ads** off to hear everything.

Personal use only; respect show licenses / ToS. Audio is sent to OpenRouter (and its STT/LLM providers) for analysis.

---

## Cost (personal)

Roughly **~$1–7/month** at ~15–25 new hours analyzed (cache hits free). Whisper turbo on OpenRouter is on the order of a few cents per hour of audio; Flash/Llama labeling is cheap. See recommendation doc.

---

## License

Personal project scaffold — use at your own risk.
