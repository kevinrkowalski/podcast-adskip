# Fix Implementation Summary

## Root Cause Identified

**Dynamic Ad Insertion / CDN Variants**

The bug was caused by podcast RSS feeds using programmatic ad insertion where the same enclosure URL serves different audio files for each HTTP request:

1. **Analysis time**: API downloads version A with ads at timestamps [X, Y, Z]
2. **Playback time**: Player loads version B (different file) with no ads or different ads
3. **Result**: Skip map timestamps are inaccurate; ads appear "missing" even with toggle OFF

This is a common issue with podcasts on platforms like:
- Megaphone
- ART19  
- Spotify
- NPR
- Gimlet

## Solution Implemented

### Phase 1: Detection & Validation (This PR)

#### Backend Changes (Python/FastAPI)

**Database schema updates** (`app/db/sqlite.py`):
- Added columns: `analyzed_audio_size_bytes`, `analyzed_audio_duration_ms`
- Store file characteristics from analysis for later validation
- Auto-migrate existing databases with ALTER TABLE

**Analysis pipeline** (`app/services/analyze_pipeline.py`):
- Capture audio file size after download
- Extract duration from Whisper transcript
- Pass metadata to `save_skip_map()`

**API responses** (`app/models/schemas.py`, `app/routes/*.py`):
- Return `audio_url`, `analyzed_audio_size_bytes`, `analyzed_audio_duration_ms`
- Enables client-side validation

#### Mobile Changes (TypeScript/React Native)

**Audio validation module** (`src/player/audioValidation.ts`):
- `detectAudioMismatch()` - checks for 4 types of mismatches:
  1. URL base path changed (HIGH severity)
  2. Time-based query params like `?timestamp=` or `?expires=` (MEDIUM)
  3. Duration mismatch >5 seconds (HIGH)
  4. Analysis >24 hours old with dynamic URLs (LOW)
- `formatMismatchSummary()` - prioritizes warnings by severity

**Playback context** (`src/store/PlaybackContext.tsx`):
- Call validation when skip map is loaded (local cache, remote fetch, polling)
- Set `audioMismatchWarning` state
- Log warnings to console for debugging

**Player UI** (`app/(tabs)/player.tsx`):
- Display yellow warning banner above action strip when mismatch detected
- Show clear, actionable message to user
- Only shows when segments exist (skip map ready)

**Type updates** (`src/types/index.ts`):
- Extended `SkipMap` interface with new metadata fields

**Theme** (`constants/Colors.ts`):
- Added `accentWarn` color (#FFC107) for warning UI

#### Testing

**Unit tests** (`src/player/audioValidation.test.ts`):
- 11 test cases covering all detection scenarios
- Edge cases: null maps, no segments, small duration differences
- Warning prioritization and formatting

## Verification Steps

### Automated Tests

```bash
# Backend (Python)
cd services/api
python3 -m py_compile app/db/sqlite.py app/services/analyze_pipeline.py

# Mobile (TypeScript)
cd apps/mobile
npx typescript --noEmit

# Unit tests (if Jest configured)
npm test -- audioValidation.test.ts
```

### Manual Testing

1. **Find a podcast with dynamic ad insertion**:
   - Search for shows on NPR, Gimlet, or Spotify-hosted podcasts
   - Look for RSS enclosure URLs with query params like `?token=` or `?expires=`

2. **Analyze an episode**:
   - Open episode in the app
   - Tap "Prepare" to analyze
   - Wait for skip map to be ready
   - Note the segment timestamps

3. **Wait for ad rotation** (or use different device/network):
   - Wait 30-60 minutes for CDN to serve different version
   - Or: Use a VPN/different location
   - Or: Clear cache and request from different User-Agent

4. **Play and verify warning**:
   - Play the same episode
   - If URL has time-based params → expect MEDIUM severity warning
   - If duration differs significantly → expect HIGH severity warning
   - Warning banner should appear above "Speed / Ad-skip / Prepare / More" buttons

5. **Verify warning is accurate**:
   - Scrub to timestamps shown in skip map
   - If ads are actually missing → warning was correct
   - If ads are present → false positive (may need tuning)

### Expected Behavior

**Before this fix**:
- Ads missing, no indication why
- User confused about skip map accuracy
- No way to detect the issue

**After this fix**:
- Yellow warning banner appears: "Audio URL contains time-based parameters..."
- Console log: `[playback] Audio mismatch detected: ...`
- User understands that audio may differ from analysis
- Can re-analyze if needed

## Files Changed

```
BUG_ANALYSIS.md                                     (NEW)
apps/mobile/app/(tabs)/player.tsx                   (UI warning banner)
apps/mobile/constants/Colors.ts                     (accentWarn color)
apps/mobile/src/player/audioValidation.ts           (NEW - detection logic)
apps/mobile/src/player/audioValidation.test.ts      (NEW - unit tests)
apps/mobile/src/store/PlaybackContext.tsx           (integration)
apps/mobile/src/types/index.ts                      (type updates)
services/api/app/db/sqlite.py                       (schema + migration)
services/api/app/models/schemas.py                  (response models)
services/api/app/routes/analyze.py                  (response updates)
services/api/app/routes/skip_map.py                 (response updates)
services/api/app/services/analyze_pipeline.py       (capture metadata)
```

## Future Enhancements (Phase 2)

1. **Cache analyzed audio**:
   - Store the actual audio file that was analyzed
   - Play from cache instead of re-downloading
   - Trade-off: Storage space vs accuracy

2. **Auto re-analyze on mismatch**:
   - When HIGH severity mismatch detected
   - Automatically trigger background re-analysis
   - Update skip map with new timestamps

3. **Audio fingerprinting**:
   - Use chromaprint or similar to create audio fingerprint during analysis
   - Compare fingerprint at playback time
   - Detect content changes even if duration matches

4. **User controls**:
   - Setting: "Always use latest audio" vs "Use cached analyzed audio"
   - Button in warning banner: "Re-analyze now"
   - Option to dismiss warning for specific episodes

## Performance Impact

- **Backend**: Minimal - 2 extra INTEGER columns, populated during analysis
- **Mobile**: Negligible - validation runs only when skip map loads (not per-frame)
- **Network**: No extra requests (uses existing skip map API)
- **Storage**: ~8 bytes per episode (size + duration metadata)

## Deployment Notes

1. **Database migration**: Auto-applies on first API startup (ALTER TABLE)
2. **Backward compatibility**: 
   - Old API → New client: Works (client handles missing fields)
   - New API → Old client: Works (client ignores new fields)
   - Old skip maps in DB: Work (new columns NULL, no warnings shown)
3. **No user data loss**: Existing skip maps remain valid
4. **Rollback safe**: Can revert without data corruption

## Related Documentation

- See `BUG_ANALYSIS.md` for detailed technical explanation
- See PR description for testing scenarios
- See unit tests for validation logic examples