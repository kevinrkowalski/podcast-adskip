# Episode Tap Fix — Verification Guide

## Problem Fixed
After PR #2 (client upload) and PR #3 (non-blocking skip map), tapping an episode did nothing — no navigation, no playback — even with per-show ad detection OFF.

## Root Cause
Multiple unhandled error paths prevented playback:
1. `getCachedAudioPath` threw if `FileSystem.getInfoAsync` failed
2. `playEpisode` didn't catch these errors
3. Podcast detail screen awaited `playEpisode` before navigating
4. Result: errors blocked navigation silently

## Fix Applied (PR #4)
1. Added try-catch to `getCachedAudioPath` to handle FileSystem errors
2. Added error handling in `playEpisode` around cache check and player load
3. **Navigate FIRST**, then load episode in background
4. Log all errors to console instead of swallowing them

## Verification Steps

### Prerequisites
- Build and install the APK from this branch: `cursor/fix-playepisode-error-handling-6f0a`
- Have a podcast show subscribed
- Access to device logs (adb logcat or Metro bundler console)

### Test Case 1: Ad Detection OFF
1. Open any podcast show
2. Toggle "Ad detection for this show" to OFF
3. Tap any episode
4. **Expected:**
   - ✅ Player screen opens **immediately** (< 300ms)
   - ✅ Audio starts playing (or shows loading state)
   - ✅ No stuck state, no blank screen

### Test Case 2: Ad Detection ON
1. Open any podcast show
2. Toggle "Ad detection for this show" to ON
3. Ensure global "Ad detection & auto-skip" is ON in Settings
4. Tap any episode
5. **Expected:**
   - ✅ Player screen opens **immediately**
   - ✅ Audio starts playing
   - ✅ Skip map loads in background (check "Prepare" button state)

### Test Case 3: FileSystem Error Simulation
To simulate FileSystem errors, you can modify the code temporarily:

```typescript
// In audioUpload.ts, getCachedAudioPath
export async function getCachedAudioPath(...) {
  try {
    throw new Error('Simulated FileSystem error');  // ← Add this line
    const localPath = getCachePath(episodeGuid, audioUrl);
    // ...
```

1. Rebuild with the error injection above
2. Tap any episode
3. **Expected:**
   - ✅ Player screen opens
   - ✅ Console shows: `[audio-cache] Failed to check cached audio: Error: Simulated FileSystem error`
   - ✅ Audio streams from URL (falls back gracefully)
   - ✅ No crash, no stuck state

### Test Case 4: Player Load Error Simulation
```typescript
// In trackPlayer.ts, loadAndPlay
export async function loadAndPlay(...) {
  throw new Error('Simulated player error');  // ← Add this at the top
  // ...
```

1. Rebuild with the error injection above
2. Tap any episode
3. **Expected:**
   - ✅ Player screen opens
   - ✅ Console shows: `[playback] Failed to load and play episode: Error: Simulated player error`
   - ✅ No crash, no stuck state

### Test Case 5: Rapid Taps
1. Open a podcast show
2. Rapidly tap different episodes (5-10 taps in 2 seconds)
3. **Expected:**
   - ✅ Player screen opens on first tap
   - ✅ Episodes switch (last tap wins)
   - ✅ No crashes or hangs
   - ✅ Skip map loads for the final episode

## What to Look For in Logs

### Success Indicators
```
[playback] Using cached audio file for playback: file:///...  (if cached)
[player] Loading from cached file: file:///...  (if cached)
[player] Streaming from URL: https://...  (if not cached)
```

### Graceful Fallback
```
[audio-cache] Failed to check cached audio: <error>
[playback] Failed to check cached audio, will stream: <error>
```

### Hard Errors (should still navigate)
```
[playback] Failed to load and play episode: <error>
[podcast-detail] Failed to play episode: <error>
```

## Regression Checks

### Should Still Work
- ✅ Resume playback from saved position
- ✅ Skip map loading and auto-skip (when enabled)
- ✅ Prepare button in player (manual analyze)
- ✅ MiniPlayer controls
- ✅ Background playback
- ✅ Lock screen controls

### Known Pre-existing Issues (NOT fixed by this PR)
- TypeScript warning: `Property 'cacheDirectory' does not exist on expo-file-system` (needs Expo SDK update)
- Test files missing jest type definitions

## Success Criteria
✅ All test cases pass
✅ Navigation happens immediately on tap
✅ Errors are logged, not swallowed
✅ Graceful fallback to streaming when cache fails
✅ No stuck states or crashes

## Rollback Plan
If issues arise, revert to main branch which has PR #3:
```bash
git checkout main
git pull
```

Note: This will restore the blocking behavior, but skip map loading will still be non-blocking from PR #3.
