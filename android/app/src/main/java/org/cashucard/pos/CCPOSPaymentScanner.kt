package org.cashucard.pos

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.ScanOptions
import java.lang.ref.WeakReference

/** In-process only. A payment frame never goes into an Intent, a file or the Android clipboard. */
class PaymentScanActivity : Activity() {
  companion object {
    internal var active = WeakReference<PaymentScanActivity>(null)
    internal var onFrame: ((String, String) -> Unit)? = null
  }
  private lateinit var view: DecoratedBarcodeView
  private lateinit var controller: CaptureManager
  internal val session: String? get() = intent.getStringExtra("scanSession")
  private var previous: String? = null

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    view = DecoratedBarcodeView(this)
    val cancel = Button(this).apply { text = "Cancel"; setOnClickListener { finish() } }
    setContentView(FrameLayout(this).apply {
      addView(view)
      addView(cancel, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END))
      setOnApplyWindowInsetsListener { _, insets ->
        cancel.translationY = insets.systemWindowInsetTop.toFloat()
        insets
      }
    })
    controller = CaptureManager(this, view)
    controller.initializeFromIntent(intent, state)
    active = WeakReference(this)
    if (onFrame == null || session == null) { finish(); return }
    view.decodeContinuous { result ->
      val text = result.text
      if (!isFinishing && text != null && text != previous) {
        previous = text
        onFrame?.invoke(session!!, text)
      }
    }
  }

  internal fun progress(received: Int, expected: Int) {
    view.setStatusText("Reading moving QR · $received of $expected")
  }

  override fun onResume() { super.onResume(); if (!isFinishing) controller.onResume() }
  override fun onPause() { controller.onPause(); super.onPause() }
  override fun onDestroy() {
    if (active.get() === this) active.clear()
    controller.onDestroy()
    super.onDestroy()
  }
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, results)
    controller.onRequestPermissionsResult(requestCode, permissions, results)
  }
}

class CCPOSPaymentScanner(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private data class Scan(val session: String, val promise: Promise)
  private var pending: Scan? = null
  private val requestCode = 5420

  private val listener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, code: Int, result: Int, data: Intent?) {
      if (code != requestCode) return
      val scan = pending ?: return
      pending = null
      PaymentScanActivity.onFrame = null
      if (data?.getBooleanExtra(Intents.Scan.MISSING_CAMERA_PERMISSION, false) == true) {
        scan.promise.reject("camera_denied", "Allow camera access in Settings or paste the payment.")
      } else {
        scan.promise.resolve(result == Activity.RESULT_OK)
      }
    }
  }

  init { context.addActivityEventListener(listener) }
  override fun getName() = "CCPOSPaymentScanner"
  @ReactMethod fun addListener(event: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  @ReactMethod fun scan(session: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = currentActivity
      if (pending != null || activity == null || activity.isFinishing) {
        promise.reject("camera_unavailable", "The camera is unavailable. Paste the payment instead.")
        return@runOnUiThread
      }
      val options = ScanOptions()
        .setCaptureActivity(PaymentScanActivity::class.java)
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setOrientationLocked(false)
        .setBeepEnabled(false)
        .setBarcodeImageEnabled(false)
        .setPrompt("Scan the payment QR on the customer’s phone")
      pending = Scan(session, promise)
      PaymentScanActivity.onFrame = { who, text ->
        if (pending?.session == who) {
          val event = Arguments.createMap().apply { putString("session", who); putString("text", text) }
          context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("CCPOSPaymentFrame", event)
        }
      }
      try {
        activity.startActivityForResult(options.createScanIntent(activity).putExtra("scanSession", session), requestCode)
      } catch (_: Exception) {
        pending = null
        PaymentScanActivity.onFrame = null
        promise.reject("camera_unavailable", "The camera is unavailable. Paste the payment instead.")
      }
    }
  }

  @ReactMethod fun showProgress(session: String, received: Int, expected: Int) {
    UiThreadUtil.runOnUiThread { PaymentScanActivity.active.get()?.takeIf { it.session == session }?.progress(received, expected) }
  }

  @ReactMethod fun finishScan(session: String) {
    UiThreadUtil.runOnUiThread {
      PaymentScanActivity.active.get()?.takeIf { it.session == session }?.let { it.setResult(Activity.RESULT_OK); it.finish() }
    }
  }

  override fun invalidate() {
    context.removeActivityEventListener(listener)
    UiThreadUtil.runOnUiThread {
      val old = pending
      if (old != null) {
        PaymentScanActivity.onFrame = null
        PaymentScanActivity.active.get()?.takeIf { it.session == old.session }?.finish()
        old.promise.resolve(false)
        pending = null
      }
    }
    super.invalidate()
  }
}
