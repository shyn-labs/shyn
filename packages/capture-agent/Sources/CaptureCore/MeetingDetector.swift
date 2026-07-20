import Foundation

public enum MeetingState: String, Sendable { case idle, candidate, recording, ended }

public struct MeetingSignal: Sendable {
    public let micActive: Bool, systemAudioActive: Bool, meetingAppFrontmost: Bool
    public init(micActive: Bool, systemAudioActive: Bool, meetingAppFrontmost: Bool) {
        self.micActive = micActive; self.systemAudioActive = systemAudioActive
        self.meetingAppFrontmost = meetingAppFrontmost
    }
}

public struct MeetingDetector: Sendable {
    public private(set) var state: MeetingState = .idle
    private var audioSince: Double? = nil       // when both audio signals first went active
    private var candidateAt: Double? = nil      // when we entered .candidate
    private var lastAudioAt: Double? = nil      // last step at which audio was observed active
    public init() {}

    // Audio-based primary trigger.
    //   CONTINUATION (recording): either side keeps it alive — one party
    //     listening silently for a while is normal mid-meeting.
    //   START: two live sides (mic AND system) trigger from ANY app — that's
    //     the conservative gate that avoids recording a lone YouTube video.
    //     BUT a listen-only meeting (you muted, being briefed) has no live
    //     mic, so that gate alone silently drops exactly the meetings you most
    //     want kept. So meetingAppFrontmost is finally wired in as intended:
    //     when a recognized meeting app is frontmost, sustained INCOMING audio
    //     alone starts recording. The meeting-app gate keeps false positives
    //     (background video/music) out while rescuing muted briefings.
    public mutating func step(signal s: MeetingSignal, now: Double, config c: MeetingConfig) -> MeetingState {
        let audio = state == .recording
            ? s.micActive || s.systemAudioActive
            : (s.micActive && s.systemAudioActive)
                || (s.systemAudioActive && s.meetingAppFrontmost)
        switch state {
        case .idle, .ended:
            state = .idle
            if audio {
                audioSince = audioSince ?? now
                if now - (audioSince ?? now) >= Double(c.candidateSeconds) {
                    state = .candidate; candidateAt = now
                }
            } else { audioSince = nil }
        case .candidate:
            if !audio { state = .idle; audioSince = nil; candidateAt = nil }
            // Strictly greater: the user gets the FULL grace window to cancel;
            // recording starts on the first tick after it elapses.
            else if now - (candidateAt ?? now) > Double(c.graceSeconds) {
                state = .recording; lastAudioAt = now
            }
        case .recording:
            if audio { lastAudioAt = now }
            // Silence is measured from the last audio-active observation, not
            // from the first silent tick — poll gaps count toward the 60s.
            else if now - (lastAudioAt ?? now) >= Double(c.endSilenceSeconds) {
                state = .ended; audioSince = nil; candidateAt = nil; lastAudioAt = nil
            }
        }
        return state
    }

    public mutating func cancel() {
        state = .idle; audioSince = nil; candidateAt = nil; lastAudioAt = nil
    }
}
