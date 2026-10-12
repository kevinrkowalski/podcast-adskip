package expo.modules.podcastauto

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Tiny persistent ring buffer of playback events (pause reasons, focus changes, errors,
 * retries, service lifecycle) so screen-off stops can be diagnosed without adb.
 */
object PlaybackEventLog {
  private const val MAX_EVENTS = 200
  private const val FILE_NAME = "playback-events.log"
  private val lines = ArrayDeque<String>()
  private var file: File? = null
  private val format = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.US)

  @Synchronized
  private fun ensureLoaded(context: Context) {
    if (file != null) return
    val f = File(context.applicationContext.filesDir, FILE_NAME)
    file = f
    try {
      if (f.exists()) f.readLines().takeLast(MAX_EVENTS).forEach { lines.addLast(it) }
    } catch (_: Exception) {
      // A corrupt log is not worth failing playback over.
    }
  }

  @Synchronized
  fun log(context: Context, event: String) {
    ensureLoaded(context)
    lines.addLast("${format.format(Date())}  ${event.replace('\n', ' ')}")
    while (lines.size > MAX_EVENTS) lines.removeFirst()
    try {
      file?.writeText(lines.joinToString("\n", postfix = "\n"))
    } catch (_: Exception) {
      // Ignore disk errors.
    }
  }

  @Synchronized
  fun read(context: Context): String {
    ensureLoaded(context)
    return lines.joinToString("\n")
  }

  @Synchronized
  fun clear(context: Context) {
    ensureLoaded(context)
    lines.clear()
    try {
      file?.delete()
    } catch (_: Exception) {
    }
  }
}
