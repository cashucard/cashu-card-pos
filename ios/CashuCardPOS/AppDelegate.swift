import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: RCTAppDelegate {
  private var launchOptionsForReact: [UIApplication.LaunchOptionsKey: Any]?
  private var tillViewController: UIViewController?


  override func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
    automaticallyLoadReactNativeWindow = false
    launchOptionsForReact = launchOptions
    self.moduleName = "CashuCardPOS"
    self.dependencyProvider = RCTAppDependencyProvider()
    let info = Bundle.main.infoDictionary
    self.initialProps = [
      "versionName": info?["CFBundleShortVersionString"] as? String,
      "buildNumber": info?["CFBundleVersion"] as? String,
    ].compactMapValues { $0 }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Keep a single React root and till service if UIKit disconnects and reconnects the window.
  func attachTill(to window: UIWindow) {
    let controller: UIViewController
    if let existing = tillViewController {
      controller = existing
    } else {
      controller = createRootViewController()
      controller.view = rootViewFactory.view(withModuleName: "CashuCardPOS",
                                             initialProperties: initialProps,
                                             launchOptions: launchOptionsForReact)
      launchOptionsForReact = nil
      tillViewController = controller
    }
    self.window = window
    window.rootViewController = controller
    window.makeKeyAndVisible()
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    // This app's own Metro port (8091), so it never loads another project's bundle from the shared 8081.
    let settings = RCTBundleURLProvider.sharedSettings()
    settings.jsLocation = "127.0.0.1:8091"
    return settings.jsBundleURL(forBundleRoot: "index")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

final class TillSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    app.attachTill(to: window)
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window?.rootViewController = nil
    window = nil
  }
}
