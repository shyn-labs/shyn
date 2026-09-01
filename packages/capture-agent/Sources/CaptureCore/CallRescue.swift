import Foundation

// Commit-gate rescue signals (live loss 2026-08-31). The gate requires
// `sysVoiced && (micVoiced || <rescue>)`, and for a browser call the only
// rescue term available was `meetingAppFrontmost` — which excludes browsers
// on purpose, because being frontmost in Chrome does not itself predict a
// call. So a silent listener on Meet had NO rescue at all, and a real
// 60-minute meeting was purged as a phantom.
//
// These two predicates supply evidence the frontmost check cannot. Both are
// pure so the gate's behaviour is testable; the OS reads that feed them live
// in MeetingProbes/CalendarContext (untestable by nature) stay thin.

// MARK: - Conferencing-capable processes

// Bundle-id prefixes whose process HOLDING A MIC INPUT STREAM implies a call.
// This is a different and much stronger claim than the frontmost check:
// Slack is frontmost all day (so it is rightly absent from meetingBundleIds)
// but it is not capturing the mic all day, so a Slack huddle qualifies here.
//
// Browsers are listed by their app prefix; Chrome runs audio inside
// "Google Chrome Helper" (com.google.Chrome.helper[.renderer]), which a
// prefix match catches. Ambient mic-holders (Granola, Wispr Flow) are
// deliberately absent — they are the reason the DEVICE-level probe carries
// almost no information on this machine.
public let conferencingBundlePrefixes: [String] = [
    "com.google.Chrome",            // + .helper, .helper.renderer
    "com.apple.Safari",
    "com.apple.WebKit",             // Safari's GPU/content processes
    "org.mozilla.firefox",
    "com.microsoft.edgemac",
    "company.thebrowser.Browser",   // Arc
    "com.brave.Browser",
    "com.vivaldi.Vivaldi",
    "com.operasoftware.Opera",
    "us.zoom.xos",
    "com.microsoft.teams2",
    "com.microsoft.teams",
    "Cisco-Systems.Spark",
    "com.cisco.webexmeetingsapp",
    "com.apple.FaceTime",
    "com.tinyspeck.slackmacgap",    // huddles
]

// Helpers whose bundle id shares NO prefix with the app they belong to, so
// the prefix rule above silently misses them — the rescue signal would just
// be absent for Safari, FaceTime, Webex and Zoom Phone rather than visibly
// broken. Transcribed from the equivalent map Granola ships, which exists
// for exactly this reason.
public let conferencingHelperApp: [String: String] = [
    "com.apple.WebKit.GPU": "com.apple.Safari",
    "com.apple.avconferenced": "com.apple.FaceTime",
    "Cisco-Systems.Spark": "Cisco-Systems.Spark",
    "us.zoom.ZoomPhone": "us.zoom.xos",
    "us.zoom.ZoomHybridConf": "us.zoom.xos",
    "com.microsoft.teams2.modulehost": "com.microsoft.teams2",
]
let conferencingHelperIds: Set<String> = Set(conferencingHelperApp.keys)

/// True when a process with this bundle id, observed holding a mic input
/// stream, is evidence that a call is happening.
///
/// Anchored prefix match, not a substring match: a lookalike id that merely
/// CONTAINS a known one ("com.evil.com.google.Chrome") must not pass. A
/// prefix may only be followed by a dot, so "com.google.Chromeium" is also
/// rejected while "com.google.Chrome.helper" is accepted.
public func isConferencingCapableBundleId(_ bundleId: String) -> Bool {
    guard !bundleId.isEmpty else { return false }
    if conferencingHelperIds.contains(bundleId) { return true }
    for prefix in conferencingBundlePrefixes {
        if bundleId == prefix { return true }
        if bundleId.hasPrefix(prefix + ".") { return true }
    }
    return false
}

/// Which of the processes currently holding audio is the meeting?
///
/// The app HOLDING THE AUDIO is a far better answer than the app in front.
/// Lived 2026-09-01: a verification recording came out titled "Ghostty"
/// because the terminal was frontmost at pre-roll — and the real-world case
/// is worse than the test artifact, because taking notes or reading mail
/// during a call is normal. Naming the record after whatever the user
/// glanced at makes it unfindable by the name they know it by.
///
/// Same lesson `MeetingWindowTitle` already learned for the window title:
/// do not trust focus. Returns nil when nothing conferencing-capable holds
/// audio, and the caller falls back to frontmost.
public func conferencingHolder(from bundleIds: [String]) -> String? {
    bundleIds.first { isConferencingCapableBundleId($0) }
}

