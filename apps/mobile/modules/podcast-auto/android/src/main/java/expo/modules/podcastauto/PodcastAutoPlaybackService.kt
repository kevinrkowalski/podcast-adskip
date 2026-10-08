package expo.modules.podcastauto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes as Media3AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.core.content.ContextCompat
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSession.MediaItemsWithStartPosition
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject

@UnstableApi
class PodcastAutoPlaybackService : MediaLibraryService() {
  private val preferences by lazy {
    getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
  }
  private val handler = Handler(Looper.getMainLooper())
  private var player: ExoPlayer? = null
  private var mediaLibrarySession: MediaLibrarySession? = null
  private var activeEpisodeJson: String? = null
  private var lastPositionSaveMs = 0L

  private val catalogUpdateReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      notifyCatalogChanged()
    }
  }

  private val monitor = object : Runnable {
    override fun run() {
      val currentPlayer = player ?: return
      if (currentPlayer.isPlaying) {
        applyNativeAdSkip(currentPlayer)
        publishStatus()
        val now = System.currentTimeMillis()
        if (now - lastPositionSaveMs >= POSITION_SAVE_INTERVAL_MS) {
          persistPlaybackState(currentPlayer)
          lastPositionSaveMs = now
        }
      }
      handler.postDelayed(this, MONITOR_INTERVAL_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    val httpFactory = DefaultHttpDataSource.Factory()
      .setUserAgent("PodcastAdSkip/1.0 (Linux; Android) Media3")
    val dataSourceFactory = DefaultDataSource.Factory(this, httpFactory)
    val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
    val audioAttributes = Media3AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
      .build()
    val exoPlayer = ExoPlayer.Builder(this)
      .setMediaSourceFactory(mediaSourceFactory)
      .setAudioAttributes(audioAttributes, true)
      .build()
    player = exoPlayer
    exoPlayer.setPlaybackSpeed(preferences.getFloat(KEY_PLAYBACK_RATE, 1f))
    exoPlayer.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        persistPlaybackState(exoPlayer)
        publishStatus()
      }

      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        val transitionedGuid = mediaItem?.mediaId
        val activeGuid = try {
          activeEpisodeJson?.let { JSONObject(it).optString("guid") }
        } catch (_: Exception) {
          null
        }
        if (transitionedGuid != null && transitionedGuid != activeGuid) {
          activeEpisodeJson = findEpisodeJson(transitionedGuid) ?: activeEpisodeJson
        }
        if (activeEpisodeJson != null) {
          preferences.edit().putString(KEY_CURRENT_EPISODE, activeEpisodeJson).apply()
        }
        publishStatus()
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        publishStatus()
      }

      override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
        publishStatus(error.message)
      }
    })

    mediaLibrarySession = MediaLibrarySession.Builder(this, exoPlayer, LibraryCallback())
      .setId(SESSION_ID)
      .build()
    restorePreviousItem(exoPlayer)
    ContextCompat.registerReceiver(
      this,
      catalogUpdateReceiver,
      IntentFilter(ACTION_CATALOG_UPDATED),
      ContextCompat.RECEIVER_NOT_EXPORTED
    )
    handler.post(monitor)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
    mediaLibrarySession

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_LOAD -> loadAndPlay(intent)
      ACTION_PLAY -> player?.play()
      ACTION_PAUSE -> player?.pause()
      ACTION_SEEK -> {
        val position = intent.getLongExtra(EXTRA_POSITION_MS, 0L).coerceAtLeast(0L)
        player?.seekTo(position)
        preferences.edit().putLong(KEY_POSITION_MS, position).apply()
        publishStatus()
      }
      ACTION_RATE -> {
        val rate = intent.getFloatExtra(EXTRA_PLAYBACK_RATE, 1f).coerceIn(0.5f, 3f)
        player?.setPlaybackSpeed(rate)
        preferences.edit().putFloat(KEY_PLAYBACK_RATE, rate).apply()
        publishStatus()
      }
    }
    return super.onStartCommand(intent, flags, startId)
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Keep the MediaLibraryService alive while playback is active; release it when paused.
    if (player?.isPlaying != true) stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    handler.removeCallbacks(monitor)
    try {
      unregisterReceiver(catalogUpdateReceiver)
    } catch (_: IllegalArgumentException) {
      // The service can be destroyed before a receiver is registered.
    }
    player?.let(::persistPlaybackState)
    mediaLibrarySession?.release()
    player?.release()
    mediaLibrarySession = null
    player = null
    super.onDestroy()
  }

  private fun loadAndPlay(intent: Intent) {
    val serialized = intent.getStringExtra(EXTRA_EPISODE_JSON) ?: return
    val episode = try {
      JSONObject(serialized)
    } catch (_: Exception) {
      return
    }
    val guid = episode.optString("guid")
    val localPath = episode.optString("localFilePath")
    val audioUrl = if (localPath.isNotBlank() && localPath != "null") localPath else episode.optString("enclosureUrl")
    if (audioUrl.isBlank() || audioUrl == "null") return

    val playableUri = if (audioUrl.startsWith("/") && !audioUrl.startsWith("//")) {
      Uri.fromFile(java.io.File(audioUrl))
    } else {
      Uri.parse(audioUrl)
    }
    val item = createEpisodeItem(episode, playableUri)
    activeEpisodeJson = episode.toString()
    val startPosition = intent.getLongExtra(EXTRA_POSITION_MS, 0L).coerceAtLeast(0L)
    preferences.edit()
      .putString(KEY_CURRENT_EPISODE, activeEpisodeJson)
      .putLong(KEY_POSITION_MS, startPosition)
      .putBoolean(KEY_IS_PLAYING, true)
      .apply()
    player?.apply {
      val queue = guid.takeIf { it.isNotBlank() }?.let(::queueForEpisode)
      if (queue != null) {
        val (items, selectedIndex) = queue
        val playbackItems = items.toMutableList()
        playbackItems[selectedIndex] = item
        setMediaItems(playbackItems, selectedIndex, startPosition)
      } else {
        setMediaItem(item)
        seekTo(startPosition)
      }
      prepare()
      play()
    }
    publishStatus()
  }

  private fun restorePreviousItem(exoPlayer: ExoPlayer) {
    val serialized = preferences.getString(KEY_CURRENT_EPISODE, null) ?: return
    val episode = try {
      JSONObject(serialized)
    } catch (_: Exception) {
      return
    }
    val localPath = episode.optString("localFilePath")
    val audioUrl = if (localPath.isNotBlank() && localPath != "null") localPath else episode.optString("enclosureUrl")
    if (audioUrl.isBlank() || audioUrl == "null") return
    val uri = if (audioUrl.startsWith("/") && !audioUrl.startsWith("//")) Uri.fromFile(java.io.File(audioUrl)) else Uri.parse(audioUrl)
    activeEpisodeJson = serialized
    val item = createEpisodeItem(episode, uri)
    val queue = episode.optString("guid").takeIf { it.isNotBlank() }?.let(::queueForEpisode)
    if (queue != null) {
      val (items, selectedIndex) = queue
      val restoredItems = items.toMutableList()
      restoredItems[selectedIndex] = item
      exoPlayer.setMediaItems(restoredItems, selectedIndex, preferences.getLong(KEY_POSITION_MS, 0L).coerceAtLeast(0L))
    } else {
      exoPlayer.setMediaItem(item)
      exoPlayer.seekTo(preferences.getLong(KEY_POSITION_MS, 0L).coerceAtLeast(0L))
    }
    exoPlayer.prepare()
  }

  private fun createEpisodeItem(episode: JSONObject, uri: Uri): MediaItem {
    val title = episode.optString("title", "Podcast episode")
    val podcastTitle = episode.optString("podcastTitle", "Podcast")
    val artwork = episode.optString("artworkUrl")
    val metadata = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(podcastTitle)
      .setAlbumTitle(podcastTitle)
      .apply {
        if (artwork.isNotBlank() && artwork != "null") setArtworkUri(Uri.parse(artwork))
      }
      .setIsBrowsable(false)
      .setIsPlayable(true)
      .build()
    return MediaItem.Builder()
      .setMediaId(episode.optString("guid", uri.toString()))
      .setUri(uri)
      .setMediaMetadata(metadata)
      .build()
  }

  private fun applyNativeAdSkip(exoPlayer: ExoPlayer) {
    if (!preferences.getBoolean(KEY_AUTO_SKIP, true) ||
      !preferences.getBoolean(KEY_AD_DETECTION_ENABLED, true)) return
    val position = exoPlayer.currentPosition
    val episodeGuid = exoPlayer.currentMediaItem?.mediaId ?: return
    val segments = try {
      JSONArray(preferences.getString(KEY_SKIP_SEGMENTS_PREFIX + episodeGuid, "[]"))
    } catch (_: Exception) {
      return
    }
    for (index in 0 until segments.length()) {
      val segment = segments.optJSONObject(index) ?: continue
      val start = segment.optLong("start_ms", -1L)
      val end = segment.optLong("end_ms", -1L)
      if (start >= 0L && end > start && position >= start && position < end) {
        exoPlayer.seekTo(end + AUTO_SKIP_OFFSET_MS)
        preferences.edit().putLong(KEY_POSITION_MS, end + AUTO_SKIP_OFFSET_MS).apply()
        break
      }
    }
  }

  private fun persistPlaybackState(exoPlayer: ExoPlayer) {
    val currentItem = exoPlayer.currentMediaItem
    if (currentItem != null) {
      activeEpisodeJson = activeEpisodeJson ?: findEpisodeJson(currentItem.mediaId)
      if (activeEpisodeJson != null) {
        preferences.edit()
          .putString(KEY_CURRENT_EPISODE, activeEpisodeJson)
          .putLong(KEY_POSITION_MS, exoPlayer.currentPosition.coerceAtLeast(0L))
          .putLong(KEY_DURATION_MS, exoPlayer.duration.takeIf { it > 0L } ?: 0L)
          .putBoolean(KEY_IS_PLAYING, exoPlayer.isPlaying)
          .putFloat(KEY_PLAYBACK_RATE, exoPlayer.playbackParameters.speed)
          .apply()
      }
    } else {
      preferences.edit().putBoolean(KEY_IS_PLAYING, exoPlayer.isPlaying).apply()
    }
  }

  private fun notifyCatalogChanged() {
    val session = mediaLibrarySession ?: return
    val podcasts = readPodcasts()
    session.notifyChildrenChanged(ROOT_ID, podcasts.length(), null)
    for (index in 0 until podcasts.length()) {
      val podcast = podcasts.optJSONObject(index) ?: continue
      val collectionId = podcast.optLong("collectionId").toString()
      val episodeCount = podcast.optJSONArray("episodes")?.length() ?: 0
      session.notifyChildrenChanged(PODCAST_PREFIX + collectionId, episodeCount, null)
    }
  }

  private fun publishStatus(error: String? = null) {
    val exoPlayer = player ?: return
    val item = exoPlayer.currentMediaItem
    val episodeJson = activeEpisodeJson ?: item?.mediaId?.let(::findEpisodeJson)
    val intent = Intent(ACTION_STATUS).setPackage(packageName)
      .putExtra(EXTRA_EPISODE_JSON, episodeJson)
      .putExtra(EXTRA_POSITION_MS, exoPlayer.currentPosition.coerceAtLeast(0L))
      .putExtra(EXTRA_DURATION_MS, exoPlayer.duration.takeIf { it > 0L } ?: 0L)
      .putExtra(EXTRA_IS_PLAYING, exoPlayer.isPlaying)
      .putExtra(EXTRA_PLAYBACK_RATE, exoPlayer.playbackParameters.speed)
    if (error != null) intent.putExtra(EXTRA_ERROR, error)
    sendBroadcast(intent)
  }

  private fun findEpisodeJson(guid: String): String? {
    val podcasts = try {
      JSONObject(preferences.getString(KEY_CATALOG, "{}") ?: "{}").optJSONArray("podcasts")
    } catch (_: Exception) {
      null
    } ?: return null
    for (podcastIndex in 0 until podcasts.length()) {
      val podcast = podcasts.optJSONObject(podcastIndex) ?: continue
      val episodes = podcast.optJSONArray("episodes") ?: continue
      for (episodeIndex in 0 until episodes.length()) {
        val episode = episodes.optJSONObject(episodeIndex) ?: continue
        if (episode.optString("guid") == guid) {
          if (!episode.has("podcastTitle")) episode.put("podcastTitle", podcast.optString("title", "Podcast"))
          if (!episode.has("artworkUrl")) episode.put("artworkUrl", podcast.optString("artworkUrl"))
          if (!episode.has("collectionId")) episode.put("collectionId", podcast.optLong("collectionId"))
          return episode.toString()
        }
      }
    }
    return null
  }

  private inner class LibraryCallback : MediaLibrarySession.Callback {
    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: List<MediaItem>,
      startIndex: Int,
      startPositionMs: Long
    ): ListenableFuture<MediaItemsWithStartPosition> {
      val requested = mediaItems.getOrNull(startIndex.takeIf { it >= 0 } ?: 0)
      val queue = requested?.mediaId?.let(::queueForEpisode)
      if (queue != null) {
        val (items, selectedIndex) = queue
        return Futures.immediateFuture(
          MediaItemsWithStartPosition(ImmutableList.copyOf(items), selectedIndex, startPositionMs)
        )
      }

      val resolvedItems = mediaItems.mapNotNull { requestedItem ->
        if (requestedItem.localConfiguration != null) requestedItem
        else episodeItemsForAllPodcasts().firstOrNull { it.mediaId == requestedItem.mediaId }
      }
      val resolvedStartIndex = when {
        resolvedItems.isEmpty() -> C.INDEX_UNSET
        startIndex in resolvedItems.indices -> startIndex
        else -> 0
      }
      return Futures.immediateFuture(
        MediaItemsWithStartPosition(ImmutableList.copyOf(resolvedItems), resolvedStartIndex, startPositionMs)
      )
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val root = MediaItem.Builder()
        .setMediaId(ROOT_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Podcast AdSkip")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .build()
        )
        .build()
      return Futures.immediateFuture(LibraryResult.ofItem(root, params))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val items = when {
        parentId == ROOT_ID -> podcastItems()
        parentId.startsWith(PODCAST_PREFIX) -> episodeItems(parentId.removePrefix(PODCAST_PREFIX))
        else -> emptyList()
      }
      val from = (page.coerceAtLeast(0) * pageSize.coerceAtLeast(1)).coerceAtMost(items.size)
      val to = (from + pageSize.coerceAtLeast(1)).coerceAtMost(items.size)
      val pageItems = ImmutableList.copyOf(items.subList(from, to))
      return Futures.immediateFuture(LibraryResult.ofItemList(pageItems, params))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val item = if (mediaId.startsWith(PODCAST_PREFIX)) {
        podcastItems().firstOrNull { it.mediaId == mediaId }
      } else {
        episodeItemsForAllPodcasts().firstOrNull { it.mediaId == mediaId }
      }
      return if (item == null) {
        Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
      } else {
        Futures.immediateFuture(LibraryResult.ofItem(item, null))
      }
    }
  }

  private fun podcastItems(): List<MediaItem> {
    val podcasts = readPodcasts()
    return (0 until podcasts.length()).mapNotNull { index ->
      val podcast = podcasts.optJSONObject(index) ?: return@mapNotNull null
      val id = podcast.optLong("collectionId").toString()
      val metadata = MediaMetadata.Builder()
        .setTitle(podcast.optString("title", "Untitled podcast"))
        .setArtist(podcast.optString("artist"))
        .setAlbumTitle(podcast.optString("title"))
        .setIsBrowsable(true)
        .setIsPlayable(false)
        .apply {
          val artwork = podcast.optString("artworkUrl")
          if (artwork.isNotBlank() && artwork != "null") setArtworkUri(Uri.parse(artwork))
        }
        .build()
      MediaItem.Builder()
        .setMediaId(PODCAST_PREFIX + id)
        .setMediaMetadata(metadata)
        .build()
    }
  }

  private fun episodeItems(collectionId: String): List<MediaItem> {
    val podcast = findPodcast(collectionId) ?: return emptyList()
    val episodes = podcast.optJSONArray("episodes") ?: return emptyList()
    return (0 until episodes.length()).mapNotNull { index ->
      val episode = episodes.optJSONObject(index) ?: return@mapNotNull null
      val url = episode.optString("enclosureUrl")
      if (url.isBlank() || url == "null") return@mapNotNull null
      val enriched = JSONObject(episode.toString())
      if (!enriched.has("podcastTitle")) enriched.put("podcastTitle", podcast.optString("title", "Podcast"))
      if (!enriched.has("artworkUrl")) enriched.put("artworkUrl", podcast.optString("artworkUrl"))
      if (!enriched.has("collectionId")) enriched.put("collectionId", podcast.optLong("collectionId"))
      createEpisodeItem(enriched, Uri.parse(url))
    }
  }

  private fun episodeItemsForAllPodcasts(): List<MediaItem> {
    val podcasts = readPodcasts()
    return (0 until podcasts.length()).flatMap { index ->
      val id = podcasts.optJSONObject(index)?.optLong("collectionId")?.toString() ?: return@flatMap emptyList()
      episodeItems(id)
    }
  }

  private fun queueForEpisode(guid: String): Pair<List<MediaItem>, Int>? {
    val podcasts = readPodcasts()
    for (podcastIndex in 0 until podcasts.length()) {
      val podcast = podcasts.optJSONObject(podcastIndex) ?: continue
      val episodes = podcast.optJSONArray("episodes") ?: continue
      val isInPodcast = (0 until episodes.length()).any { index ->
        episodes.optJSONObject(index)?.optString("guid") == guid
      }
      if (!isInPodcast) continue
      val items = episodeItems(podcast.optLong("collectionId").toString())
      val selectedIndex = items.indexOfFirst { it.mediaId == guid }
      if (selectedIndex >= 0) return items to selectedIndex
    }
    return null
  }

  private fun findPodcast(collectionId: String): JSONObject? {
    val podcasts = readPodcasts()
    for (index in 0 until podcasts.length()) {
      val podcast = podcasts.optJSONObject(index) ?: continue
      if (podcast.optLong("collectionId").toString() == collectionId) return podcast
    }
    return null
  }

  private fun readPodcasts(): JSONArray = try {
    JSONObject(preferences.getString(KEY_CATALOG, "{}") ?: "{}").optJSONArray("podcasts") ?: JSONArray()
  } catch (_: Exception) {
    JSONArray()
  }

  companion object {
    const val PREFERENCES_NAME = "podcast_adskip_android_auto"
    const val ACTION_STATUS = "expo.modules.podcastauto.PLAYBACK_STATUS"
    const val ACTION_CATALOG_UPDATED = "expo.modules.podcastauto.CATALOG_UPDATED"
    const val ACTION_LOAD = "expo.modules.podcastauto.LOAD"
    const val ACTION_PLAY = "expo.modules.podcastauto.PLAY"
    const val ACTION_PAUSE = "expo.modules.podcastauto.PAUSE"
    const val ACTION_SEEK = "expo.modules.podcastauto.SEEK"
    const val ACTION_RATE = "expo.modules.podcastauto.RATE"

    const val EXTRA_EPISODE_JSON = "episodeJson"
    const val EXTRA_POSITION_MS = "positionMs"
    const val EXTRA_DURATION_MS = "durationMs"
    const val EXTRA_IS_PLAYING = "isPlaying"
    const val EXTRA_PLAYBACK_RATE = "playbackRate"
    const val EXTRA_ERROR = "error"

    const val KEY_CATALOG = "catalog"
    const val KEY_CURRENT_EPISODE = "currentEpisode"
    const val KEY_POSITION_MS = "positionMs"
    const val KEY_DURATION_MS = "durationMs"
    const val KEY_IS_PLAYING = "isPlaying"
    const val KEY_PLAYBACK_RATE = "playbackRate"
    const val KEY_AUTO_SKIP = "autoSkip"
    const val KEY_AD_DETECTION_ENABLED = "adDetectionEnabled"
    const val KEY_SKIP_SEGMENTS_PREFIX = "skipSegments:"

    private const val ROOT_ID = "podcast-adskip-root"
    private const val PODCAST_PREFIX = "podcast:"
    private const val SESSION_ID = "podcast-adskip"
    private const val MONITOR_INTERVAL_MS = 500L
    private const val POSITION_SAVE_INTERVAL_MS = 5_000L
    private const val AUTO_SKIP_OFFSET_MS = 100L
  }
}
