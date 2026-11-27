package org.cashucard.pos

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers the app’s store and network modules with React Native. */
class CCPOSStorePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(CCPOSStoreModule(reactContext), CCPOSNetworkModule(reactContext), CCPOSBackupFilesModule(reactContext), CCPOSPaymentScanner(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
