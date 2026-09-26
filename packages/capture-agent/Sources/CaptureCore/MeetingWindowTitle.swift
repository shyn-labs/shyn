import Foundation

// Window titles are the fallback when EventKit has nothing (the Google-only
// calendar user). Raw, they carry browser and app furniture:
//
//   "Google Meet - Meet - Weekly Ops Review"     → "Weekly Ops Review"
//   "Meet – Weekly Ops Review"                   → "Weekly Ops Review"
//   "Zoom Meeting"                               → nil (generic)
//
// Live finding 2026-08-04: a real meeting shipped as "Google Meet meeting ·
// 4 Aug 2026 at 16:03" while the window title one second away held the actual
// name, so the doc was unfindable by the name the user knows it by. Titling it
// "Meet" would be no better, hence the generic-only → nil rule.

let windowTitleFurniture: Set<String> = [
    "google chrome", "chrome", "safari", "arc", "brave", "firefox",
    "meet", "google meet", "zoom", "zoom meeting", "zoom workplace",
    "microsoft teams", "teams", "webex", "cisco webex meetings",
    "slack", "call", "new tab", "untitled",
]

// Chrome appends tab STATE to the window title, and a call tab is exactly the
// tab that carries it: "Meet - Sprint Review - Camera and microphone recording
// - Google Chrome". Lived 2026-09-24: a 1:1 shipped titled "Sam / Alex - Camera
// and microphone recording" (the calendar rung was down: the invite
// had moved that morning). Compared lowercased, whole component.
let chromeTabStateFurniture: Set<String> = [
    "camera and microphone recording", "camera recording", "microphone recording",
    "audio playing", "audio muted", "screen sharing", "sharing this tab",
    "sharing your screen", "high memory usage", "network error",
]

// Chrome's memory warning carries its own " - " separator:
// "... - High memory usage - 857 MB - Google Chrome". Once split, the size is
// a component on its own, and it is never part of a meeting name.
func isMemorySizeComponent(_ component: String) -> Bool {
    let parts = component.split(separator: " ")
    guard parts.count == 2, ["kb", "mb", "gb"].contains(parts[1].lowercased()) else { return false }
    return Double(parts[0].replacingOccurrences(of: ",", with: "")) != nil
}

// " – Sam (example.com)" style Chrome profile suffix: a name followed by a
// parenthesised domain. Never part of a meeting name.
func isProfileSuffix(_ component: String) -> Bool {
    guard let open = component.firstIndex(of: "("), component.hasSuffix(")") else { return false }
    let inner = component[component.index(after: open)..<component.index(before: component.endIndex)]
    return inner.contains(".") && !inner.contains(" ")
}

public func cleanMeetingWindowTitle(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let separators = CharacterSet(charactersIn: "\u{2013}\u{2014}|")   // en dash, em dash, pipe
    let parts = raw
        .replacingOccurrences(of: " - ", with: "\u{2013}")   // fold the ASCII form in
        .components(separatedBy: separators)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .filter { !windowTitleFurniture.contains($0.lowercased()) }
        .filter { !chromeTabStateFurniture.contains($0.lowercased()) }
        .filter { !isMemorySizeComponent($0) }
        .filter { !isProfileSuffix($0) }
    guard !parts.isEmpty else { return nil }
    let title = parts.joined(separator: " - ")
    // Absurd titles are a sign we grabbed the wrong window; a doc title is not
    // a place for a paragraph.
    return title.count <= 120 ? title : String(title.prefix(120))
}
