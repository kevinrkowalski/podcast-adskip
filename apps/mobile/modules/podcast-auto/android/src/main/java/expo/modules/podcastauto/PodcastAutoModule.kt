package expo.modules.podcastauto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray

private const val KEY_SKIP_SEGMENTS_INDEX = "skipSegmentsIndex"
private const val MAX_STORED_SEGMENT_EPISODES = 100

class PodcastAutoModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private val preferences by lazy {
    context.getSharedPreferences(PodcastAutoPlaybackService.PREFERENCES_NAME, Context.MODE_PRIVATE)
  }

  /** Separate file: the catalog is large and the main prefs are rewritten every few seconds. */
  private val catalogPreferences by lazy {
    context.getSharedPreferences(PodcastAutoPlaybackService.CATALOG_PREFERENCES_NAME, Context.MODE_PRIVATE)
  }

  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      sendEvent(
        "onPlaybackStatus",
        bundleOf(
          "episodeJson" to intent.getStringExtra(PodcastAutoPlaybackService.EXTRA_EPISODE_JSON),
          "positionMs" to intent.getLongExtra(PodcastAutoPlaybackService.EXTRA_POSITION_MS, 0L),
          "durationMs" to intent.getLongExtra(PodcastAutoPlaybackService.EXTRA_DURATION_MS, 0L),
          "isPlaying" to intent.getBooleanExtra(PodcastAutoPlaybackService.EXTRA_IS_PLAYING, false),
          "isBuffering" to intent.getBooleanExtra(PodcastAutoPlaybackService.EXTRA_IS_BUFFERING, false),
          "ended" to intent.getBooleanExtra(PodcastAutoPlaybackService.EXTRA_ENDED, false),
          "error" to intent.getStringExtra(PodcastAutoPlaybackService.EXTRA_ERROR),
          "playbackRate" to intent.getFloatExtra(PodcastAutoPlaybackService.EXTRA_PLAYBACK_RATE, 1f).toDouble(),
          "streamCache" to intent.getStringExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_STATE)?.let { state ->
            bundleOf(
              "state" to state,
              "guid" to intent.getStringExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_GUID),
              "bytes" to intent.getLongExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_BYTES, 0L).toDouble(),
              "total" to intent.getLongExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_TOTAL, 0L).toDouble(),
              "md5" to intent.getStringExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_MD5),
              "error" to intent.getStringExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_ERROR),
              "verified" to intent.getBooleanExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_VERIFIED, false)
            )
          }
        )
      )
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PodcastAuto")
    Events("onPlaybackStatus")

    OnCreate {
      ContextCompat.registerReceiver(
        context,
        statusReceiver,
        IntentFilter(PodcastAutoPlaybackService.ACTION_STATUS),
        ContextCompat.RECEIVER_NOT_EXPORTED
      )
    }

    OnDestroy {
      try {
        context.unregisterReceiver(statusReceiver)
      } catch (_: IllegalArgumentException) {
        // The module may be destroyed before the receiver is registered.
      }
    }

    Function("setCatalog") { catalogJson: String ->
      catalogPreferences.edit().putString(PodcastAutoPlaybackService.KEY_CATALOG, catalogJson).apply()
      // Drop the copy older builds kept in the main prefs file.
      if (preferences.contains(PodcastAutoPlaybackService.KEY_CATALOG)) {
        preferences.edit().remove(PodcastAutoPlaybackService.KEY_CATALOG).apply()
      }
      context.sendBroadcast(
        Intent(PodcastAutoPlaybackService.ACTION_CATALOG_UPDATED).setPackage(context.packageName)
      )
    }

    Function("loadAndPlay") { episodeJson: String, localFilePath: String?, startPositionMs: Double,
      streamCachePath: String?, streamUrl: String? ->
      val episode = org.json.JSONObject(episodeJson)
      if (!localFilePath.isNullOrBlank()) episode.put("localFilePath", localFilePath)
      preferences.edit()
        .putString(PodcastAutoPlaybackService.KEY_CURRENT_EPISODE, episode.toString())
        .putLong(PodcastAutoPlaybackService.KEY_POSITION_MS, startPositionMs.toLong().coerceAtLeast(0L))
        .putBoolean(PodcastAutoPlaybackService.KEY_IS_PLAYING, true)
        .apply()
      startCommand(PodcastAutoPlaybackService.ACTION_LOAD).apply {
        putExtra(PodcastAutoPlaybackService.EXTRA_EPISODE_JSON, episode.toString())
        putExtra(PodcastAutoPlaybackService.EXTRA_POSITION_MS, startPositionMs.toLong().coerceAtLeast(0L))
        if (localFilePath.isNullOrBlank() && !streamCachePath.isNullOrBlank()) {
          putExtra(PodcastAutoPlaybackService.EXTRA_STREAM_CACHE_PATH, streamCachePath)
        }
        if (!streamUrl.isNullOrBlank()) putExtra(PodcastAutoPlaybackService.EXTRA_STREAM_URL, streamUrl)
      }.also(::startService)
    }

    Function("play") {
      if (hasCurrentEpisode()) startService(startCommand(PodcastAutoPlaybackService.ACTION_PLAY))
    }
    Function("pause") {
      if (hasCurrentEpisode()) startService(startCommand(PodcastAutoPlaybackService.ACTION_PAUSE))
    }
    Function("stop") {
      if (hasCurrentEpisode()) startService(startCommand(PodcastAutoPlaybackService.ACTION_STOP))
    }
    Function("seekTo") { positionMs: Double ->
      if (hasCurrentEpisode()) {
        startCommand(PodcastAutoPlaybackService.ACTION_SEEK).apply {
          putExtra(PodcastAutoPlaybackService.EXTRA_POSITION_MS, positionMs.toLong().coerceAtLeast(0L))
        }.also(::startService)
      }
    }
    Function("setPlaybackRate") { rate: Double ->
      if (hasCurrentEpisode()) {
        startCommand(PodcastAutoPlaybackService.ACTION_RATE).apply {
          putExtra(PodcastAutoPlaybackService.EXTRA_PLAYBACK_RATE, rate.toFloat())
        }.also(::startService)
      } else {
        preferences.edit().putFloat(PodcastAutoPlaybackService.KEY_PLAYBACK_RATE, rate.toFloat()).apply()
      }
    }
    Function("setAutoSkip") { enabled: Boolean ->
      preferences.edit().putBoolean(PodcastAutoPlaybackService.KEY_AUTO_SKIP, enabled).apply()
    }
    Function("setAdDetectionEnabled") { enabled: Boolean ->
      preferences.edit().putBoolean(PodcastAutoPlaybackService.KEY_AD_DETECTION_ENABLED, enabled).apply()
    }
    Function("setSkipSegments") { segmentsJson: String, episodeGuid: String? ->
      val safeJson = try {
        JSONArray(segmentsJson).toString()
      } catch (_: Exception) {
        "[]"
      }
      if (!episodeGuid.isNullOrBlank()) storeSkipSegments(episodeGuid, safeJson)
    }
    Function("getEventLog") { PlaybackEventLog.read(context) }
    Function("clearEventLog") { PlaybackEventLog.clear(context) }
    Function("logEvent") { message: String -> PlaybackEventLog.log(context, "js: $message") }
    Function("isIgnoringBatteryOptimizations") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(context.packageName)
    }
    Function("requestIgnoreBatteryOptimizations") {
      val pkg = Uri.parse("package:${context.packageName}")
      val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(direct)
      } catch (_: Exception) {
        context.startActivity(
          Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
      }
    }
    Function("openAppDetailsSettings") {
      // OxygenOS keeps its own "Battery usage: Unrestricted / Allow background activity"
      // switch on the App info page, separate from the Android battery-optimization list.
      context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }
    Function("getStatus") {
      mapOf(
        "episodeJson" to preferences.getString(PodcastAutoPlaybackService.KEY_CURRENT_EPISODE, null),
        "positionMs" to preferences.getLong(PodcastAutoPlaybackService.KEY_POSITION_MS, 0L),
        "durationMs" to preferences.getLong(PodcastAutoPlaybackService.KEY_DURATION_MS, 0L),
        "isPlaying" to preferences.getBoolean(PodcastAutoPlaybackService.KEY_IS_PLAYING, false),
        "playbackRate" to preferences.getFloat(PodcastAutoPlaybackService.KEY_PLAYBACK_RATE, 1f).toDouble()
      )
    }
  }

  private fun startCommand(action: String): Intent =
    Intent(action)
      .setPackage(context.packageName)
      .setClass(context, PodcastAutoPlaybackService::class.java)

  /**
   * One key per episode would grow forever (and SharedPreferences rewrites the whole file
   * on every save), so keep segments for the most recently set episodes only.
   */
  private fun storeSkipSegments(episodeGuid: String, segmentsJson: String) {
    val key = PodcastAutoPlaybackService.KEY_SKIP_SEGMENTS_PREFIX + episodeGuid
    val index = try {
      JSONArray(preferences.getString(KEY_SKIP_SEGMENTS_INDEX, "[]"))
    } catch (_: Exception) {
      JSONArray()
    }
    val guids = (0 until index.length()).map { index.optString(it) }.filter { it.isNotBlank() && it != episodeGuid }.toMutableList()
    val edit = preferences.edit()
    if (segmentsJson == "[]") {
      edit.remove(key)
    } else {
      edit.putString(key, segmentsJson)
      guids.add(0, episodeGuid)
    }
    while (guids.size > MAX_STORED_SEGMENT_EPISODES) {
      edit.remove(PodcastAutoPlaybackService.KEY_SKIP_SEGMENTS_PREFIX + guids.removeAt(guids.size - 1))
    }
    // One-time cleanup of keys written before the index existed.
    if (!preferences.contains(KEY_SKIP_SEGMENTS_INDEX)) {
      val keep = guids.map { PodcastAutoPlaybackService.KEY_SKIP_SEGMENTS_PREFIX + it }.toSet() + key
      preferences.all.keys
        .filter { it.startsWith(PodcastAutoPlaybackService.KEY_SKIP_SEGMENTS_PREFIX) && it !in keep }
        .forEach { edit.remove(it) }
    }
    edit.putString(KEY_SKIP_SEGMENTS_INDEX, JSONArray(guids).toString()).apply()
  }

  private fun hasCurrentEpisode(): Boolean =
    !preferences.getString(PodcastAutoPlaybackService.KEY_CURRENT_EPISODE, null).isNullOrBlank()

  private fun startService(intent: Intent) {
    // MediaLibraryService manages its own media-playback foreground state once audio starts.
    // Starting every control intent as a foreground service can crash on no-op/paused commands.
    context.startService(intent)
  }
}
