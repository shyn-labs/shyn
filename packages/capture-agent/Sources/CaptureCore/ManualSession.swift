import Foundation

// A manual recording exists because shyn could not hear the meeting itself: a
// room, a speakerphone, a talk. Two facts about it come from the user or from
// nowhere, and both used to be guessed badly.

/// Which app a manual session is filed under. A conferencing app holding call
/// audio is real evidence and wins (a manual start during a Zoom call the
/// detector missed). Otherwise there is no app — until 2026-09-21 the pre-roll
/// used whatever was frontmost when the user clicked Start, which filed a
/// Singapore bootcamp session under WhatsApp and two others under the menu bar
/// app itself.
public func manualSessionApp(holder: String?,
                             frontmost: (bundleId: String?, name: String)) -> (bundleId: String?, name: String) {
    holder == nil ? (nil, "Recording") : frontmost
}

/// Who was there. What the user typed beats the calendar roster; the roster
/// is the fallback when they typed nothing.
public func meetingAttendees(manual: [String], calendar: [String]) -> [String] {
    manual.isEmpty ? calendar : manual
}
