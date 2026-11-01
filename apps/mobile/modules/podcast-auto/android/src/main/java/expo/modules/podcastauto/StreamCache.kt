package expo.modules.podcastauto

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * Play-while-downloading for episodes that use ad skipping.
 *
 * Ad segment times belong to the exact bytes that were analyzed, and podcast CDNs insert
 * ads dynamically (each fetch of the enclosure URL can return a different file). So the
 * player must hear exactly the bytes that get saved and fingerprinted. One sequential
 * download writes the file (`<target>.stream.part`, renamed to `<target>` when complete)
 * and the player reads from that same file as it grows ([StreamCacheDataSource]). There is
 * never a second, parallel fetch that could get a different ad variant.
 *
 * If the connection drops, the download resumes with a Range request against the resolved
 * final URL (after redirects) and checks that the server answered 206 with the same total
 * length and ETag/Last-Modified. Anything else (no range support, file changed) makes the
 * copy unverifiable: the session fails, playback continues straight from the network, and
 * ad skipping stays off for this play.
 */
@UnstableApi
class StreamCacheSession(
  val guid: String,
  val sourceUrl: String,
  /** Plain filesystem path of the final file (the app's download cache path). */
  val targetPath: String,
  private val httpFactory: HttpDataSource.Factory,
  private val onChange: (StreamCacheSession) -> Unit,
  private val log: (String) -> Unit
) {
  enum class State { DOWNLOADING, COMPLETE, FAILED, CANCELED }

  val finalFile = File(targetPath)
  val partFile = File("$targetPath$PART_SUFFIX")
  private val lock = Object()

  @Volatile var state = State.DOWNLOADING
    private set
  /** Bytes written contiguously from offset 0. */
  @Volatile var bytesWritten = 0L
    private set
  /** Total size, or C.LENGTH_UNSET until known. */
  @Volatile var totalLength = C.LENGTH_UNSET.toLong()
    private set
  @Volatile var headersKnown = false
    private set
  /** Final URL after redirects; resumes and fallbacks use it so they hit the same file. */
  @Volatile var resolvedUri: Uri? = null
    private set
  @Volatile var md5: String? = null
    private set
  @Volatile var error: String? = null
    private set
  /** Set when the player read bytes from the network instead of the saved file. */
  @Volatile var playedUnverifiedBytes = false

  private var etag: String? = null
  private var lastModified: String? = null
  private var thread: Thread? = null

  /** Complete, and every byte the player heard came from the saved file. */
  val isVerified: Boolean
    get() = state == State.COMPLETE && !playedUnverifiedBytes

  fun start() {
    val t = Thread({ runDownload() }, "stream-cache-$guid".take(40))
    t.isDaemon = true
    thread = t
    t.start()
  }

  fun cancel() {
    synchronized(lock) {
      if (state != State.DOWNLOADING) return
      state = State.CANCELED
      lock.notifyAll()
    }
    thread?.interrupt()
  }

  /** Blocks until response headers arrived (or the session ended). */
  @Throws(InterruptedIOException::class)
  fun awaitHeaders() {
    synchronized(lock) {
      while (!headersKnown && state == State.DOWNLOADING) waitLocked()
    }
  }

  /** Blocks until a byte at [position] is on disk, or the session ended. */
  @Throws(InterruptedIOException::class)
  fun awaitPosition(position: Long) {
    synchronized(lock) {
      while (bytesWritten <= position && state == State.DOWNLOADING) waitLocked()
    }
  }

  private fun waitLocked() {
    try {
      (lock as Object).wait(WAIT_SLICE_MS)
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      throw InterruptedIOException("stream cache wait interrupted")
    }
  }

  private fun header(source: HttpDataSource, name: String): String? =
    source.responseHeaders.entries
      .firstOrNull { it.key.equals(name, ignoreCase = true) }
      ?.value?.firstOrNull()

  /** Total size from a 206 Content-Range ("bytes a-b/total"), or null. */
  private fun contentRangeTotal(source: HttpDataSource): Long? =
    header(source, "Content-Range")?.substringAfterLast('/', "")?.trim()?.toLongOrNull()

  /** First byte offset from a 206 Content-Range ("bytes a-b/total"), or null. */
  private fun contentRangeStart(source: HttpDataSource): Long? =
    header(source, "Content-Range")?.trim()?.removePrefix("bytes")?.trim()
      ?.substringBefore('-')?.trim()?.toLongOrNull()

  private fun sameResource(source: HttpDataSource): Boolean {
    val newEtag = header(source, "ETag")
    val newModified = header(source, "Last-Modified")
    return !((etag != null && newEtag != null && etag != newEtag) ||
      (lastModified != null && newModified != null && lastModified != newModified))
  }

  private fun isRedirectFailure(e: Throwable): Boolean =
    generateSequence(e) { it.cause }.any {
      it is java.net.NoRouteToHostException || it.message?.contains("redirect", ignoreCase = true) == true
    }

  /**
   * Whether [source], opened with a Range request at [position] against [resolvedUri], is
   * a ranged answer from the very same file this session is saving (same checks as a
   * resume). Only then may the player hear its bytes without making the copy unverified.
   */
  fun isSameFileRange(source: HttpDataSource, position: Long): Boolean {
    if (source.responseCode != 206) return false
    val start = contentRangeStart(source)
    if (start != null && start != position) return false
    val total = contentRangeTotal(source)
    val known = totalLength
    if (known != C.LENGTH_UNSET.toLong() && total != null && total != known) return false
    if (!sameResource(source)) return false
    // Without a size or validator there's no way to tell it's the same file.
    return (known != C.LENGTH_UNSET.toLong() && total != null) || etag != null || lastModified != null
  }

  private fun fail(message: String) {
    synchronized(lock) {
      if (state != State.DOWNLOADING) return
      error = message
      state = State.FAILED
      lock.notifyAll()
    }
    log("stream-cache FAILED $guid: $message")
    partFile.delete()
    onChange(this)
  }

  private fun runDownload() {
    val digest = MessageDigest.getInstance("MD5")
    val buffer = ByteArray(BUFFER_BYTES)
    var attempt = 0
    var lastNotify = 0L
    try {
      partFile.parentFile?.mkdirs()
      FileOutputStream(partFile, false).use { out ->
        while (state == State.DOWNLOADING) {
          val source = httpFactory.createDataSource()
          try {
            val resuming = bytesWritten > 0
            val uri = resolvedUri ?: Uri.parse(sourceUrl)
            val spec = DataSpec.Builder().setUri(uri).setPosition(bytesWritten).build()
            val opened = source.open(spec)
            val code = source.responseCode
            if (!headersKnown) {
              resolvedUri = source.uri ?: uri
              etag = header(source, "ETag")
              lastModified = header(source, "Last-Modified")
              synchronized(lock) {
                totalLength = if (opened != C.LENGTH_UNSET.toLong()) opened else C.LENGTH_UNSET.toLong()
                headersKnown = true
                lock.notifyAll()
              }
              log("stream-cache start $guid total=$totalLength resolved=${resolvedUri?.host}")
              onChange(this)
            } else if (resuming) {
              // The rest must come from the very same file, or the saved copy would mix
              // two ad variants. Require a real ranged answer for the same resource.
              if (code != 206) return fail("server can't resume (HTTP $code), so this copy can't be verified")
              val total = contentRangeTotal(source)
              if (totalLength != C.LENGTH_UNSET.toLong() && total != null && total != totalLength) {
                return fail("file changed on the server while downloading ($total vs $totalLength bytes)")
              }
              val start = contentRangeStart(source)
              if (start != null && start != bytesWritten) {
                return fail("server resumed at the wrong offset ($start vs $bytesWritten)")
              }
              if (!sameResource(source)) return fail("file changed on the server while downloading")
              if (totalLength == C.LENGTH_UNSET.toLong()) {
                if (total == null || (etag == null && lastModified == null)) {
                  return fail("server gave no way to check the resumed download")
                }
                totalLength = total
              }
              log("stream-cache resumed $guid at $bytesWritten")
            } else {
              // Retrying from byte 0 after a failed first attempt: the player may already
              // be using the first response's size, so it must be the same file.
              if (totalLength != C.LENGTH_UNSET.toLong() && opened != totalLength) {
                return fail("file changed on the server while downloading ($opened vs $totalLength bytes)")
              }
              if (!sameResource(source)) return fail("file changed on the server while downloading")
            }
            while (state == State.DOWNLOADING) {
              val read = source.read(buffer, 0, buffer.size)
              if (read == C.RESULT_END_OF_INPUT) break
              out.write(buffer, 0, read)
              digest.update(buffer, 0, read)
              synchronized(lock) {
                bytesWritten += read
                lock.notifyAll()
              }
              attempt = 0
              val now = System.currentTimeMillis()
              if (now - lastNotify >= PROGRESS_NOTIFY_MS) {
                lastNotify = now
                onChange(this)
              }
            }
            if (state != State.DOWNLOADING) break
            if (totalLength == C.LENGTH_UNSET.toLong()) {
              totalLength = bytesWritten
            }
            if (bytesWritten >= totalLength) break
            throw IOException("connection ended early at $bytesWritten of $totalLength")
          } catch (e: IOException) {
            // Includes read timeouts (SocketTimeoutException is an InterruptedIOException).
            if (state != State.DOWNLOADING) break
            // Other 4xx answers won't change on retry; 408 (timeout) and 429 (rate limited)
            // are temporary, so they get the normal backoff like a 5xx.
            if (e is HttpDataSource.InvalidResponseCodeException &&
              e.responseCode < 500 && e.responseCode != 408 && e.responseCode != 429
            ) {
              return fail("HTTP ${e.responseCode}")
            }
            if (bytesWritten == 0L && isRedirectFailure(e)) {
              // Redirect loops are deterministic: fail now so the app can resolve the
              // chain server-side instead of buffering through every retry.
              return fail("too many redirects (${e.message})")
            }
            attempt += 1
            log("stream-cache io error $guid at $bytesWritten (attempt $attempt): ${e.message}")
            if (attempt > MAX_ATTEMPTS) return fail(e.message ?: "network error")
            try {
              Thread.sleep((RETRY_BASE_MS shl (attempt - 1).coerceAtMost(5)).coerceAtMost(RETRY_MAX_MS))
            } catch (_: InterruptedException) {
              break
            }
          } finally {
            try {
              source.close()
            } catch (_: IOException) {
            }
          }
        }
        out.fd.sync()
      }
      if (state != State.DOWNLOADING) {
        partFile.delete()
        return
      }
      if (bytesWritten <= 0L || bytesWritten != totalLength) {
        return fail("download incomplete")
      }
      // Readers keep their open handle on the .part file; the rename doesn't affect them.
      if (finalFile.exists()) finalFile.delete()
      if (!partFile.renameTo(finalFile)) return fail("couldn't save the downloaded file")
      val hex = digest.digest().joinToString("") { "%02x".format(it) }
      synchronized(lock) {
        md5 = hex
        state = State.COMPLETE
        lock.notifyAll()
      }
      log("stream-cache complete $guid bytes=$bytesWritten md5=$hex")
      onChange(this)
    } catch (e: Exception) {
      if (state == State.DOWNLOADING) fail(e.message ?: e.javaClass.simpleName) else partFile.delete()
    }
  }

  companion object {
    const val PART_SUFFIX = ".stream.part"
    private const val BUFFER_BYTES = 64 * 1024
    private const val WAIT_SLICE_MS = 250L
    private const val PROGRESS_NOTIFY_MS = 1_000L
    private const val MAX_ATTEMPTS = 8
    private const val RETRY_BASE_MS = 1_000L
    private const val RETRY_MAX_MS = 30_000L
  }
}

