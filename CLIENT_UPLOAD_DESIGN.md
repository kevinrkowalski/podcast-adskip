# Client-Side Audio Upload for Analysis

## Overview

This implementation ensures that skip maps are built from **the exact same audio file the mobile player plays**, eliminating mismatches caused by dynamic ad insertion.

## How It Works

### Before (URL-based analysis)
1. Client calls API with `audio_url`
2. API downloads audio via HTTP GET (version A)
3. API analyzes version A → generates skip map
4. Client plays audio via HTTP GET (version B - **different file**)
5. Skip map timestamps don't match what user hears ❌

### After (Client-side upload)
1. Client downloads audio file locally (for playback)
2. Client uploads **that same file** to API
3. API analyzes **the exact file the client has**
4. Client plays from local cache
5. Skip map timestamps perfectly match playback ✅

## Implementation Details

### Backend (FastAPI)

**New endpoint**: `POST /v1/analyze-episode-upload`
- Accepts multipart/form-data with audio file
- Form fields: `audio_file`, `episode_guid`, `title`, `duration_ms`, `feed_url`, `audio_url`, `force`
- Saves uploaded file to temp location
- Calls `run_analyze_from_file()` with local path
- Supports sync and background processing
- Auto-cleans up uploaded file after analysis

**New function**: `run_analyze_from_file()` in `analyze_pipeline.py`
- Accepts already-downloaded `audio_path` instead of `audio_url`
- Skips download step, directly transcribes
- Marks model as `+client-upload` for tracking
- Otherwise identical pipeline: transcribe → label → save

**Files changed**:
- `app/routes/upload.py` - new upload endpoint
- `app/services/analyze_pipeline.py` - new `run_analyze_from_file()`
- `app/main.py` - register upload router

### Mobile (React Native/Expo)

**New module**: `src/api/audioUpload.ts`
- `downloadAudioForAnalysis()` - downloads audio to `FileSystem.cacheDirectory`
- Uses stable cache path based on episode GUID
- Reports download progress
- Reuses cached file if already downloaded
- `uploadAudioForAnalysis()` - uploads file via multipart/form-data
- Uses XMLHttpRequest on native for progress tracking
- Reports upload progress (0-100%)
- `clearAudioCache()` / `getAudioCacheSize()` - cache management

**Updated**: `src/store/PlaybackContext.tsx`
- `requestAnalyze()` now:
  1. Downloads audio with progress (0-50%)
  2. Uploads to API with progress (50-100%)
  3. Shows 'downloading' and 'uploading' stages
- New state: `uploadProgress` with `{ downloaded, uploaded, total }`
- Exposed via context for UI

**Updated**: `app/(tabs)/player.tsx`
- Shows upload progress in analyze progress bar
- Status labels: "Downloading audio" / "Uploading for analysis"
- Progress bar reflects download+upload percentage

**New dependency**: `expo-file-system` (~57.0.7)
- Used for local file download and cache management
- Already compatible with Expo SDK 57

## File Upload Flow

```
┌─────────────┐
│   Mobile    │
│   Player    │
└──────┬──────┘
       │ 1. User taps "Prepare"
       │
       ├──> Download audio (show progress 0-50%)
       │    └─> Cache: /cache/podcast-audio/{guid}.mp3
       │
       ├──> Upload to API (show progress 50-100%)
       │    POST /v1/analyze-episode-upload
       │    Content-Type: multipart/form-data
       │
┌──────▼──────┐
│   FastAPI   │
│   Server    │
└──────┬──────┘
       │ 2. Save uploaded file to /tmp
       │
       ├──> Transcribe (Whisper)
       │
       ├──> Label ads (LLM)
       │
       ├──> Save skip map to DB
       │    model: "whisper+gemini+client-upload"
       │
       └──> Clean up /tmp file
       
┌─────────────┐
│   Mobile    │
│   Player    │
└─────────────┘
       3. Poll for ready status
       4. Load skip map
       5. Play from local cache
       6. Timestamps match perfectly! ✓
```

