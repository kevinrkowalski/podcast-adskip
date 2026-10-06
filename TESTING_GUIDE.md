# Testing Guide: Client-Side Audio Upload

## Prerequisites

### 1. Install Dependencies
```bash
cd apps/mobile
npm install
```

### 2. Build Development Client
Since we added `expo-file-system`, you need a custom development build:

```bash
# Generate native projects
npx expo prebuild

# Build and install on Android device
npx expo run:android

# OR use EAS Build for a development APK
npx eas-cli build -p android --profile development
```

### 3. API Setup
```bash
cd services/api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure .env with your OpenRouter API key
cp .env.example .env
# Edit .env and add: OPENROUTER_API_KEY=sk-or-...

# Start API
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 4. Mobile Configuration
```bash
cd apps/mobile
cp .env.example .env
```

Edit `.env` and set:
```
# For Android emulator:
EXPO_PUBLIC_API_URL=http://10.0.2.2:8000

# For physical device, use your computer's LAN IP:
EXPO_PUBLIC_API_URL=http://192.168.1.XXX:8000
```

## Test Procedure

### Test 1: Basic Upload Flow

1. **Start the app** on your device/emulator:
   ```bash
   cd apps/mobile
   npx expo start --dev-client
   ```

2. **Search for a podcast**:
   - Go to Search tab
   - Search for "NPR" or "Gimlet" (known for dynamic ads)
   - Subscribe to a show

3. **Open an episode**:
   - Go to Library → tap your subscribed show
   - Tap on any episode to start playing

4. **Test Prepare with upload**:
   - Tap the **"Prepare"** button (sparkles icon in action strip)
   - **Observe progress indicators**:
     ```
     Stage 1: "Downloading audio" (progress 0-50%)
     Stage 2: "Uploading for analysis" (progress 50-100%)
     Stage 3: "Transcribing" (shows ETA)
     Stage 4: "Labeling"
     Stage 5: "Ready" with segment count
     ```

5. **Verify segments appear**:
   - Tap "Ad-skip" in action strip
   - Bottom sheet should show detected segments
   - Note the timestamps (e.g., "0:00-0:15", "10:00-11:00")

### Test 2: Audio Accuracy (The Critical Test)

This verifies that analyzed audio matches played audio.

1. **Turn Ad-skip OFF**:
   - In the segments sheet, toggle "Auto-skip" to OFF
   - Close the sheet

2. **Scrub to a segment timestamp**:
   - Look at the first segment time (e.g., 0:00-0:15)
   - Drag the scrubber to that position
   - **Press play**

3. **Verify you hear the ad**:
   - You should hear an actual advertisement
   - It should be a sponsor read, promo, or ad
   - **NOT** regular podcast content

4. **Compare with another app**:
   - Open the same episode in:
     - Pocket Casts
     - Overcast
     - Apple Podcasts
     - Or any other podcast app
   - Scrub to the same timestamp
   - Verify you hear the SAME content

5. **Expected result**:
   - ✅ This app plays ad at marked timestamp
   - ✅ Other app plays SAME ad at same timestamp
   - ✅ Timestamps are accurate
   - ✅ No mismatch warning appears

### Test 3: Auto-Skip Functionality

1. **Turn Ad-skip ON**:
   - Open segments sheet
   - Toggle "Auto-skip" to ON
   - Close sheet

2. **Play from beginning**:
   - Scrub to 0:00
   - Press play

3. **Verify automatic skipping**:
   - Player should **automatically seek past ad segments**
   - You should NOT hear the ads
   - You should hear content smoothly (skips over ads)
   - Scrubber should jump forward at ad times

4. **Check skip map label**:
   - Look at "Ad-skip" value in action strip
   - Should show segment count (e.g., "3 ads")

### Test 4: Cache Reuse

1. **Prepare the same episode again**:
   - Tap "Prepare" button again
   - Should return "ready" almost instantly (cached)
   - No download/upload progress (uses cached file)

2. **Close and reopen episode**:
   - Go back to library
   - Open the same episode again
   - Tap "Prepare"
   - Should still use cached file (faster)

### Test 5: Different Episodes

1. **Test with multiple episodes**:
   - Open different episode from same show
   - Tap "Prepare"
   - Observe full download → upload → analyze flow
   - Verify each episode has its own skip map

2. **Check cache directory** (optional, for debugging):
   - On Android: `/data/data/com.yourapp/cache/podcast-audio/`
   - Should contain `.mp3` files named by episode GUID

### Test 6: Large Files

1. **Find a long episode** (60+ minutes, >50MB):
   - Search for interview podcasts (often longer)
   - Subscribe and open episode

2. **Test upload**:
   - Tap "Prepare"
   - Verify progress shows realistic percentages
   - Upload may take longer (watch progress bar)
   - Should complete successfully

3. **Verify chunking** (API side):
   - Check API logs: `ffmpeg` should chunk large files
   - Transcription should succeed
   - Skip map should return with segments

### Test 7: Error Handling

1. **Test without internet**:
   - Turn off WiFi/data on device
   - Tap "Prepare"
   - Should show "error" status
   - Should NOT crash

2. **Test with invalid API URL**:
   - Go to Settings
   - Change API URL to something invalid
   - Tap "Prepare"
   - Should show "offline" or "error" status

3. **Restore and retry**:
   - Fix API URL
   - Tap "Prepare" with `force=true`
   - Should work normally

## What to Look For

### ✅ Success Indicators

1. **Progress is smooth**:
   - Download: 0% → 50%
   - Upload: 50% → 100%
   - No freezes or jumps

2. **Stages are clear**:
   - "Downloading audio"
   - "Uploading for analysis"
   - "Transcribing"
   - "Labeling"

3. **Audio matches skip map**:
   - Ad-skip OFF: You hear ads at marked times
   - Ad-skip ON: Ads are skipped automatically
   - Same content as other podcast apps

4. **No mismatch warnings**:
   - Yellow warning banner does NOT appear
   - (Or if it does, shows low-severity "stale" warning)

5. **Cache works**:
   - Second prepare is instant
   - No re-download needed

### ❌ Failure Indicators

1. **Ads still missing with toggle OFF**:
   - Marked timestamp plays regular content (not ad)
   - Different from other apps
   - → Investigate: Did upload actually work? Check API logs

2. **Progress stuck or frozen**:
   - Download or upload never completes
   - → Check network, API logs, file permissions

3. **Mismatch warnings appear**:
   - Yellow banner shows URL or duration mismatch
   - → Expected on first attempt if audio differs
   - → Should disappear after client-upload analyze

4. **Crashes or errors**:
   - App crashes during download/upload
   - → Check logs, file system permissions

## Debugging

### Check API Logs
```bash
cd services/api
tail -f uvicorn.log  # or wherever your logs go
```

Look for:
```
INFO: Received upload for <guid>: <bytes> bytes, starting analysis
INFO: Analyzing uploaded file for <guid> (<bytes> bytes)
INFO: Analyze ready (client upload) guid=<guid> segments=<N>
```

### Check Mobile Logs
Android:
```bash
npx react-native log-android
```

Look for:
```
[audio-download] Downloading audio for analysis: <url>
[audio-download] Downloaded to: <path>
[audio-upload] Uploading audio for analysis: <path>
[playback] Audio mismatch detected: <warning>  # Should NOT appear
```

### Check Network
Use Charles Proxy or similar to inspect:
1. Download request to CDN (should succeed)
2. Upload POST to `/v1/analyze-episode-upload` (multipart/form-data)
3. Polling GETs to `/v1/skip-map/{guid}`

### Check File System
On device with ADB:
```bash
adb shell
cd /data/data/com.yourapp/cache/podcast-audio/
ls -lh  # Should show .mp3 files
```

## Expected Outcomes

After completing all tests:

1. ✅ **Client-side upload works**: Audio is downloaded and uploaded successfully
2. ✅ **Progress tracking works**: UI shows accurate download and upload progress
3. ✅ **Skip maps are accurate**: Analyzed audio matches played audio
4. ✅ **Ads are audible**: With toggle OFF, ads play at marked timestamps
5. ✅ **Auto-skip works**: With toggle ON, ads are skipped automatically
6. ✅ **Cache is effective**: Second prepare uses cached file (faster)
7. ✅ **No mismatches**: Yellow warning banner does not appear (or shows low-severity only)

## Common Issues

### Issue: "Download failed"
- **Cause**: Network error, invalid URL, CORS
- **Fix**: Check API URL in settings, verify internet connection

### Issue: "Upload failed: 413"
- **Cause**: File too large
- **Fix**: API should chunk large files with ffmpeg. Check `MAX_AUDIO_MB` setting.

### Issue: Progress stuck at 50%
- **Cause**: Upload stalled
- **Fix**: Check API logs, network stability, restart API

### Issue: Still see mismatch warnings
- **Cause**: Using old cached skip map from URL-based analysis
- **Fix**: Force re-analyze: Long-press "Prepare" or clear app cache

### Issue: Ads still missing with toggle OFF
- **Cause**: Dynamic ad insertion happening DURING download
- **Fix**: Try different podcast or episode; some shows don't use dynamic ads

## Success Criteria Met

When all tests pass, you have verified:

✅ Skip maps are built from the EXACT audio file the player uses  
✅ No more mismatches from dynamic ad insertion  
✅ Ads audible at correct timestamps when Ad-skip OFF  
✅ Auto-skip seeks accurately when Ad-skip ON  
✅ Cache improves performance on subsequent prepares  
✅ Progress UI provides clear feedback during download/upload  
✅ Error handling is graceful  

**The bug is fixed!** 🎉