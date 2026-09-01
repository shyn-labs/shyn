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
    private var suppressed = false              // no new candidate until a quiet step re-arms
    // One rescue-driven re-arm per unbroken audio episode. Spent when used,
    // restored only by a genuinely quiet step (which also ends the episode).
    private var rescueReArmAvailable = true
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
        // Suppression (cancelUntilQuiet): the signals that admitted the last
        // episode are usually STILL active right after a cancel — a meeting
        // app holds mic + system audio for the whole call — so re-arming on
        // time alone re-candidates ~10s later and re-notifies for as long as
        // the call lasts (observed live: one notification every ~57s). Only a
        // quiet observation ends the episode and re-arms detection.
        if suppressed {
            if audio { audioSince = nil; return state }
            suppressed = false
        }
        // A quiet step ends the episode: restore the one rescue re-arm.
        if !audio { rescueReArmAvailable = true }
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

    // cancel(), plus: stay idle until a step observes the audio signals quiet.
    // For cancels where the episode's signals are known to persist (phantom
    // purge, user skip, recorder failure) — plain cancel() there means instant
    // re-detection and another notification.
    public mutating func cancelUntilQuiet() {
        cancel(); suppressed = true
    }

    // Lift suppression on rescue evidence, without waiting for silence.
    //
    // cancelUntilQuiet re-arms only on a quiet observation, and a live call
    // never goes quiet — so a single wrong purge verdict disarmed detection
    // for the REST of the meeting (2026-08-31: 57 minutes lost after one bad
    // 40-second decision, nothing captured until the call ended).
    //
    // Bounded to once per unbroken audio episode. Unbounded, this would
    // resurrect the notification-spam bug cancelUntilQuiet exists to prevent:
    // rescue evidence that stays true through repeated purges would re-notify
    // every ~57s for a whole call.
    public mutating func noteRescueEvidence() {
        guard suppressed, rescueReArmAvailable else { return }
        rescueReArmAvailable = false
        suppressed = false
        audioSince = nil
    }
}
