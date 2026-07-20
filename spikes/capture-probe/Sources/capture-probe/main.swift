import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

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

func ocrFrontmost() async throws -> String {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let front = NSWorkspace.shared.frontmostApplication,
          let win = content.windows.first(where: {
              $0.owningApplication?.processID == front.processIdentifier && $0.isOnScreen
          }) else { return "" }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let cfg = SCStreamConfiguration()
    cfg.width = Int(win.frame.width) * 2   // retina scale for OCR quality
    cfg.height = Int(win.frame.height) * 2
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en"]
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

// Establish a GUI (Aqua/WindowServer) session so CoreGraphics + ScreenCaptureKit
// can initialize under a headless LaunchAgent. Without this, the first AppKit/CG
// touch from a launchd-spawned process trips `CGS_REQUIRE_INIT`. .accessory keeps
// it off the Dock and out of the menu bar (LSUIElement-equivalent at runtime).
// This is the reference bootstrap Task 6's real agent adopts.
let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.accessory)

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ax"
switch mode {
case "ax":
    guard let front = NSWorkspace.shared.frontmostApplication else { exit(1) }
    if let r = axText(pid: front.processIdentifier) {
        print("app=\(front.localizedName ?? "?") title=\(r.title) chars=\(r.text.count)")
        print(r.text.prefix(2000))
    } else { print("AX: no focused window / no permission") }
case "ocr":
    do {
        let text = try await ocrFrontmost()
        print("chars=\(text.count)")
        print(text.prefix(2000))
    } catch {
        print("OCR: error - \(error)")
    }
case "loop":
    let logPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "/tmp/capture-probe.log"
    while true {
        var line = ISO8601DateFormatter().string(from: Date())
        if let front = NSWorkspace.shared.frontmostApplication {
            let ax = axText(pid: front.processIdentifier)
            let axChars = ax?.text.count ?? 0
            if axChars >= 80 {
                line += " | \(front.bundleIdentifier ?? "?") | ax | \(axChars)"
            } else {
                let t = (try? await ocrFrontmost()) ?? ""
                line += " | \(front.bundleIdentifier ?? "?") | ocr | \(t.count)"
            }
        } else { line += " | none | - | 0" }
        try? (line + "\n").appendToFile(logPath)
        try await Task.sleep(for: .seconds(30))
    }
default: print("usage: capture-probe ax|ocr|loop [logfile]")
}

extension String {
    func appendToFile(_ path: String) throws {
        if let h = FileHandle(forWritingAtPath: path) {
            defer { try? h.close() }
            try h.seekToEnd(); try h.write(contentsOf: Data(utf8))
        } else {
            try write(toFile: path, atomically: true, encoding: .utf8)
        }
    }
}
