package org.cashucard.pos

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.AtomicFile
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors

/** The document provider only receives the passphrase-encrypted backup envelope. */
class CCPOSBackupFilesModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private companion object {
    const val OPEN = 5417
    const val SAVE = 5418
    const val FOLDER = 5419
    const val MAX_BYTES = 24 * 1024 * 1024
  }

  private data class Request(val code: Int, val encrypted: String?, val promise: Promise)
  private var request: Request? = null // main thread
  private val worker = Executors.newSingleThreadExecutor()

  private val listener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      val active = request ?: return
      if (requestCode != active.code) return
      request = null
      if (resultCode == Activity.RESULT_CANCELED) {
        active.promise.resolve(null)
        return
      }
      val uri = data?.data
      if (resultCode != Activity.RESULT_OK || uri?.scheme != "content") {
        active.promise.reject("document_error", "The document picker could not open the file.")
        return
      }
      worker.execute {
        try {
          if (active.code == FOLDER) {
            val flags = (data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            storeFolder(uri, flags)
            active.promise.resolve(true)
          } else if (active.encrypted != null) {
            val output = ctx.contentResolver.openOutputStream(uri, "wt") ?: throw IOException()
            output.use { it.write(active.encrypted.toByteArray(Charsets.US_ASCII)) }
            // Confirm the provider really kept the complete, original bytes before acknowledging the backup.
            if (readFile(uri) != active.encrypted) throw IOException()
            active.promise.resolve(true)
          } else {
            active.promise.resolve(readFile(uri))
          }
        } catch (_: Exception) {
          active.promise.reject("document_error", "The encrypted backup could not be read or saved in this location.")
        }
      }
    }
  }

  init { ctx.addActivityEventListener(listener) }
  override fun getName(): String = "CCPOSBackupFiles"

  private external fun deriveNative(password: ByteArray, salt: ByteArray): ByteArray?

  @ReactMethod fun deriveKey(passwordHex: String, saltHex: String, promise: Promise) {
    if (passwordHex.length !in 2..512 || passwordHex.length % 2 != 0 ||
        !passwordHex.matches(Regex("[0-9a-f]+")) || !saltHex.matches(Regex("[0-9a-f]{32}"))) {
      promise.reject("backup_key", "Invalid backup key input.")
      return
    }
    fun decode(hex: String) = ByteArray(hex.length / 2) { i -> hex.substring(2*i, 2*i+2).toInt(16).toByte() }
    worker.execute {
      val pass = decode(passwordHex)
      var key: ByteArray? = null
      try {
        com.facebook.soloader.SoLoader.loadLibrary("appmodules")
        key = deriveNative(pass, decode(saltHex)) ?: throw IOException()
        promise.resolve(key.joinToString("") { "%02x".format(Locale.ROOT, it) })
      } catch (_: LinkageError) {
        promise.reject("backup_key", "The backup key could not be derived.")
      } catch (_: Exception) {
        promise.reject("backup_key", "The backup key could not be derived.")
      } finally {
        pass.fill(0)
        key?.fill(0)
      }
    }
  }

  private val folderRecord get() = AtomicFile(File(ctx.noBackupFilesDir, "cashupos-recovery-folder"))

  private fun storeFolder(uri: Uri, flags: Int) {
    val readWrite = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    if (flags != readWrite || !DocumentsContract.isTreeUri(uri)) throw IOException()
    val previous = runCatching { savedFolder() }.getOrNull()
    ctx.contentResolver.takePersistableUriPermission(uri, flags)
    val record = folderRecord
    val output = record.startWrite()
    try {
      output.write(uri.toString().toByteArray(Charsets.UTF_8))
      record.finishWrite(output)
    } catch (error: Exception) {
      record.failWrite(output)
      throw error
    }
    if (previous != null && previous != uri) {
      runCatching { ctx.contentResolver.releasePersistableUriPermission(previous, readWrite) }
    }
  }

  private fun savedFolder(): Uri = Uri.parse(String(folderRecord.readFully(), Charsets.UTF_8))

  private fun filename(): String {
    val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss.SSS'Z'", Locale.US)
    stamp.timeZone = TimeZone.getTimeZone("UTC")
    return "Cashu-POS-${stamp.format(Date())}-${UUID.randomUUID()}.cashupos"
  }

  private fun validFile(encrypted: String): Boolean =
    encrypted.length <= MAX_BYTES && encrypted.startsWith("CASHU-POS-BACKUP-1\n") && encrypted.none { it.code > 127 }

  private fun readFile(uri: Uri): String {
    val input = ctx.contentResolver.openInputStream(uri) ?: throw IOException()
    return input.use {
      val out = ByteArrayOutputStream()
      val chunk = ByteArray(16384)
      while (true) {
        val n = it.read(chunk)
        if (n < 0) break
        if (n == 0 || n > MAX_BYTES - out.size()) throw IOException()
        out.write(chunk, 0, n)
      }
      if (out.size() == 0) throw IOException()
      out.toString("US-ASCII")
    }
  }

  private fun pick(code: Int, encrypted: String?, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = currentActivity
      if (activity == null || request != null) {
        promise.reject("document_busy", "Return to the till and try again.")
        return@runOnUiThread
      }
      val intent = when (code) {
        FOLDER -> Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        SAVE -> Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
          .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, filename())
        else -> Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
      }
      request = Request(code, encrypted, promise)
      try {
        activity.startActivityForResult(intent, code)
      } catch (_: Exception) {
        request = null
        promise.reject("document_error", "The system document picker is unavailable.")
      }
    }
  }

  @ReactMethod fun chooseFolder(promise: Promise) = pick(FOLDER, null, promise)

  @ReactMethod fun writeCopy(encrypted: String, promise: Promise) {
    if (!validFile(encrypted)) {
      promise.reject("document_invalid", "Choose a Cashu POS encrypted backup.")
      return
    }
    worker.execute {
      var created: Uri? = null
      try {
        val tree = savedFolder()
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val resolver = ctx.contentResolver
        val file = DocumentsContract.createDocument(resolver, parent, "application/octet-stream", filename())
          ?: throw IOException()
        created = file
        val stream = resolver.openOutputStream(file, "wt") ?: throw IOException()
        stream.use { it.write(encrypted.toByteArray(Charsets.US_ASCII)) }
        if (readFile(file) != encrypted) throw IOException()
        promise.resolve(true)
      } catch (_: Exception) {
        // This URI was just created by this call. Preserve all older recovery files.
        created?.let { failed -> runCatching { DocumentsContract.deleteDocument(ctx.contentResolver, failed) } }
        promise.reject("recovery_folder", "Choose the recovery folder again and verify that it has free space.")
      }
    }
  }

  @ReactMethod fun open(promise: Promise) = pick(OPEN, null, promise)
  @ReactMethod fun save(encrypted: String, promise: Promise) {
    if (!validFile(encrypted)) {
      promise.reject("document_size", "This backup exceeds the supported file size.")
      return
    }
    pick(SAVE, encrypted, promise)
  }

  override fun invalidate() {
    ctx.removeActivityEventListener(listener)
    UiThreadUtil.runOnUiThread {
      request?.promise?.reject("document_closed", "The backup screen closed.")
      request = null
    }
    worker.shutdown()
    super.invalidate()
  }
}
