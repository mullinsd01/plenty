import UIKit
import WebKit
import Capacitor

/// Plenty's rules for the web view, layered on top of Capacitor's own delegate.
///
/// Capacitor's `WebViewDelegationHandler` already sends top-level navigation to
/// other hosts to the system browser. What it does not do, and this class adds:
///
///  - Camera: only the camera, only for Plenty's own origin, only for the top-level
///    page. Capacitor grants every media request from every origin; microphone
///    would also crash the app, because Plenty has no microphone purpose string.
///  - Frames: a page from another host can't load as a frame inside Plenty (a
///    frame could otherwise talk to the native bridge).
///  - Links that open a new window (`target="_blank"`, `window.open`): Plenty's own
///    pages open in the same web view, everything else in the system browser.
///  - The "Can't reach Plenty" page: shown only for real connection failures, not
///    when a link was deliberately handed to the system browser.
///  - Device motion: not used by Plenty, always refused.
///
/// Everything else is forwarded unchanged to Capacitor's handler (`inner`): the
/// forwarding is dynamic (`responds(to:)` / `forwardingTarget(for:)`), so the
/// JavaScript alert panels, certificate challenges and every other delegate method
/// keep working exactly as Capacitor wrote them.
///
/// The delegate protocols are adopted in extensions on purpose: UIKit and WebKit mark
/// them main-actor, and adopting them on the class itself would also make the
/// `NSObject` overrides below main-actor, which the compiler refuses.
final class PlentyWebViewGuard: NSObject {
    private let inner: WebViewDelegationHandler
    private weak var bridge: CAPBridgeProtocol?

    init(wrapping inner: WebViewDelegationHandler, bridge: CAPBridgeProtocol) {
        self.inner = inner
        self.bridge = bridge
        super.init()
    }

    // MARK: - Forward everything not handled below to Capacitor's handler

    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if inner.responds(to: aSelector) {
            return inner
        }
        return super.forwardingTarget(for: aSelector)
    }

    // MARK: - Origin helpers

    /// The address the app loads (PLENTY_URL, written into capacitor.config.json by `cap sync`).
    private var appURL: URL? {
        return bridge?.config.serverURL
    }

    private static func defaultPort(forScheme scheme: String) -> Int {
        switch scheme.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return 0
        }
    }

    private func isAppOrigin(scheme: String, host: String, port: Int) -> Bool {
        guard let app = appURL, let appScheme = app.scheme, let appHost = app.host else { return false }
        guard scheme.lowercased() == appScheme.lowercased(), host.lowercased() == appHost.lowercased() else { return false }
        let appPort = app.port ?? PlentyWebViewGuard.defaultPort(forScheme: appScheme)
        let thatPort = port == 0 ? PlentyWebViewGuard.defaultPort(forScheme: scheme) : port
        return appPort == thatPort
    }

    private func isAppURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme, let host = url.host else { return false }
        return isAppOrigin(scheme: scheme, host: host, port: url.port ?? 0)
    }

    private func isLocalFallbackURL(_ url: URL) -> Bool {
        guard let local = bridge?.config.localURL, let scheme = url.scheme, let host = url.host else { return false }
        return scheme.lowercased() == (local.scheme ?? "").lowercased() && host.lowercased() == (local.host ?? "").lowercased()
    }

    private static func isWebAddress(_ url: URL) -> Bool {
        let scheme = (url.scheme ?? "").lowercased()
        return scheme == "https" || scheme == "http"
    }

    /// True for a genuine failure to load the site. False for a navigation that was
    /// cancelled on purpose (a link handed to the system browser, a download) and
    /// for a failure of the local fallback page itself, which would loop forever.
    fileprivate func shouldShowFallback(for error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return false
        }
        // WebKitErrorFrameLoadInterruptedByPolicyChange
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 {
            return false
        }
        if let failingURL = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL, isLocalFallbackURL(failingURL) {
            return false
        }
        return true
    }
}

// MARK: - WKNavigationDelegate

extension PlentyWebViewGuard: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // A frame (not a top-level page) may only load Plenty's own pages.
        if let url = navigationAction.request.url,
           let target = navigationAction.targetFrame,
           !target.isMainFrame,
           PlentyWebViewGuard.isWebAddress(url),
           !isAppURL(url) {
            decisionHandler(.cancel)
            return
        }
        // Everything else follows Capacitor's rules: the app's own host loads in
        // the web view, any other top-level address (https links, mailto:, tel:)
        // goes to the system.
        inner.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard shouldShowFallback(for: error) else { return }
        inner.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard shouldShowFallback(for: error) else { return }
        inner.webView(webView, didFail: navigation, withError: error)
    }
}

// MARK: - WKUIDelegate

extension PlentyWebViewGuard: WKUIDelegate {
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // The barcode scanner and the receipt camera need the camera of the top-level page
        // of Plenty's own site. iOS still asks the person once, with the camera purpose string.
        // Microphone (alone or with the camera) is always refused.
        if type == .camera && frame.isMainFrame && isAppOrigin(scheme: origin.protocol, host: origin.host, port: origin.port) {
            decisionHandler(.grant)
        } else {
            decisionHandler(.deny)
        }
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if isAppURL(url) {
            // A link to another Plenty page that asked for a new window: stay in the app.
            webView.load(navigationAction.request)
        } else if let scheme = url.scheme?.lowercased(), ["https", "http", "mailto", "tel"].contains(scheme) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        // Never create a second web view.
        return nil
    }
}
