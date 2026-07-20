import AppKit
import ScreenCaptureKit
import Vision
import CoreGraphics

// SCK screenshot of the resolved front window → Vision OCR. Spike-validated
// body (2x retina scale for OCR quality, .accurate, English). Never throws
// out: any failure yields "".
//
// Preflight gate (spike finding, spikes/capture-probe/README.md): an
// unsigned/ad-hoc agent is NOT granted effective Screen Recording even with
// the System Settings toggle on, and calling SCK ungranted triggers a
// repeating modal prompt every cycle. So we check CGPreflightScreenCaptureAccess()
// first and return "" (AX-only degrade) when it's false — no SCK call, no
// prompt storm. The OCR path lights up automatically once the agent ships
// Developer-ID-signed and the grant becomes effective.
func ocrText(for window: FrontWindow) async -> String {
    guard CGPreflightScreenCaptureAccess() else { return "" }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let win = content.windows.first(where: {
            $0.owningApplication?.processID == window.pid && $0.isOnScreen
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
    } catch {
        return ""
    }
}
