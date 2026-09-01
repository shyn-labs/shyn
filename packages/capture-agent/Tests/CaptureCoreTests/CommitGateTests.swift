import Testing
import Foundation
@testable import CaptureCore

// The commit gate decides whether a pre-roll becomes a kept session. It was
// inline in MeetingAgent.tick() and therefore untestable, which is how the
// 2026-08-31 loss shipped: the gate purged a real 60-minute Meet call
// (`mic=false sys=true`) and no test could have caught it. Extracted here so
// both the rescue cases and the phantom cases it exists for are pinned.

private let grace = 10

// MARK: - What the gate must KEEP

@Test func commitsWhenBothChannelsAreVoiced() {
    // The ordinary two-sided call. Unchanged behaviour.
    #expect(commitDecision(sysVoiced: true, micVoiced: true, micUnavailable: false,
                           rescue: false, ageSeconds: 12, graceSeconds: grace) == .commit)
}

@Test func commitsASilentListenerWhenRescueEvidenceExists() {
    // THE 2026-08-31 REGRESSION. Far side voiced, user never spoke, and the
    // rescue term (browser holding the mic / a live call on the calendar)
    // is what the frontmost-app check could not supply for a browser call.
    #expect(commitDecision(sysVoiced: true, micVoiced: false, micUnavailable: false,
                           rescue: true, ageSeconds: 45, graceSeconds: grace) == .commit)
}

@Test func commitsWhenTheMicChannelCannotReport() {
    // micDeclaredDead means "unknown", not "silent". Two of the eight logged
    // purges were this: once the engine dies, micVoiced is structurally
    // incapable of ever being true, so requiring it purges every time.
    #expect(commitDecision(sysVoiced: true, micVoiced: false, micUnavailable: true,
                           rescue: false, ageSeconds: 45, graceSeconds: grace) == .commit)
}

// MARK: - What the gate must still PURGE

@Test func purgesIncomingAudioAloneWithNoCorroboration() {
    // The phantom the gate exists for: music or a video playing, nothing
    // else. No mic voice, no rescue evidence, deadline passed.
    #expect(commitDecision(sysVoiced: true, micVoiced: false, micUnavailable: false,
                           rescue: false, ageSeconds: 41, graceSeconds: grace) == .purge)
}

@Test func neverCommitsWithoutFarSideAudioHoweverStrongTheRescue() {
    // A calendar event or a mic-holding browser must NOT be able to commit a
    // recording on its own — "I skipped the call and left the tab open" is a
    // real case. Far-side voice stays mandatory.
    #expect(commitDecision(sysVoiced: false, micVoiced: true, micUnavailable: false,
                           rescue: true, ageSeconds: 45, graceSeconds: grace) == .purge)
    #expect(commitDecision(sysVoiced: false, micVoiced: false, micUnavailable: true,
                           rescue: true, ageSeconds: 45, graceSeconds: grace) == .purge)
}

// MARK: - Timing

@Test func waitsInsideTheVerificationWindowRatherThanPurging() {
    // A slow "hello" must still commit, so an unproven session inside the
    // window is .wait — never .purge.
    #expect(commitDecision(sysVoiced: true, micVoiced: false, micUnavailable: false,
                           rescue: false, ageSeconds: 20, graceSeconds: grace) == .wait)
    #expect(commitDecision(sysVoiced: false, micVoiced: false, micUnavailable: false,
                           rescue: false, ageSeconds: 5, graceSeconds: grace) == .wait)
}

@Test func purgesOnlyAfterGracePlusThirtySeconds() {
    // Boundary: the window is graceSeconds + 30, exclusive.
    #expect(commitDecision(sysVoiced: true, micVoiced: false, micUnavailable: false,
                           rescue: false, ageSeconds: 40, graceSeconds: grace) == .wait)
    #expect(commitDecision(sysVoiced: true, micVoiced: false, micUnavailable: false,
                           rescue: false, ageSeconds: 40.5, graceSeconds: grace) == .purge)
}

@Test func lateRescueStillCommitsAfterTheDeadline() {
    // Joining a call late, or the calendar probe warming up after the
    // deadline, must still rescue — the gate re-evaluates every tick and a
    // passed deadline is not a terminal verdict while evidence is arriving.
    #expect(commitDecision(sysVoiced: true, micVoiced: false, micUnavailable: false,
                           rescue: true, ageSeconds: 300, graceSeconds: grace) == .commit)
}
