package org.cashucard.pos

import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      // Android draws target-36 apps behind the bars. Keep the card controls and PIN field clear.
      val content = findViewById<View>(android.R.id.content)
      ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
        val safe = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or
              WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
        view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
        insets
      }
      ViewCompat.requestApplyInsets(content)
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "CashuCardPOS"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
        override fun getLaunchOptions(): Bundle {
          @Suppress("DEPRECATION") // The flags overload also supports Android 7–12.
          val installed = packageManager.getPackageInfo(packageName, 0)
          return Bundle().apply {
            putString("versionName", installed.versionName)
            putString("buildNumber", PackageInfoCompat.getLongVersionCode(installed).toString())
          }
        }
      }
}
