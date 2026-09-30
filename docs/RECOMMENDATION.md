# Personal RN Podcast App + Cloud AI Ad-Skip — Recommendation

**Audience:** personal Android sideload APK (finder/player)  
**Sources:** Apple Podcasts search + public RSS (not Spotify)  
**Date:** 2026-09-29

---

## 1. Chosen stack

| Layer | Choice | Why |
|--------|--------|-----|
| Mobile | **Expo (current SDK) + EAS Build → Android APK** | Sideload-friendly; config plugins for background audio; no Play Store needed |
| Audio | **`react-native-track-player` (RNTP)** via Expo Dev Client / prebuild | Purpose-built for podcast players: queue, seek, lock-screen / notification controls, headless playback service. Survives background better for ad-skip seeks than basic players. |
| Fallback audio | `expo-audio` | Sufficient if RNTP setup friction is high; supports background + lock screen (`setActiveForLockScreen`) on Android, but weaker remote-event / queue story |
| Local data | SQLite (`expo-sqlite`) or MMKV | Subscriptions, episode list, cached skip-maps |
| Backend | **Python FastAPI** (small) | `feedparser` / RSS, async jobs, OpenRouter (OpenAI-compatible) STT + chat |
| Hosting | **Fly.io** (or Railway hobby) | Cheap always-on or scale-to-zero; ~$0–5/mo personal |
| Cache store | SQLite on backend + optional R2/S3 later | Skip-maps keyed by episode GUID |

**Build path:** Expo prebuild → EAS `android.buildType: apk` → sideload. Not Expo Go (native audio modules).

---

## 2. Episode discovery: Apple Podcasts + RSS

### Search (no API key)
```
GET https://itunes.apple.com/search?term={q}&media=podcast&entity=podcast&country=us&limit=25
```
Useful fields: `collectionId`, `collectionName`, `artistName`, `feedUrl`, `artworkUrl600`.

### Show + recent episodes (optional shortcut)
```
GET https://itunes.apple.com/lookup?id={collectionId}&entity=podcastEpisode&limit=100
```
- Show row: `wrapperType=track`, includes **`feedUrl`**
- Episode rows: `wrapperType=podcastEpisode`, **`episodeUrl`** = direct audio (MP3/etc.)

**Limits:** ~20 req/min; ~100 results max; no pagination. Fine for personal use. Full archive → parse `feedUrl` RSS.

### RSS (canonical for subscribe + all episodes)
Parse channel + items; audio from `<enclosure url="..." type="audio/mpeg" length="..."/>` (or Atom `rel=enclosure`). Also: `guid`, `itunes:duration`, title, pubDate, artwork. Prefer **RSS enclosure** as source of truth after subscribe; use iTunes for search/discovery only.

Optional free signals: Podcasting 2.0 `podcast:chapters`, Podlove chapters — sometimes mark ads; use as hints, not sole detector.

---

## 3. Ad-detection pipeline (recommended)

### Comparison

| Approach | Cost / hr audio | Latency | Midroll quality | Privacy | Notes |
|----------|-----------------|---------|-----------------|---------|--------|
| **OpenRouter Whisper turbo + cheap LLM timestamps** | **~$0.04 + ~$0.01–0.05 LLM** | Minutes | High (host-read + DAI) | Audio leaves device | `openai/whisper-large-v3-turbo` via OpenRouter STT + Gemini Flash / Llama |
| Direct Groq Whisper (legacy) | **~$0.04 + LLM** | Minutes | High | Same | Optional if only `GROQ_API_KEY`; prefer OpenRouter |
| OpenAI Whisper API + LLM | ~$0.36 + LLM | Minutes | High | Same | Often pricier; skip unless needed |
| Deepgram Nova-3 batch | ~$0.26 | Fast | Needs LLM/heuristics on text | Same | Good STT; not ad-aware alone |
| Specialized “ad API” | N/A / proprietary | — | Unknown | — | No strong cheap public ad-segment API; don’t depend on one |
| Local Whisper + local LLM | ~$0 compute | Slow on CPU | High | Best | Overkill for sideload phone; OK if you add home server later |
| Heuristics only (silence/loudness) | Free | Fast | Poor alone | Best | Use as **assist** (snap cuts), not primary |

### Recommended pipeline (v1)
1. Client/backend fetches episode audio URL (stream or download).
2. Backend downloads audio (or streams to STT if size allows; OpenRouter multipart ≈**25 MB** — chunk long eps with ffmpeg).
3. **Transcribe:** OpenRouter `openai/whisper-large-v3-turbo`, `response_format=verbose_json`, segment timestamps.
4. **Label ads:** OpenRouter `google/gemini-2.5-flash` (or Llama) on transcript windows → `{start_s, end_s, type, confidence}` for sponsor reads, midrolls, cross-promos, network ads.
5. **Return skip-map** (do **not** re-encode audio in v1). Client seeks over segments during playback.
6. **Cache** by `episode_guid` (+ feed URL hash). Reuse forever until force-refresh.

**Why skip-map over rewrite:** no storage of cleaned MP3s, works with progressive download/stream, simpler backend, user still hits original CDN (legal/ToS: personal use only; respect show licenses).

