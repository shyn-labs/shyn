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
                         attendees: (events[i].attendees ?? []).compactMap(\.name))
}

// Window-title fallback (spec phase 1b): when EventKit has nothing — the
// Google-only-calendar user — the meeting app's focused-window title (Zoom
// windows and Meet tabs usually carry the meeting name) is better than
// "Zoom meeting · date". Opportunistic: reads only if the user granted
// shyn-meeting Accessibility; never prompts, returns nil otherwise.
@MainActor func meetingWindowTitle(bundleId: String?) -> String? {
    guard AXIsProcessTrusted(), let bid = bundleId,
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: bid).first
    else { return nil }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var win: CFTypeRef?
    guard AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &win) == .success,
          let w = win, CFGetTypeID(w) == AXUIElementGetTypeID()
    else { return nil }
    var title: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success,
          let t = title as? String, !t.isEmpty
    else { return nil }
    return t
}
