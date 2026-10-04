import Foundation
import WebKit
import Capacitor

/// Small native helpers for the pages that ship inside the app.
///
/// Reachable as `window.Capacitor.Plugins.PlentyShell`.
///
///  - `retry()`: load the Plenty site again. Used by the "Can't reach Plenty" page
///    (www/index.html), which does not know the site's address; the shell does.
@objc(PlentyShellPlugin)
public class PlentyShellPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    public let identifier = "PlentyShellPlugin"
    public let jsName = "PlentyShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "retry", returnType: CAPPluginReturnPromise)
    ]

    @objc func retry(_ call: CAPPluginCall) {
        guard let bridge = bridge else {
            call.reject("Plenty isn't ready yet. Please try again.")
            return
        }
        let url = bridge.config.appStartServerURL
        DispatchQueue.main.async { [weak self] in
            self?.webView?.load(URLRequest(url: url))
            call.resolve()
        }
    }
}
