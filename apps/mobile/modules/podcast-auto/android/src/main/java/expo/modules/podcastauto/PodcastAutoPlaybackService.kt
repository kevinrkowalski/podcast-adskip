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
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
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
  private var errorRetryCount = 0
  private var firstErrorAt = 0L
  private var lastErrorMessage: String? = null

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
        val now = System.currentTimeMillis()
        if (now - lastPositionSaveMs >= POSITION_SAVE_INTERVAL_MS) {
          persistPlaybackState(currentPlayer)
          lastPositionSaveMs = now
        }
      }
      // Always publish, even when not playing: the JS UI treats this as a heartbeat and
      // reconciles its play/pause state from it, so a lost transition event can never
      // leave the UI showing "playing" while ExoPlayer is idle, ended, or errored.
      publishStatus()
      handler.postDelayed(this, MONITOR_INTERVAL_MS)
    }
  }

  private fun log(event: String) = PlaybackEventLog.log(this, event)

  override fun onCreate() {
    super.onCreate()
    log("service created")
    val httpFactory = DefaultHttpDataSource.Factory()
      .setUserAgent("PodcastAdSkip/1.0 (Linux; Android) Media3")
      // Podcast CDNs/trackers often redirect between http and https.
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(20_000)
      .setReadTimeoutMs(30_000)
    val dataSourceFactory = DefaultDataSource.Factory(this, httpFactory)
    val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
      // Retry individual chunk loads many times before surfacing a fatal error.
      .setLoadErrorHandlingPolicy(DefaultLoadErrorHandlingPolicy(LOAD_RETRY_COUNT))
    // Buffer several minutes ahead so short screen-off network naps don't starve playback.
    val loadControl = DefaultLoadControl.Builder()
      .setBufferDurationsMs(MIN_BUFFER_MS, MAX_BUFFER_MS, 2_500, 5_000)
      .build()
    val audioAttributes = Media3AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
      .build()
    val exoPlayer = ExoPlayer.Builder(this)
      .setMediaSourceFactory(mediaSourceFactory)
      .setLoadControl(loadControl)
      .setAudioAttributes(audioAttributes, true)
      // Hold wake + Wi-Fi locks while playing so streams don't stall when the screen is off.
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .setHandleAudioBecomingNoisy(true)
      .build()
    player = exoPlayer
    exoPlayer.setPlaybackSpeed(preferences.getFloat(KEY_PLAYBACK_RATE, 1f))
    exoPlayer.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        log("isPlaying=$isPlaying state=${stateName(exoPlayer.playbackState)} pos=${exoPlayer.currentPosition}")
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
        log("state=${stateName(playbackState)} playWhenReady=${exoPlayer.playWhenReady} pos=${exoPlayer.currentPosition}")
        if (playbackState == Player.STATE_READY) {
          if (errorRetryCount > 0) log("recovered after $errorRetryCount retries")
          errorRetryCount = 0
          firstErrorAt = 0L
          lastErrorMessage = null
        }
        persistPlaybackState(exoPlayer)
        publishStatus()
      }

      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        log("playWhenReady=$playWhenReady reason=${playWhenReadyReasonName(reason)}")
        persistPlaybackState(exoPlayer)
        publishStatus()
      }

      override fun onPlaybackSuppressionReasonChanged(reason: Int) {
        log("suppression=${suppressionName(reason)} (transient audio focus loss if TRANSIENT_AUDIO_FOCUS_LOSS)")
        publishStatus()
      }

      override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
        lastErrorMessage = error.message ?: error.errorCodeName
        log("ERROR ${error.errorCodeName} (${error.errorCode}): ${error.message} cause=${error.cause?.javaClass?.simpleName}")
        persistPlaybackState(exoPlayer)
        publishStatus(lastErrorMessage)
        scheduleErrorRecovery(exoPlayer, error)
      }
    })

    val session = MediaLibrarySession.Builder(this, exoPlayer, LibraryCallback())
      .setId(SESSION_ID)
      .build()
    mediaLibrarySession = session
    // The app drives this service with startService() intents, not a MediaController, so
    // onGetSession() is never called for in-app playback. Without addSession() Media3 never
    // manages this session: no media notification and no startForeground(), so the service
    // stays a background service and OxygenOS/doze freezes or kills it with the screen off.
    addSession(session)
    setListener(object : Listener {
      override fun onForegroundServiceStartNotAllowedException() {
        log("ERROR foreground service start not allowed (app in background)")
      }
    })
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
      ACTION_PLAY -> {
        log("command: play (from app)")
        player?.let(::resumePlayback)
      }
      ACTION_PAUSE -> {
        log("command: pause (from app)")
        player?.pause()
      }
      ACTION_SEEK -> {
        log("command: seek ${intent.getLongExtra(EXTRA_POSITION_MS, 0L)}")
        val position = intent.getLongExtra(EXTRA_POSITION_MS, 0L).coerceAtLeast(0L)
        player?.let { p -> p.seekTo(clampToDuration(p, position)) }
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
    // Keep the service alive while the user wants playback (including while buffering
    // through a stall); release it when paused.
    val wantsPlayback = player?.playWhenReady == true
    log("task removed (app swiped away); wantsPlayback=$wantsPlayback")
    if (!wantsPlayback) pauseAllPlayersAndStopSelf()
  }

  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    if (level >= TRIM_MEMORY_RUNNING_LOW) log("trimMemory level=$level")
  }

  override fun onDestroy() {
    log("service destroyed; playWhenReady=${player?.playWhenReady} state=${player?.playbackState?.let(::stateName)}")
    handler.removeCallbacks(monitor)
    try {
      unregisterReceiver(catalogUpdateReceiver)
    } catch (_: IllegalArgumentException) {
      // The service can be destroyed before a receiver is registered.
    }
    handler.removeCallbacksAndMessages(null)
    player?.let(::persistPlaybackState)
    // The service is going away; make sure the UI does not keep showing "playing".
    preferences.edit().putBoolean(KEY_IS_PLAYING, false).apply()
    player?.let { p ->
      p.pause()
      publishStatus()
    }
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
    log("load ${episode.optString("title").take(60)} local=${episode.optString("localFilePath").let { it.isNotBlank() && it != "null" }}")
    val localPath = episode.optString("localFilePath")
    val audioUrl = if (localPath.isNotBlank() && localPath != "null") localPath else episode.optString("enclosureUrl")
    if (audioUrl.isBlank() || audioUrl == "null") {
      preferences.edit().putBoolean(KEY_IS_PLAYING, false).apply()
      publishStatus("Episode has no playable audio URL")
      return
    }

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
    errorRetryCount = 0
    firstErrorAt = 0L
    lastErrorMessage = null
    handler.removeCallbacks(errorRecovery)
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
        val target = clampToDuration(exoPlayer, end + AUTO_SKIP_OFFSET_MS)
        log("auto-skip ad ${start}-${end} -> $target")
        exoPlayer.seekTo(target)
        preferences.edit().putLong(KEY_POSITION_MS, target).apply()
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
          .putBoolean(KEY_IS_PLAYING, isEffectivelyPlaying(exoPlayer))
          .putFloat(KEY_PLAYBACK_RATE, exoPlayer.playbackParameters.speed)
          .apply()
      }
    } else {
      preferences.edit().putBoolean(KEY_IS_PLAYING, isEffectivelyPlaying(exoPlayer)).apply()
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
      .putExtra(EXTRA_IS_PLAYING, isEffectivelyPlaying(exoPlayer))
      .putExtra(
        EXTRA_IS_BUFFERING,
        exoPlayer.playWhenReady && exoPlayer.playbackState == Player.STATE_BUFFERING
      )
      .putExtra(EXTRA_PLAYBACK_RATE, exoPlayer.playbackParameters.speed)
    val reportedError = error ?: lastErrorMessage?.takeIf { exoPlayer.playerError != null }
    if (reportedError != null) intent.putExtra(EXTRA_ERROR, reportedError)
    sendBroadcast(intent)
  }

  /**
   * "Playing" as the UI should show it: the user wants playback AND the player can actually
   * produce audio (or is briefly buffering towards it). Idle/errored, ended, and focus-loss
   * suppressed states all report false so the play button is accurate.
   */
  private fun isEffectivelyPlaying(exoPlayer: ExoPlayer): Boolean {
    if (exoPlayer.isPlaying) return true
    return exoPlayer.playWhenReady &&
      exoPlayer.playbackState == Player.STATE_BUFFERING &&
      exoPlayer.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE
  }

  private fun clampToDuration(exoPlayer: ExoPlayer, positionMs: Long): Long {
    val duration = exoPlayer.duration
    val safe = positionMs.coerceAtLeast(0L)
    return if (duration != C.TIME_UNSET && duration > 0L) safe.coerceAtMost(duration) else safe
  }

  /** Resume from any state: re-prepare after an error, restart after the end. */
  private fun resumePlayback(exoPlayer: ExoPlayer) {
    handler.removeCallbacks(errorRecovery)
    when (exoPlayer.playbackState) {
      Player.STATE_IDLE -> {
        if (exoPlayer.mediaItemCount == 0) restorePreviousItem(exoPlayer)
        else exoPlayer.prepare()
      }
      Player.STATE_ENDED -> exoPlayer.seekTo(0L)
    }
    exoPlayer.play()
    publishStatus()
  }

  private val errorRecovery = Runnable {
    val exoPlayer = player ?: return@Runnable
    if (exoPlayer.playbackState != Player.STATE_IDLE || exoPlayer.playerError == null) return@Runnable
    if (!exoPlayer.playWhenReady) {
      log("retry skipped: user paused")
      return@Runnable
    }
    log("retry #$errorRetryCount at pos=${exoPlayer.currentPosition}")
    exoPlayer.seekTo(exoPlayer.currentPosition.coerceAtLeast(0L))
    exoPlayer.prepare()
    exoPlayer.play()
    publishStatus()
  }

  /**
   * Network stalls surface as IO errors that leave ExoPlayer idle. While the user still
   * wants playback, keep retrying with exponential backoff (2s, 4s, 8s ... capped at 2 min)
   * for up to 30 minutes — with the screen off the network can take a long time to wake.
   */
  private fun scheduleErrorRecovery(
    exoPlayer: ExoPlayer,
    error: androidx.media3.common.PlaybackException
  ) {
    val isIo = error.errorCode in 2000..2999
    if (!isIo || exoPlayer.mediaItemCount == 0 || !exoPlayer.playWhenReady) {
      log("no retry: io=$isIo playWhenReady=${exoPlayer.playWhenReady}")
      return
    }
    val now = System.currentTimeMillis()
    if (firstErrorAt == 0L) firstErrorAt = now
    if (now - firstErrorAt > ERROR_RETRY_WINDOW_MS) {
      log("giving up retries after ${(now - firstErrorAt) / 1000}s")
      return
    }
    val delay = (ERROR_RETRY_BASE_DELAY_MS shl errorRetryCount.coerceAtMost(6))
      .coerceAtMost(ERROR_RETRY_MAX_DELAY_MS)
    errorRetryCount += 1
    log("scheduling retry #$errorRetryCount in ${delay}ms")
    handler.removeCallbacks(errorRecovery)
    handler.postDelayed(errorRecovery, delay)
  }

  private fun stateName(state: Int) = when (state) {
    Player.STATE_IDLE -> "IDLE"
    Player.STATE_BUFFERING -> "BUFFERING"
    Player.STATE_READY -> "READY"
    Player.STATE_ENDED -> "ENDED"
    else -> state.toString()
  }

  private fun playWhenReadyReasonName(reason: Int) = when (reason) {
    Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> "USER_REQUEST"
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS -> "AUDIO_FOCUS_LOSS"
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY -> "AUDIO_BECOMING_NOISY (headphones/BT disconnected)"
    Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE -> "REMOTE"
    Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> "END_OF_MEDIA_ITEM"
    Player.PLAY_WHEN_READY_CHANGE_REASON_SUPPRESSED_TOO_LONG -> "SUPPRESSED_TOO_LONG"
    else -> reason.toString()
  }

  private fun suppressionName(reason: Int) = when (reason) {
    Player.PLAYBACK_SUPPRESSION_REASON_NONE -> "NONE"
    Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS -> "TRANSIENT_AUDIO_FOCUS_LOSS"
    Player.PLAYBACK_SUPPRESSION_REASON_UNSUITABLE_AUDIO_OUTPUT -> "UNSUITABLE_AUDIO_OUTPUT"
    else -> reason.toString()
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
    const val EXTRA_IS_BUFFERING = "isBuffering"

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
    private const val ERROR_RETRY_BASE_DELAY_MS = 2_000L
    private const val ERROR_RETRY_MAX_DELAY_MS = 120_000L
    private const val ERROR_RETRY_WINDOW_MS = 30 * 60_000L
    private const val LOAD_RETRY_COUNT = 12
    private const val MIN_BUFFER_MS = 120_000
    private const val MAX_BUFFER_MS = 300_000
  }
}
