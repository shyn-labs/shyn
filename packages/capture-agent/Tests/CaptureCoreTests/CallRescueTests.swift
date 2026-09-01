import Testing
import Foundation
@testable import CaptureCore

// Commit-gate rescue signals. Motivated by a live loss on 2026-08-31: a
// 60-minute "Biochar Roadmap Review" on Meet-in-Chrome was purged whole by
// the commit gate (`verification failed (mic=false sys=true) — phantom`).
// The user was a silent listener, and Chrome is deliberately absent from
// `meetingBundleIds` because being frontmost in a browser does not itself
// predict "in a call". These two predicates supply the evidence that the
// frontmost-app check cannot.

// MARK: - Which processes holding a mic input stream imply a call

@Test func conferencingCapableAcceptsBrowsersThatCarryCalls() {
    // Chrome runs audio in a helper process, so the real bundle id seen on
    // the CoreAudio process object is the helper, not the app.
    #expect(isConferencingCapableBundleId("com.google.Chrome"))
    #expect(isConferencingCapableBundleId("com.google.Chrome.helper"))
    #expect(isConferencingCapableBundleId("com.google.Chrome.helper.renderer"))
    #expect(isConferencingCapableBundleId("com.apple.Safari"))
    #expect(isConferencingCapableBundleId("com.brave.Browser"))
    #expect(isConferencingCapableBundleId("com.microsoft.edgemac"))
}

@Test func conferencingCapableAcceptsDedicatedMeetingApps() {
    #expect(isConferencingCapableBundleId("us.zoom.xos"))
    #expect(isConferencingCapableBundleId("com.microsoft.teams2"))
    // Slack holding a mic stream IS a huddle — a stronger claim than Slack
    // merely being frontmost, which the frontmost gate rightly rejects.
    #expect(isConferencingCapableBundleId("com.tinyspeck.slackmacgap"))
}

@Test func conferencingCapableRejectsAmbientMicHolders() {
    // The exact processes resident on the machine that lost the meeting:
    // both hold the input device permanently, which is why the DEVICE-level
    // probe carries almost no information here.
    #expect(!isConferencingCapableBundleId("com.granola.app"))
    #expect(!isConferencingCapableBundleId("com.flowvoice.wispr"))
    #expect(!isConferencingCapableBundleId("com.apple.Music"))
    #expect(!isConferencingCapableBundleId("com.apple.QuickTimePlayerX"))
    // shyn's own agent must never count as evidence of a call.
    #expect(!isConferencingCapableBundleId("day.shyn.meeting"))
}

@Test func conferencingCapablePrefixMatchIsAnchored() {
    // A prefix match must not be a substring match, or a lookalike bundle
    // id ("com.evil.com.google.Chrome") would pass.
    #expect(!isConferencingCapableBundleId("com.evil.com.google.Chrome"))
    #expect(!isConferencingCapableBundleId(""))
}

// MARK: - Which in-progress calendar events imply a live call

private func event(_ title: String, attendees: Int, minutes: Int,
                   declined: Bool = false, notes: String = "") -> LiveCallCandidate {
    LiveCallCandidate(title: title, attendeeCount: attendees,
                      durationSeconds: minutes * 60, selfDeclined: declined,
                      conferencingText: notes)
}

@Test func liveCallEventAcceptsARealVideoCall() {
    // The event that should have rescued the lost meeting: recurring, 60
    // minutes, 6+ attendees, Meet link in the notes.
    #expect(isLikelyLiveCallEvent(event(
        "Biochar Roadmap Review", attendees: 8, minutes: 60,
        notes: "Join with Google Meet: https://meet.google.com/ost-vbnf-nkm")))
}

@Test func liveCallEventRejectsFocusBlocksAndSoloHolds() {
    // Real entries from the calendar that must never commit a recording:
    // a long "Occupied" hold and a solo personal block. Both are in
    // progress at times when music or a video could be playing.
    #expect(!isLikelyLiveCallEvent(event("Occupied", attendees: 0, minutes: 180)))
    #expect(!isLikelyLiveCallEvent(event("Personal Commitment", attendees: 1, minutes: 40)))
    #expect(!isLikelyLiveCallEvent(event("Email cleanup and actions", attendees: 1, minutes: 30)))
}

@Test func liveCallEventRequiresAConferencingLink() {
    // 2+ attendees is not enough on its own: an in-person meeting on the
    // calendar plus a video playing must not commit.
    #expect(!isLikelyLiveCallEvent(event(
        "Standup (in the office)", attendees: 6, minutes: 30)))
    #expect(isLikelyLiveCallEvent(event(
        "Standup", attendees: 6, minutes: 30,
        notes: "https://teams.microsoft.com/l/meetup-join/19%3ameeting")))
    #expect(isLikelyLiveCallEvent(event(
        "Standup", attendees: 6, minutes: 30, notes: "https://zoom.us/j/9876543210")))
}

