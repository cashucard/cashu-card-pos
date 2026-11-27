package org.cashucard.pos

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CCPOSNetworkModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "CCPOSNetwork"

  @ReactMethod
  fun status(promise: Promise) {
    try {
      val manager = ctx.getSystemService(ConnectivityManager::class.java)
      if (manager == null) {
        promise.resolve("unknown")
        return
      }
      val active = manager.activeNetwork
      if (active == null) {
        promise.resolve("offline")
        return
      }
      val capabilities = manager.getNetworkCapabilities(active)
      // A missing capability snapshot, captive portal or unvalidated route is ambiguous.
      val online = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
      promise.resolve(if (online) "online" else "unknown")
    } catch (error: RuntimeException) {
      promise.reject("connectivity", "The phone could not read the current network.", error)
    }
  }
}
