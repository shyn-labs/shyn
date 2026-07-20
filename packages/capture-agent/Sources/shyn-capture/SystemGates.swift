import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics

func isSecureInputActive() -> Bool { IsSecureEventInputEnabled() }

func isScreenLocked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (d["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func idleSeconds() -> Double {
    let types: [CGEventType] = [.mouseMoved, .keyDown, .leftMouseDown, .scrollWheel]
    return types.map {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0)
    }.min() ?? 0
}

struct FrontWindow {
    let bundleId: String, pid: pid_t, title: String, appName: String
}

func frontWindow() -> FrontWindow? {
    guard let app = NSWorkspace.shared.frontmostApplication,
          app.activationPolicy == .regular,
          let bundleId = app.bundleIdentifier else { return nil }
    // Title comes from AX (cheap single-attribute read, no tree walk)
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var winRef: CFTypeRef?
    var title = ""
    if AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &winRef) == .success,
       let win = winRef {
        var t: CFTypeRef?
        AXUIElementCopyAttributeValue(win as! AXUIElement, kAXTitleAttribute as CFString, &t)
        title = (t as? String) ?? ""
    }
    return FrontWindow(bundleId: bundleId, pid: app.processIdentifier,
                       title: title, appName: app.localizedName ?? bundleId)
}