@Test func liveCallEventRejectsDeclinedAndDayLongEntries() {
    // Declining is an explicit statement that the user is not on this call.
    #expect(!isLikelyLiveCallEvent(event(
        "All Hands", attendees: 30, minutes: 60, declined: true,
        notes: "https://meet.google.com/abc-defg-hij")))
    // A day-long block with a link attached is a holder, not a live call.
    #expect(!isLikelyLiveCallEvent(event(
        "Offsite", attendees: 20, minutes: 8 * 60,
        notes: "https://meet.google.com/abc-defg-hij")))
}

// MARK: - Helper -> responsible app (observed in Granola's shipped map)

@Test func conferencingCapableResolvesNonPrefixHelperIds() {
    // These are the cases a prefix rule SILENTLY misses: the helper process
    // that actually holds the audio stream shares no prefix with the app it
    // belongs to. Granola ships a hardcoded map for exactly these; without
    // it the rescue signal is simply absent for Safari, FaceTime, Webex,
    // Zoom Phone and Teams' module host.
    #expect(isConferencingCapableBundleId("com.apple.WebKit.GPU"))          // → Safari
    #expect(isConferencingCapableBundleId("com.apple.avconferenced"))       // → FaceTime
    #expect(isConferencingCapableBundleId("Cisco-Systems.Spark"))           // → Webex
    #expect(isConferencingCapableBundleId("us.zoom.ZoomPhone"))             // → Zoom
    #expect(isConferencingCapableBundleId("us.zoom.ZoomHybridConf"))        // → Zoom
    #expect(isConferencingCapableBundleId("com.microsoft.teams2.modulehost"))
}

@Test func conferencingCapableAcceptsTheObservedShynAndChromeIds() {
    // Observed live 2026-09-01 during a real Meet call: Chrome's audio
    // helper is what appears in the CoreAudio process list.
    #expect(isConferencingCapableBundleId("com.google.Chrome.helper"))
    // shyn's OWN agent holds an input stream while recording. Its real
    // bundle id (observed, previously guessed wrong) must never count as
    // evidence of a call.
    #expect(!isConferencingCapableBundleId("com.shyn.meeting"))
}

// MARK: - Which app the meeting belongs to

@Test func meetingAppIsTheOneHoldingAudioNotTheOneInFront() {
    // Lived 2026-09-01: a verification recording was titled "Ghostty" because
    // the terminal was frontmost at pre-roll. The general case is worse than
    // the test artifact — taking notes, reading mail or sitting in Slack
    // during a call is normal, so the title would routinely name whatever the
    // user glanced at rather than the call.
    #expect(conferencingHolder(from: ["com.apple.Music", "com.google.Chrome.helper"])
            == "com.google.Chrome.helper")
    #expect(conferencingHolder(from: ["us.zoom.xos"]) == "us.zoom.xos")
}

@Test func meetingAppIgnoresOurOwnRecorder() {
    // shyn-meeting holds an input stream for the whole session; naming the
    // meeting after ourselves would be absurd and is easy to do by accident.
    #expect(conferencingHolder(from: ["com.shyn.meeting"]) == nil)
    #expect(conferencingHolder(from: ["com.shyn.meeting", "us.zoom.xos"]) == "us.zoom.xos")
}

@Test func meetingAppIsNilWhenNothingConferencingHoldsAudio() {
    // Caller falls back to the frontmost app, which is the old behaviour and
    // still the best available guess when there is nothing better.
    #expect(conferencingHolder(from: ["com.apple.Music", "com.apple.QuickTimePlayerX"]) == nil)
    #expect(conferencingHolder(from: []) == nil)
}

// MARK: - Playback must never look like a call

@Test func browserPlaybackIsNotEvidenceOfACall() {
    // Found by asking "what if music or YouTube is running?" (2026-09-01).
    // Reading the OUTPUT stream made any browser audio count as a call, so a
    // YouTube video alone satisfied `sysVoiced && rescue` and would have
    // committed a phantom recording — recording the user when no call was
    // happening. That is a worse failure than the data loss this whole
    // change set out to fix.
    //
    // INPUT is the honest signal. A call holds the microphone; playback does
    // not. Verified live twice on 2026-09-01: Chrome keeps its input stream
    // open through a MUTED Meet call, which is the exact case the output
    // check was wrongly introduced to cover.
    #expect(!callEvidence(inputHolders: [], outputHolders: ["com.google.Chrome.helper"]))
    #expect(!callEvidence(inputHolders: [], outputHolders: ["com.apple.Music"]))
    #expect(!callEvidence(inputHolders: [], outputHolders: ["com.apple.QuickTimePlayerX"]))
}

@Test func holdingTheMicIsEvidenceOfACall() {
    // The muted-listener case: Chrome holds input, user never speaks.
    #expect(callEvidence(inputHolders: ["com.google.Chrome.helper"], outputHolders: []))
    // Realistic: on a call AND playing music at the same time.
    #expect(callEvidence(inputHolders: ["com.google.Chrome.helper"],
                         outputHolders: ["com.apple.Music"]))
}

@Test func ourOwnRecorderHoldingTheMicIsNotACall() {
    // shyn-meeting holds input for the whole session. If that counted, every
    // recording would justify itself and the gate would never purge anything.
    #expect(!callEvidence(inputHolders: ["com.shyn.meeting"], outputHolders: []))
}
