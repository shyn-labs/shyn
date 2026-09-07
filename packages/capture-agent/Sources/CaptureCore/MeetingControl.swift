import Foundation

// One-shot control signal for the meeting agent, written by `shyn meeting
// <start|stop|cancel>` and by the menu bar, consumed (deleted) by the agent on
// its next tick.
//
// `start` exists because detection is audio-shaped and always will be: the
// commit gate requires far-side voice on the SYSTEM channel, deliberately, so
// an idle browser tab or a calendar entry can never commit silence. That rule
// is right for calls and useless for a room — an in-person meeting puts every
// voice on the microphone and nothing on the system channel, so no amount of
// tuning would ever make the detector notice it. An explicit start IS the
// verification, and it is the only way to record a room, a speakerphone, or
// anything else shyn cannot hear itself into.
//
// Parsing lives in CaptureCore rather than next to the file IO because that is
// where the test target can reach it — stop/cancel had been parsed in
// shyn-meeting since Task 10 and never had a single test.

public enum MeetingAction: String, Sendable { case start, stop, cancel }

public struct MeetingControl: Equatable, Sendable {
    public let action: MeetingAction
    /// Only ever set for `.start`: what to call the recording. The detector
    /// has no tab or calendar entry to name a manual session after.
    public let title: String?
    public init(action: MeetingAction, title: String?) {
        self.action = action
        self.title = title
    }
}

/// Longest title we will put on a document. Matches cleanMeetingWindowTitle's
/// ceiling for the same reason: a title is not a place for a paragraph.
let maxManualTitleLength = 120

/// Parses a control file's bytes. Returns nil for anything unrecognised —
/// garbage, an empty file, or a verb from a newer CLI than this agent. The
/// caller deletes the file regardless, so an unparseable control is skipped
/// rather than retried forever.
public func parseMeetingControl(_ data: Data) -> MeetingControl? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let raw = obj["action"] as? String,
          let action = MeetingAction(rawValue: raw) else { return nil }
    guard action == .start else { return MeetingControl(action: action, title: nil) }
    let trimmed = (obj["title"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let t = trimmed, !t.isEmpty else { return MeetingControl(action: .start, title: nil) }
    return MeetingControl(action: .start,
                          title: t.count <= maxManualTitleLength
                              ? t : String(t.prefix(maxManualTitleLength)))
}
