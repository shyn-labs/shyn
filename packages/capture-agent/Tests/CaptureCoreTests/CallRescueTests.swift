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
