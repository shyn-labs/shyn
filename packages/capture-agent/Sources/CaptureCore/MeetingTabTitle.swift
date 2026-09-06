import Foundation

// The meeting name, recovered from shyn's OWN browser index rather than from a
// calendar.
//
// Lived 2026-09-06. Every meeting for a week shipped as "Google Chrome
// meeting" and read to the user as "shyn isn't capturing meetings". Both upper
// rungs of the naming ladder were down at once: the local EventKit copy had
// gone stale (an event moved that morning was still on the previous day), and
// shyn-meeting sat at Accessibility auth_value=0, so the window-title rung had
// never once fired on that machine. Meanwhile the Chrome reader had already
// ingested `Meet – Q3 Business Metrics + Roadmap v1` one second before the
// recording began. The right title was in the corpus the whole time.
//
// So this rung outranks the calendar deliberately (decision 2026-09-06): a tab
// that was open is evidence of what happened, where a calendar entry is a
// record of what was *planned*. A stale entry, a declined invite, or a 3-hour
// Reclaim "🏠 Personal Commitment" hold that merely overlaps would otherwise
// win over the real name. EventKit keeps its other job — the attendee roster
// that decides far-side speaker labels — which is independent of the title.
//
// Needs no permission of its own: the browser reader already runs, so this
// works for the no-calendar user and the denied-Accessibility user alike.

public struct BrowserVisit: Sendable {
    public let ts: Int
    public let title: String
    public let url: String
    public init(ts: Int, title: String, url: String) {
        self.ts = ts; self.title = title; self.url = url
    }
}

// The join that starts the recording happens a beat before the detector fires,
// and the tab title only resolves to the real name AT join — 1s before the
// session start in the lived case. Short on purpose: a wide lead-in would let
// the previous call name this one.
public let tabTitleLeadInSeconds = 180

/// Best conferencing tab title seen during a recording session, or nil.
///
/// Last usable visit wins: Meet shows a generic lobby title ("Meet") until the
/// call is joined, then swaps in the meeting name, so later is truer.
public func conferencingTabTitle(visits: [BrowserVisit],
                                 sessionStart: Int, sessionEnd: Int) -> String? {
    visits
        .filter { $0.ts >= sessionStart - tabTitleLeadInSeconds && $0.ts <= sessionEnd }
        .filter { visit in
            let url = visit.url.lowercased()
            return conferencingLinkMarkers.contains { url.contains($0) }
        }
        .sorted { $0.ts < $1.ts }
        // cleanMeetingWindowTitle is the same furniture-stripper the window
        // rung uses, and it already returns nil for a bare "Meet"/"Zoom
        // Meeting" — the generic-only → nil rule earns its keep twice.
        .compactMap { cleanMeetingWindowTitle($0.title) }
        .last
}
