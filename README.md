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

### Deployment & Reverse Proxy Notes

**Client-side audio upload**: The API accepts multipart audio file uploads (typically 30-100+ MB per episode). If deploying behind a reverse proxy, ensure it allows large request bodies:

**Caddy** (add to your Caddyfile):
```
your-domain.com {
    request_body {
        max_size 200MB  # Allow podcast uploads
    }
    reverse_proxy localhost:8000
}
```

**Nginx** (add to your nginx.conf):
```
http {
    client_max_body_size 200M;  # Allow podcast uploads
}
```

**Apache** (add to your .htaccess or httpd.conf):
```
LimitRequestBody 209715200  # 200MB in bytes
```

Without these settings, uploads >1MB will typically fail with `413 Request Entity Too Large`.  

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
| `APP_KEY` | Optional shared secret (`X-App-Key`) |
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
- `POST /v1/analyze-episode` — body `{ episode_guid, audio_url, title?, duration_ms?, feed_url?, force? }`  
  - Default: queue in background (`status: queued`). Add `?sync=true` for blocking (tests).
  - Cached hit → `status: ready` + segments
  - Pipeline: download → (chunk if >25MB) → Whisper `verbose_json` → LLM/heuristic labels → SQLite
- `GET /v1/skip-map/{episode_guid}` → `ready | pending | missing | error`

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

### Playback: react-native-track-player (RNTP)

`src/player/trackPlayer.ts` prefers **RNTP** for background + lock-screen / notification controls and seek-based ad-skip. Fallback order:

1. **RNTP** (native Dev Client / EAS build)  
2. **expo-av** (limited background)  
3. **Stub clock** (UI + skip-map logic only)

**RNTP does not work in Expo Go.** You need a development build:

```bash
cd apps/mobile
# One-time: eas init (sets extra.eas.projectId in app.json)
npx eas-cli build -p android --profile development   # Dev Client APK
# or local:
npx expo prebuild
npx expo run:android
```

Then start Metro against the Dev Client:

```bash
npx expo start --dev-client
```

Config already in place:

- Custom entry `index.js` registers `TrackPlayer.registerPlaybackService` → `src/player/playbackService.ts`
- `app.json`: `UIBackgroundModes: audio`, Android foreground-service + `POST_NOTIFICATIONS`, `expo-dev-client`, `expo-build-properties` (`usesCleartextTraffic`, **`newArchEnabled: false`** — RNTP is not New-Arch ready)
- `eas.json`: `development` profile has `developmentClient: true` + APK

Typecheck / skip helper smoke:

```bash
cd apps/mobile
npm run typecheck
npm run skip-smoke
```

### EAS APK (sideload)

1. Install EAS CLI: `npm i -g eas-cli` and `eas login`
2. In `apps/mobile`: `eas init` (replace `extra.eas.projectId` in `app.json`)
3. Preview APK (includes RNTP after prebuild):

```bash
cd apps/mobile
eas build -p android --profile preview
```

---

## Ad-skip pipeline (v1)

1. Client plays enclosure URL immediately  
2. `GET /v1/skip-map/{guid}` — if missing → `POST /v1/analyze-episode`  
3. Backend: download audio → chunk if >25MB → OpenRouter Whisper turbo `verbose_json` → OpenRouter chat (Gemini Flash default) / heuristic → SQLite cache  
4. Client polls until `ready`, then while playing: if position ∈ `[start_ms, end_ms)` → `seek(end_ms)`  
5. Toggle **Auto-skip ads** off to hear everything  

Personal use only; respect show licenses / ToS. Audio is sent to OpenRouter (and its STT/LLM providers) for analysis.

---

## Cost (personal)

Roughly **~$1–7/month** at ~15–25 new hours analyzed (cache hits free). Whisper turbo on OpenRouter is on the order of a few cents per hour of audio; Flash/Llama labeling is cheap. See recommendation doc.

---

## License

Personal project scaffold — use at your own risk.