/**
 * Player-side reader for a [StreamCacheSession]: serves bytes from the file the session is
 * writing, waiting for the download when playback (or a seek) gets ahead of it. If the
 * session fails before reaching the requested position, it switches to reading the
 * resolved URL directly so playback keeps going (marking the session unverified, so no
 * skips apply).
 */
@UnstableApi
class StreamCacheDataSource(
  private val session: StreamCacheSession,
  private val httpFactory: HttpDataSource.Factory
) : BaseDataSource(true) {
  private var dataSpec: DataSpec? = null
  private var file: RandomAccessFile? = null
  private var position = 0L
  private var bytesRemaining = C.LENGTH_UNSET.toLong()
  private var fallback: HttpDataSource? = null
  /** Ranged read of the same file for a position far ahead of the download (see open). */
  private var ahead: HttpDataSource? = null
  private var opened = false

  override fun open(dataSpec: DataSpec): Long {
    this.dataSpec = dataSpec
    transferInitializing(dataSpec)
    session.awaitHeaders()
    position = dataSpec.position
    if (session.state == StreamCacheSession.State.FAILED || session.state == StreamCacheSession.State.CANCELED) {
      // The saved copy is gone: keep playing straight from the network (no skips).
      val length = openFallback(position, dataSpec.length)
      opened = true
      transferStarted(dataSpec)
      return length
    }
    val total = session.totalLength
    if (total != C.LENGTH_UNSET.toLong() && position > total) {
      throw androidx.media3.datasource.DataSourceException(
        androidx.media3.common.PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE
      )
    }
    openAhead(position, dataSpec.length)?.let { length ->
      opened = true
      transferStarted(dataSpec)
      return length
    }
    file = openFile()
    val remainingInFile = if (total != C.LENGTH_UNSET.toLong()) total - position else C.LENGTH_UNSET.toLong()
    bytesRemaining = when {
      dataSpec.length != C.LENGTH_UNSET.toLong() && remainingInFile != C.LENGTH_UNSET.toLong() ->
        minOf(dataSpec.length, remainingInFile)
      dataSpec.length != C.LENGTH_UNSET.toLong() -> dataSpec.length
      else -> remainingInFile
    }
    opened = true
    transferStarted(dataSpec)
    return bytesRemaining
  }

  private fun openFile(): RandomAccessFile {
    // Before completion the bytes are in .part; afterwards in the final file.
    val f = if (session.state == StreamCacheSession.State.COMPLETE) session.finalFile else session.partFile
    return try {
      RandomAccessFile(f, "r")
    } catch (e: IOException) {
      RandomAccessFile(session.finalFile, "r")
    }
  }

  /**
   * MP4/M4A files often keep their index (moov) at the end, and the extractor must read it
   * before playing; a user seek can also land far past the download. Waiting for the
   * download to reach that point turns play-while-downloading into download-first, so
   * fetch that range of the same file directly. Returns null to read from the saved file.
   */
  private fun openAhead(from: Long, length: Long): Long? {
    if (session.state != StreamCacheSession.State.DOWNLOADING) return null
    if (from <= session.bytesWritten + AHEAD_THRESHOLD_BYTES) return null
    val uri = session.resolvedUri ?: return null
    val source = httpFactory.createDataSource()
    return try {
      val result = source.open(DataSpec.Builder().setUri(uri).setPosition(from).setLength(length).build())
      if (!session.isSameFileRange(source, from)) {
        source.close()
        return null
      }
      ahead = source
      result
    } catch (e: IOException) {
      try {
        source.close()
      } catch (_: IOException) {
      }
      null
    }
  }

  private fun openFallback(from: Long, length: Long): Long {
    session.playedUnverifiedBytes = true
    val source = httpFactory.createDataSource()
    val uri = session.resolvedUri ?: Uri.parse(session.sourceUrl)
    val spec = DataSpec.Builder().setUri(uri).setPosition(from).setLength(length).build()
    val result = source.open(spec)
    fallback = source
    file?.close()
    file = null
    return result
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    while (true) {
      (fallback ?: ahead)?.let { source ->
        val n = source.read(buffer, offset, length)
        if (n > 0) bytesTransferred(n)
        return n
      }
      if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT
      // Blocks (player shows buffering) while playback or a seek is ahead of the download.
      session.awaitPosition(position)
      val available = session.bytesWritten - position
      if (available > 0L) {
        var toRead = minOf(length.toLong(), available)
        if (bytesRemaining != C.LENGTH_UNSET.toLong()) toRead = minOf(toRead, bytesRemaining)
        val raf = file ?: openFile().also { file = it }
        raf.seek(position)
        val n = raf.read(buffer, offset, toRead.toInt())
        if (n <= 0) {
          raf.close()
          file = null
          continue
        }
        position += n
        if (bytesRemaining != C.LENGTH_UNSET.toLong()) bytesRemaining -= n
        bytesTransferred(n)
        return n
      }
      when (session.state) {
        StreamCacheSession.State.COMPLETE -> return C.RESULT_END_OF_INPUT
        StreamCacheSession.State.FAILED, StreamCacheSession.State.CANCELED -> {
          // The saved copy stops here: keep playing from the network (no skips).
          openFallback(position, bytesRemaining)
        }
        StreamCacheSession.State.DOWNLOADING -> Unit
      }
    }
  }

  override fun getUri(): Uri? = session.resolvedUri ?: dataSpec?.uri

  companion object {
    /** Reads starting further than this past the download use a ranged fetch instead of waiting. */
    private const val AHEAD_THRESHOLD_BYTES = 1L * 1024 * 1024
  }

  override fun getResponseHeaders(): Map<String, List<String>> =
    (fallback ?: ahead)?.responseHeaders ?: emptyMap()

  override fun close() {
    try {
      file?.close()
      fallback?.close()
      ahead?.close()
    } finally {
      file = null
      fallback = null
      ahead = null
      if (opened) {
        opened = false
        transferEnded()
      }
    }
  }
}

