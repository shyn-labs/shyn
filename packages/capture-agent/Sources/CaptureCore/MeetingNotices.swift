import Foundation

// User-visible notices about the recording duration cap.
//
// The cap ended recordings silently until 2026-09-08 — a dbg() line behind
// SHYN_MEETING_DEBUG=1 was the only trace, so the sole visible signal was the
// live card vanishing from the menu bar. For an auto-detected call that is
// survivable, because the detector re-arms and the call re-commits within a
// minute. For a manually started recording it is not: endSession clears the
// manual flag, and a room has no system-channel voice, so the start gate can
// never fire again. Click Start at 09:00 for an all-day event and at 12:00 it
// stops for good, quietly, while you assume it is still running.
//
// Two moments, two notices, and the START one matters more. Knowing the limit
// when a recording begins is planning information; learning it three hours in
// is an incident report. The start notice already existed and named only the
// session, so the limit is added there rather than announced only at the end.
//
// The wording lives here, in one place, because two notices describing one
// setting that disagree would read as the setting having changed between them.

public struct MeetingNotice: Equatable, Sendable {
    public let title: String
    public let body: String
    public init(title: String, body: String) { self.title = title; self.body = body }
}

/// How the cap is spoken: whole hours when it divides cleanly, minutes when it
/// does not. Someone who configured 90 must not be told "1h".
public func capDurationText(_ minutes: Int) -> String {
    minutes > 0 && minutes % 60 == 0 ? "\(minutes / 60)h" : "\(minutes) min"
}

/// Posted when a recording commits. Carries the name, the limit, and the way out.
public func recordingStartedNotice(name: String, maxDurationMinutes: Int) -> MeetingNotice {
    let limit = capDurationText(maxDurationMinutes)
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    // No name is a real case (a manual start with no title, nothing worth
    // naming in front); the limit still has to be stated, without a dangling
    // separator in front of it.
    let lead = trimmed.isEmpty ? "" : "\(trimmed) — "
    return MeetingNotice(
        title: "Recording meeting",
        body: "\(lead)stops automatically at \(limit). `shyn meeting stop` to end early.")
}

/// Posted when the cap ends a recording. The two paths differ in what happens
/// next, so they differ in what they promise: a call resumes on its own, a
/// manual session does not and needs the user to act.
public func maxDurationNotice(manual: Bool, maxDurationMinutes: Int) -> MeetingNotice {
    let limit = capDurationText(maxDurationMinutes)
    let next = manual
        ? "Nothing resumes on its own — start again if you are still going."
        : "If the call is still live, recording will resume within a minute."
    return MeetingNotice(
        title: "Recording stopped at \(limit)",
        body: "The transcript is being written. \(next) "
            + "Raise `meeting.maxDurationMinutes` in capture.json to change the limit.")
}