/// Is a call actually happening, judged from who holds which audio streams?
///
/// INPUT ONLY, and the reason matters. Reading the OUTPUT stream made any
/// browser audio count as a call: a YouTube video alone satisfied
/// `sysVoiced && rescue` and would have committed a phantom recording,
/// recording the user while no call was happening. That is a worse failure
/// than the data loss this change set out to fix, and it is exactly the
/// music/playback phantom the gate has always existed to prevent.
///
/// A call holds the MICROPHONE; playback does not. The output check was
/// added on the theory that a muted listener releases the mic — verified
/// live twice on 2026-09-01 that this is false: Chrome keeps its input
/// stream open through a muted Meet call. So the theory was wrong and the
/// signal it justified was harmful.
///
/// `outputHolders` is accepted but deliberately unused, so the decision to
/// ignore it is visible at the call site rather than silently absent.
public func callEvidence(inputHolders: [String], outputHolders: [String]) -> Bool {
    _ = outputHolders
    return conferencingHolder(from: inputHolders) != nil
}

// MARK: - Live-call calendar events

/// An in-progress calendar event, reduced to what the rescue decision needs.
public struct LiveCallCandidate: Sendable {
    public let title: String
    public let attendeeCount: Int
    public let durationSeconds: Int
    public let selfDeclined: Bool
    /// Event url + notes + structured location, concatenated. Searched for a
    /// conferencing link; never stored, never logged.
    public let conferencingText: String
    public init(title: String, attendeeCount: Int, durationSeconds: Int,
                selfDeclined: Bool, conferencingText: String) {
        self.title = title; self.attendeeCount = attendeeCount
        self.durationSeconds = durationSeconds; self.selfDeclined = selfDeclined
        self.conferencingText = conferencingText
    }
}

// Deliberately NOT reusing matchMeetingEvent's ">= half the session" rule.
// At commit time the session is ~40 seconds old, so every in-progress block
// covers it trivially — including the 3-hour "Occupied" holds that are
// really focus time. This predicate has to be specific about what a live
// VIDEO CALL looks like, not merely what a busy calendar looks like.
let maxLiveCallSeconds = 4 * 60 * 60

let conferencingLinkMarkers = [
    "meet.google.com",
    "zoom.us/j/",
    "zoom.us/my/",
    "teams.microsoft.com/l/meetup-join",
    "teams.live.com/meet",
    "webex.com/meet",
    "whereby.com/",
    "meet.jit.si/",
]

/// True when an in-progress event is strong enough evidence that the user is
/// on a video call right now to commit a recording on its word alone.
///
/// All four conditions are required, and each earns its place against a real
/// false positive: 2+ attendees (a solo block is not a call), not declined
/// (declining says outright the user is not on it), <= 4h (kills day holds
/// and "Occupied"), and an actual conferencing link (an in-person standup
/// plus a video playing must not commit).
public func isLikelyLiveCallEvent(_ c: LiveCallCandidate) -> Bool {
    guard c.attendeeCount >= 2 else { return false }
    guard !c.selfDeclined else { return false }
    guard c.durationSeconds > 0, c.durationSeconds <= maxLiveCallSeconds else { return false }
    return containsConferencingLink(c.conferencingText)
}

/// True when the text carries a joinable video-call link.
public func containsConferencingLink(_ text: String) -> Bool {
    guard !text.isEmpty else { return false }
    let lowered = text.lowercased()
    return conferencingLinkMarkers.contains { lowered.contains($0) }
}

// MARK: - The commit gate

public enum CommitDecision: Sendable, Equatable {
    /// Keep the session: verified as a real meeting.
    case commit
    /// Not proven yet, still inside the verification window.
    case wait
    /// Verification window elapsed with no evidence: discard the audio.
    case purge
}

// Verification runs 30s past the grace window so a slow "hello" still
// commits (the original rationale, kept).
let commitVerificationSlackSeconds = 30.0

/// Should this pre-roll become a kept session?
///
/// Far-side voice is mandatory in every branch: incoming audio is the one
/// thing a recording of a call must contain, and making it optional would
/// let a calendar entry or an idle browser tab commit silence. What changed
/// after 2026-08-31 is the OTHER half — the corroboration that the user is
/// really on this call:
///
///   - `micVoiced`   — the user spoke. Original signal.
///   - `micUnavailable` — the mic channel is dead, so its silence is
///     "unknown", not "no". Treating unknown as no purged real meetings.
///   - `rescue`      — external evidence (a conferencing app holding the mic,
///     a live call on the calendar). This is what a silent listener on a
///     BROWSER call has instead of a frontmost-app match, and its absence is
///     exactly what lost the 60-minute "Biochar Roadmap Review".
///
/// `.purge` is only ever returned after the window elapses, and never while
/// rescue evidence stands — a late join must still be able to commit.
public func commitDecision(sysVoiced: Bool, micVoiced: Bool, micUnavailable: Bool,
                           rescue: Bool, ageSeconds: Double,
                           graceSeconds: Int) -> CommitDecision {
    if sysVoiced && (micVoiced || micUnavailable || rescue) { return .commit }
    let deadline = Double(graceSeconds) + commitVerificationSlackSeconds
    return ageSeconds > deadline ? .purge : .wait
}
