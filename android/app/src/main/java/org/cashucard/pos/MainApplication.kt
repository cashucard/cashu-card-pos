package org.cashucard.pos

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.websocket.WebSocketModule
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // the journal directory module (slice 0.3), the app's own
              add(CCPOSStorePackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // The till never follows an HTTP redirect (slice 2.5, ENG-905). React Native builds the client behind every
    // fetch from this factory, and OkHttp follows redirects unless told not to: left alone it re-sends a 307 POST,
    // body and all, to the new address before the till's own guard (guardedFetch, src/till/http.ts) can refuse the
    // answer. With both switches off, the 3xx answer itself goes to JavaScript and nothing is sent to the address
    // it names. Set here, before React Native starts, so the first client is already built this way. It applies to
    // every request the app makes through React Native's networking, which is wanted: the app talks only to mints
    // and, in development, to this Mac. The client is otherwise React Native's own (its cookie jar and cache).
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(applicationContext)
          .followRedirects(false)
          .followSslRedirects(false)
          .build()
    }
    // React Native's WebSocket module builds its own client and never asks the factory above (WebSocketModule.connect).
    // OkHttp would follow a 3xx answer to a socket's opening request. The app opens no WebSocket today; this keeps a
    // later one from reaching an address the merchant did not add. The builder is static and read at each connect.
    WebSocketModule.setCustomClientBuilder { it.followRedirects(false).followSslRedirects(false) }
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
  }
}
