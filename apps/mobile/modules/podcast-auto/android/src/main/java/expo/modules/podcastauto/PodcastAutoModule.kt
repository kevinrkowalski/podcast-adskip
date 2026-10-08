package expo.modules.podcastauto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray

class PodcastAutoModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private val preferences by lazy {
    context.getSharedPreferences(PodcastAutoPlaybackService.PREFERENCES_NAME, Context.MODE_PRIVATE)
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
          "playbackRate" to intent.getFloatExtra(PodcastAutoPlaybackService.EXTRA_PLAYBACK_RATE, 1f).toDouble()
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
      preferences.edit().putString(PodcastAutoPlaybackService.KEY_CATALOG, catalogJson).apply()
      context.sendBroadcast(
        Intent(PodcastAutoPlaybackService.ACTION_CATALOG_UPDATED).setPackage(context.packageName)
      )
    }

    Function("loadAndPlay") { episodeJson: String, localFilePath: String?, startPositionMs: Double ->
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
      }.also(::startService)
    }

    Function("play") {
      if (hasCurrentEpisode()) startService(startCommand(PodcastAutoPlaybackService.ACTION_PLAY))
    }
    Function("pause") {
      if (hasCurrentEpisode()) startService(startCommand(PodcastAutoPlaybackService.ACTION_PAUSE))
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
      if (!episodeGuid.isNullOrBlank()) {
        preferences.edit()
          .putString(PodcastAutoPlaybackService.KEY_SKIP_SEGMENTS_PREFIX + episodeGuid, safeJson)
          .apply()
      }
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

  private fun hasCurrentEpisode(): Boolean =
    !preferences.getString(PodcastAutoPlaybackService.KEY_CURRENT_EPISODE, null).isNullOrBlank()

  private fun startService(intent: Intent) {
    // MediaLibraryService manages its own media-playback foreground state once audio starts.
    // Starting every control intent as a foreground service can crash on no-op/paused commands.
    context.startService(intent)
  }
}