## Testing

### Prerequisites
1. Build a development client with expo-file-system:
   ```bash
   cd apps/mobile
   npm install
   npx expo prebuild
   npx expo run:android
   ```

2. Ensure API is running with OpenRouter key configured

### Test Scenario

1. **Find a podcast with dynamic ad insertion**:
   - NPR podcasts
   - Gimlet Media
   - Spotify-hosted shows
   - Look for RSS feeds with URLs containing tokens/timestamps

2. **Test client-upload path**:
   - Open episode in app
   - Tap "Prepare" button
   - Observe:
     - Progress bar shows "Downloading audio" (0-50%)
     - Progress bar shows "Uploading for analysis" (50-100%)
     - Analysis continues (transcribing, labeling)
   - Wait for "ready" status

3. **Verify accuracy**:
   - Turn Ad-skip OFF
   - Scrub to a segment timestamp (e.g. 5:00 if map shows ad there)
   - **Hear the actual ad** at that position
   - Compare with another podcast app → should match
   - No mismatch warning should appear

4. **Test cache behavior**:
   - Tap "Prepare" again on same episode
   - Should show "ready" immediately (cached skip map)
   - Close and reopen episode
   - Tap "Prepare" → uses cached audio file (faster upload)

5. **Test with Ad-skip ON**:
   - Enable "Auto-skip ads"
   - Play episode
   - Should automatically seek past ads at correct times
   - Verify ad ranges are actually ads (not content)

### Expected Behavior

**Before this change**:
- Ads missing even with toggle OFF ❌
- Skip map timestamps inaccurate ❌
- Mismatch warnings appear ⚠️

**After this change**:
- Ads present at marked timestamps ✅
- Skip map matches played audio ✅
- No mismatch warnings (audio URLs match) ✅
- Auto-skip seeks correctly ✅

## Performance & Storage

**Mobile**:
- Audio files cached in `FileSystem.cacheDirectory`
- OS automatically manages cache (can be cleared)
- Typical episode: 30-60 MB
- Cache reused for playback (no double download)
- Upload uses chunked streaming (1MB chunks)

**API**:
- Uploaded files stored in `/tmp` (auto-cleaned after analysis)
- Same transcription cost as URL-based (no change)
- Network: Client uploads once, saves future duplicate GET requests

## Fallback Behavior

The old URL-based endpoint (`/v1/analyze-episode`) remains available:
- Used for auto-analyze on play (if needed)
- Used by old clients without file upload support
- Can be called manually via API

User-initiated "Prepare" always uses client-upload path for accuracy.

## Configuration

No new environment variables required. Existing settings apply:
- `OPENROUTER_API_KEY` - for Whisper transcription
- `MAX_AUDIO_MB` - per-chunk upload limit (default 25MB)
- File chunking works the same (ffmpeg splits if needed)

## Migration Notes

- **Backward compatible**: Old clients can still use `/v1/analyze-episode`
- **No database migration**: Uses same skip_maps table
- **Cache management**: Users can clear cache via system settings (Expo cache)
- **Storage**: New dependency `expo-file-system` (~100KB)

## Future Enhancements

1. **Smart cache invalidation**: Clear old episode files after N days
2. **Partial uploads**: Resume interrupted uploads
3. **Compression**: Compress audio before upload (trade CPU for bandwidth)
4. **P2P sharing**: Share analyzed files between users (privacy considerations)
5. **Background download**: Pre-download next episode audio for instant playback

## Known Limitations

1. **First prepare is slower**: Must download before upload (but only once)
2. **Storage usage**: Local cache uses device storage
3. **Upload limits**: Large files (>100MB) may timeout on slow connections
4. **Web platform**: FormData handling differs (uses blob instead of URI)

## Security

- App Key authentication still required
- Uploaded files validated (extension, size limits)
- Temp files auto-deleted after processing
- No persistent storage of uploaded audio on server
- Client cache sandboxed in app directory
