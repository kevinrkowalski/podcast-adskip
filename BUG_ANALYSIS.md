# Bug Analysis: Missing Ads in Playback

## Symptom
- Ad-skip toggle is **OFF**
- Ads are **missing** from audio at timestamps shown in skip map
- Other podcast apps **DO have** ads at those same wall-clock positions
- Timeline matches between apps (same clock positions)

## Root Cause: Dynamic Ad Insertion CDN Variants

Podcast RSS feeds commonly use **programmatic ad insertion** where:
- The enclosure URL stays the same in the RSS feed
- But the CDN serves **different audio files** for each HTTP request
- Ads are dynamically inserted/removed server-side based on:
  - Request time (ads expire/rotate)
  - User-Agent headers
  - Geographic location
  - Cookie/tracking parameters
  - Ad inventory availability

### What Happens:

1. **Analysis Phase** (API):
   - `POST /v1/analyze-episode` receives `audio_url` from RSS enclosure
   - API calls `download_audio(audio_url)` → downloads **version A** with ads at timestamps [5:00, 10:30, 18:45]
   - Whisper transcribes version A
   - LLM labels ads at those positions
   - Skip map saved: `segments: [{start_ms: 300000, end_ms: 315000, ...}, ...]`

2. **Playback Phase** (Mobile):
   - User plays episode (ad-skip OFF)
   - Mobile calls `player.loadAndPlay(episode)` with same `enclosureUrl`
   - Player requests audio from CDN → downloads **version B** (different file!)
   - Version B has:
     - No ads (or different ads)
     - Different content at 5:00, 10:30, 18:45
   - Skip map still shows old timestamps from version A
   - **Result**: User sees "sponsor ad at 5:00" but hears regular content there

3. **Other Apps**:
   - Make their own fresh requests to CDN
   - Get **version C** (yet another variant) which DOES have ads
   - Explains why other apps have ads but ours doesn't

### Key Evidence:
- **NOT a seeking bug**: autoSkip=false is properly checked in tick logic (trackPlayer.ts:256)
- **NOT a timestamp offset**: user confirmed timeline matches between apps
- **IS a file mismatch**: analyzed one audio file, playing a different one

## Proof in Code

### API downloads audio
```python
# services/api/app/services/transcribe.py:49-51
async with httpx.AsyncClient(follow_redirects=True, timeout=180.0) as client:
    async with client.stream("GET", audio_url) as resp:
        resp.raise_for_status()
```

### Mobile plays same URL (but different HTTP request = different file)
```typescript
// apps/mobile/src/player/trackPlayer.ts:338
player = mod.createAudioPlayer({ uri: url }, { updateInterval: 250 });
```

### Both use same enclosureUrl from RSS
```typescript
// apps/mobile/src/api/rss.ts:105
const enclosureUrl = enclosureTag ? attr(enclosureTag, 'url') : undefined;
```

### Database stores analyzed audio_url but doesn't validate on playback
```python
# services/api/app/db/sqlite.py:19
audio_url TEXT,  # URL that was analyzed - not used for validation
```

## Solution

### Phase 1: Detection & Validation (This PR)
1. **Return analyzed_audio_url in skip map response**
   - Client can compare with current enclosure URL
   - Warn if URLs differ (query params changed, redirects, etc.)

2. **Add optional audio fingerprinting**
   - Store file size and duration from analysis
   - Compare with playback metadata
   - Flag mismatches for user awareness

3. **Add stale_detection flag**
   - Mark skip map as potentially stale if:
     - Audio URL has query params with timestamps
     - Analysis is >24 hours old (configurable)
     - File size differs significantly from analysis

### Phase 2: Robust Fix (Future)
1. **Cache analyzed audio** (optional):
   - Store the actual analyzed audio file
   - Serve it for playback instead of re-downloading
   - Trade-off: Storage space vs accuracy

2. **Re-analyze on mismatch**:
   - Detect when playback audio differs
   - Auto-trigger re-analysis
   - Update skip map with new timestamps

3. **Content-based validation**:
   - Extract audio fingerprint (chromaprint)
   - Compare analysis fingerprint with playback
   - Auto-invalidate stale skip maps

## Testing

1. Find a podcast with dynamic ad insertion (e.g., NPR, Gimlet)
2. Analyze an episode → note timestamps
3. Wait 1 hour (let ads rotate)
4. Play episode → verify audio differs at those timestamps
5. Check that validation flags the mismatch

## Related Issues
- Common in podcasts with "Megaphone", "ART19", "Spotify" ad platforms
- RSS enclosure URLs often include tokens that expire
- CDN may use geo-targeting for ads