**Latency UX:** analyze on first play / “Prepare ad-skip” button; play immediately without skip; apply map when ready; toast “Ad-skip ready”.

---

## 4. Estimated cost (personal)

Assumptions: ~15–25 **new** hours analyzed / month (cache hits free).

| Item | Estimate |
|------|----------|
| OpenRouter Whisper turbo | 20 h × ~$0.04 = **~$0.80** |
| LLM labeling (Flash / Llama via OpenRouter) | **~$0.30–1.00** |
| Hosting (Fly/Railway) | **~$0–5** |
| **Total** | **~$1–7 / month** |

Archive binge (100 h once): ~$4–6 transcription + ~$2–5 LLM. Still cheap.

---

## 5. Architecture

```
[Android APK - Expo]
  Search (iTunes) → Subscribe (store feedUrl)
  Fetch/parse RSS → Episode list + enclosure URLs
  RNTP: play / pause / seek / lock screen
  On play: GET /skip-map/:guid → if miss, POST /analyze-episode
  While playing: if position enters ad segment → seek to end_ms

[Backend - FastAPI]
  POST /v1/analyze-episode
  GET  /v1/skip-map/{episode_guid}
  GET  /v1/health
  Job queue (in-process asyncio or Redis later)
  Cache: SQLite/Postgres table skip_maps
```

### API shapes

**`POST /v1/analyze-episode`**
```json
{
  "episode_guid": "string",
  "audio_url": "https://...",
  "title": "optional",
  "duration_ms": 3600000,
  "feed_url": "optional"
}
```
Response `202`:
```json
{ "status": "queued", "episode_guid": "..." }
```
or `200` if cached:
```json
{
  "status": "ready",
  "episode_guid": "...",
  "segments": [
    { "start_ms": 120000, "end_ms": 210000, "type": "sponsor", "confidence": 0.92 }
  ],
  "model": "openai/whisper-large-v3-turbo+google/gemini-2.5-flash",
  "analyzed_at": "ISO-8601"
}
```

**`GET /v1/skip-map/{episode_guid}`** → same body with `status: ready|pending|missing`.

Auth: shared secret header for personal use (`X-App-Key`).

---

## 6. v1 feature list

- Search podcasts (iTunes Search API)
- Subscribe / unsubscribe (persist feedUrl + metadata)
- Refresh RSS → episode list with playable enclosure URL
- Play episode with background audio + lock-screen / notification controls
- Request ad analysis; poll/cache skip-map
- Auto-seek over detected ad segments (toggle on/off)
- Minimal UI: Search, Library (subs), Episode list, Now Playing
- Sideload APK via EAS

**Out of v1:** Spotify, accounts/sync, offline download rewrite, social, CarPlay, transcript UI, multi-user.

---

## 7. Proposed folder / repo structure

```
podcast-adskip/
├── apps/
│   └── mobile/                 # Expo RN app
│       ├── app/                # Expo Router screens
│       │   ├── (tabs)/search.tsx
│       │   ├── (tabs)/library.tsx
│       │   ├── episode/[id].tsx
│       │   └── player.tsx
│       ├── src/
│       │   ├── api/            # iTunes, RSS, backend client
│       │   ├── player/         # RNTP service + skip logic
│       │   ├── db/             # subscriptions, skip-map cache
│       │   └── types/
│       ├── app.json
│       └── eas.json            # profile: preview → APK
├── services/
│   └── api/                    # FastAPI
│       ├── app/main.py
│       ├── app/routes/analyze.py
│       ├── app/routes/skip_map.py
│       ├── app/services/transcribe.py   # OpenRouter STT (Whisper)
│       ├── app/services/detect_ads.py   # OpenRouter chat LLM
│       ├── app/services/rss.py
│       ├── app/db/
│       ├── Dockerfile
│       └── requirements.txt
├── docs/
│   └── RECOMMENDATION.md
└── README.md
```

---

## 8. First implementation milestones

1. **Scaffold** — Expo app + FastAPI hello; EAS Android APK sideloads and opens.
2. **Discovery** — iTunes search UI; show `feedUrl`; parse RSS; list episodes with enclosure URLs.
3. **Playback** — RNTP (or expo-audio): play URL, background, lock-screen controls, seek.
4. **Subscribe store** — persist shows/episodes locally; library tab.
5. **Analyze stub** — `POST /analyze-episode` downloads audio, OpenRouter verbose transcript, returns fake/heuristic segments; cache by GUID.
6. **LLM ad labels** — prompt windows → real skip-map; client auto-seek; on/off toggle.
7. **Polish v1** — pending/ready states, error retry, rate-limit friendly caching, APK release profile.

---

## 9. Decision summary

| Decision | Pick |
|----------|------|
| Stack | Expo + EAS APK + **react-native-track-player** + FastAPI |
| Ad detection | **OpenRouter Whisper Large v3 Turbo → Gemini Flash (via OpenRouter) → skip-map cache** |
| Cost | **~$1–7/mo** personal listening |
| Hosting | Fly.io / Railway hobby |
| Audio rewrite | **No in v1** — client seek only |

