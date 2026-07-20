import ApplicationServices
import Foundation

// Spike-validated verbatim (spikes/capture-probe): 2s budget, depth cap 25,
// 50k char cap. Walks the focused window's AX tree collecting value/title/
// description strings. Returns nil when there's no focused window or no AX
// permission.
func axText(pid: pid_t) -> (title: String, text: String)? {
    let app = AXUIElementCreateApplication(pid)
    var winRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &winRef) == .success,
          let win = winRef else { return nil }
    let window = win as! AXUIElement
    var titleRef: CFTypeRef?
    AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef)
    let title = (titleRef as? String) ?? ""
    var out = ""
    let deadline = Date().addingTimeInterval(2.0)
    func walk(_ el: AXUIElement, depth: Int) {
        if depth > 25 || out.count > 50_000 || Date() > deadline { return }
        for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            var ref: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success,
               let s = ref as? String, !s.isEmpty { out += s + "\n" }
        }
        var kidsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success,
           let kids = kidsRef as? [AXUIElement] {
            for kid in kids { walk(kid, depth: depth + 1) }
        }
    }
    walk(window, depth: 0)
    return (title, out)
}