/**
 * Routes playback reads: items whose cache key names the active stream-cache session read
 * from its file; everything else (local files, plain streams) uses the normal data source.
 */
@UnstableApi
class StreamCacheRoutingDataSource(
  private val upstream: DataSource,
  private val httpFactory: HttpDataSource.Factory,
  private val sessionFor: (String?) -> StreamCacheSession?
) : DataSource {
  private val transferListeners = mutableListOf<TransferListener>()
  private var active: DataSource? = null

  override fun addTransferListener(transferListener: TransferListener) {
    transferListeners.add(transferListener)
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    val session = sessionFor(dataSpec.key)
    val target: DataSource = if (session != null) {
      StreamCacheDataSource(session, httpFactory).also { source ->
        transferListeners.forEach(source::addTransferListener)
      }
    } else {
      upstream
    }
    active = target
    return target.open(dataSpec)
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
    active?.read(buffer, offset, length) ?: throw IOException("not opened")

  override fun getUri(): Uri? = active?.uri

  override fun getResponseHeaders(): Map<String, List<String>> = active?.responseHeaders ?: emptyMap()

  override fun close() {
    try {
      active?.close()
    } finally {
      active = null
    }
  }

  companion object {
    const val KEY_PREFIX = "podcast-adskip-stream-cache:"
  }
}
