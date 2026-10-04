import UIKit
import WebKit
import Capacitor

/// The one screen of the app: Capacitor's web view controller, set up for Plenty.
///
/// `SceneDelegate` creates this class and `Main.storyboard` names it, so there is no
/// other way to reach the web view.
class PlentyBridgeViewController: CAPBridgeViewController {
    /// Capacitor keeps its delegates weak, so the guard has to be owned here.
    private var webViewGuard: PlentyWebViewGuard?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        registerPlentyPlugins()
        configureWebView()
    }

    /// Local plugins (the ones that live in this app, not in npm packages) must be
    /// registered in code. `npx cap sync` rewrites `packageClassList` in
    /// capacitor.config.json from the installed npm plugins only, so a class listed
    /// there by hand would be dropped on the next sync.
    private func registerPlentyPlugins() {
        bridge?.registerPluginInstance(PlentyShellPlugin())
        bridge?.registerPluginInstance(PlentyPurchasesPlugin())
    }

    private func configureWebView() {
        guard let webView = webView, let bridge = bridge else { return }

        // Swipe from the left edge goes back, like any iOS app.
        webView.allowsBackForwardNavigationGestures = true

        // No pull-to-refresh: there is no refresh control, and the scroll view does not bounce.
        webView.scrollView.refreshControl = nil
        webView.scrollView.bounces = false

        // Plenty's own origin only (see PlentyWebViewGuard).
        if let handler = webView.navigationDelegate as? WebViewDelegationHandler {
            let guardDelegate = PlentyWebViewGuard(wrapping: handler, bridge: bridge)
            webViewGuard = guardDelegate
            webView.navigationDelegate = guardDelegate
            webView.uiDelegate = guardDelegate
        }

        // The page's own colour (the site's "canvas" token, light and dark) behind
        // the page while it loads and when it is scrolled past its ends, so
        // there is no white flash on a dark phone.
        let canvas = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x11 / 255.0, green: 0x12 / 255.0, blue: 0x14 / 255.0, alpha: 1)
                : UIColor(red: 0xFA / 255.0, green: 0xF8 / 255.0, blue: 0xF5 / 255.0, alpha: 1)
        }
        webView.backgroundColor = canvas
        webView.scrollView.backgroundColor = canvas
        webView.underPageBackgroundColor = canvas
    }
}
