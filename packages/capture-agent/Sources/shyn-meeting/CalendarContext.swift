import AppKit
import EventKit
import CaptureCore

// Calendar stamping (spec 2026-07-23-eventkit-meeting-stamping): reads the
// LOCAL EventKit store at upload time — macOS Calendar's own sync (Google/
// Exchange/iCloud) is the transport, shyn makes no network call. Degrades to
// nil at every step: no permission, no synced calendars, no event covering
// ≥ half the session. Attendees are display names, never emails.

struct CalendarStamp {
    let title: String
    let attendees: [String]
}

func calendarAccessAuthorized() -> Bool {
    EKEventStore.authorizationStatus(for: .event) == .fullAccess
}

// The Calendars privacy pane lists an app only after its FIRST request —
// there is no drag-in (+) for this pane, unlike Accessibility — so the
// prompt is primed once at startup, same pattern (and reason) as the mic
// warmup in runAgent. Bundle-guarded: prompting traps outside an .app.
func primeCalendarPrompt() async {
    guard Bundle.main.bundleIdentifier != nil,
          EKEventStore.authorizationStatus(for: .event) == .notDetermined else { return }
    _ = try? await EKEventStore().requestFullAccessToEvents()
}

func calendarStamp(startEpoch: Int, endEpoch: Int) async -> CalendarStamp? {
    let store = EKEventStore()
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: break
    case .notDetermined:
        // Prompting traps outside an .app bundle (same trap as
        // UNUserNotificationCenter — see notify()); only request when bundled.
        guard Bundle.main.bundleIdentifier != nil else { return nil }
        guard (try? await store.requestFullAccessToEvents()) == true else { return nil }
    default:
        return nil
    }
    let events = store.events(matching: store.predicateForEvents(
        withStart: Date(timeIntervalSince1970: Double(startEpoch)),
        end: Date(timeIntervalSince1970: Double(endEpoch)),
        calendars: nil))
    let candidates = events.map {
        CalendarCandidate(title: $0.title ?? "",
                          start: Int($0.startDate.timeIntervalSince1970),
                          end: Int($0.endDate.timeIntervalSince1970),
                          attendeeCount: $0.attendees?.count ?? 0,
                          isAllDay: $0.isAllDay)
    }
    guard let i = matchMeetingEvent(sessionStart: startEpoch, sessionEnd: endEpoch,
                                    candidates: candidates),
          !candidates[i].title.isEmpty else { return nil }
    return CalendarStamp(title: candidates[i].title,
                         attendees: (events[i].attendees ?? []).compactMap(\.name).compactMap(attendeeDisplayName))
}

// Window-title fallback (spec phase 1b): when EventKit has nothing — the
// Google-only-calendar user — the meeting app's window title (Zoom windows and
// Meet tabs usually carry the meeting name) is better than "Zoom meeting ·
// date". Opportunistic: reads only if the user granted shyn-meeting
// Accessibility; never prompts, returns nil otherwise.
//
// Live finding 2026-08-04: reading ONLY the focused window returned nil for a
// real Meet call (the frontmost window at preroll was a different Chrome
// window), so all windows are scanned, focused one first, and each candidate
// goes through cleanMeetingWindowTitle — a title of "Meet" is worth nothing.
@MainActor func meetingWindowTitle(bundleId: String?) -> String? {
    guard AXIsProcessTrusted(), let bid = bundleId,
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: bid).first
    else { return nil }
    let ax = AXUIElementCreateApplication(app.processIdentifier)

    var candidates: [AXUIElement] = []
    var focused: CFTypeRef?
    if AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &focused) == .success,
       let f = focused, CFGetTypeID(f) == AXUIElementGetTypeID() {
        candidates.append(f as! AXUIElement)
    }
    var windows: CFTypeRef?
    if AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &windows) == .success,
       let list = windows as? [AXUIElement] {
        candidates.append(contentsOf: list)
    }

    for window in candidates {
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success,
              let raw = title as? String,
              let cleaned = cleanMeetingWindowTitle(raw)
        else { continue }
        return cleaned
    }
    return nil
}
