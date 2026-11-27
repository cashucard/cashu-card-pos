package org.cashucard.pos

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/** Cashu Card POS (slice 0.3): the journal's directory under noBackupFilesDir, which Android never backs up, and the
 * file operations the store needs. JavaScript reaches it as NativeModules.CCPOSStore. */
class CCPOSStoreModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "CCPOSStore"

  private fun base(): File = ctx.noBackupFilesDir.canonicalFile

  private fun inBase(path: String): Boolean {
    val f = File(path).canonicalFile.path
    val b = base().path
    return f == b || f.startsWith(b + File.separator)
  }

  @ReactMethod
  fun journalDir(name: String, promise: Promise) {
    if (!Regex("^[a-z0-9-]{1,32}$").matches(name)) {
      promise.reject("name", "a directory name is 1 to 32 of a-z 0-9 -")
      return
    }
    val dir = File(base(), name)
    if (!dir.isDirectory && !dir.mkdirs()) {
      promise.reject("dir", "the directory could not be made")
      return
    }
    promise.resolve(dir.path)
  }

  @ReactMethod
  fun exists(path: String, promise: Promise) {
    promise.resolve(File(path).exists())
  }

  /** Nothing to set: a file under noBackupFilesDir is never backed up. True when it exists there. */
  @ReactMethod
  fun excludeFromBackup(path: String, promise: Promise) {
    promise.resolve(File(path).exists() && inBase(path))
  }

  @ReactMethod
  fun isExcludedFromBackup(path: String, promise: Promise) {
    promise.resolve(File(path).exists() && inBase(path))
  }

  @ReactMethod
  fun move(from: String, to: String, promise: Promise) {
    val a = File(from)
    val b = File(to)
    if (!a.exists()) {
      promise.reject("move", "nothing to move")
      return
    }
    if (b.exists()) {
      promise.reject("move", "the target exists")
      return
    }
    if (!a.renameTo(b)) {
      promise.reject("move", "the file could not be moved")
      return
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun removeLabFile(path: String, promise: Promise) {
    val f = File(path)
    if (!f.name.startsWith("lab-")) {
      promise.reject("lab", "only a lab- file may be removed")
      return
    }
    if (f.exists() && !f.delete()) {
      promise.reject("lab", "the file could not be removed")
      return
    }
    promise.resolve(null)
  }
}
