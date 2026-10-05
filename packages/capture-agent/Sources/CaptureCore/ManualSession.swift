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

/// What a detector transition does to the recording.
public enum DetectorAction: Equatable, Sendable { case none, startPreroll, discardPreroll, endSession }

/// A live manual session owns the recorder, so no detector transition may
/// start, discard or end a session underneath it. The detector keeps stepping
/// (its state is still reported) but is not obeyed. Until 2026-10-05 it was:
/// shyn's own mic tap could look like a call, a second pre-roll reset the
/// commit flag, and the commit gate purged a 55-second in-person recording as
/// a phantom.
public func detectorAction(prev: MeetingState, state: MeetingState, manualLive: Bool) -> DetectorAction {
    guard !manualLive else { return .none }
    switch (prev, state) {
    case (_, .candidate) where prev != .candidate: return .startPreroll
    case (.candidate, .idle): return .discardPreroll
    case (.recording, .ended): return .endSession
    default: return .none
    }
}
