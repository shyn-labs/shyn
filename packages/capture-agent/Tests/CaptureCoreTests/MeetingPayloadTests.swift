import Foundation
import Testing
@testable import CaptureCore

// Wire contract shared with packages/daemon/test/meeting-e2e.test.ts —
// change both together.

private let START = 1_783_700_000, END = 1_783_701_800

@Test func unstampedPayloadKeepsTheFrozenShape() {
    let p = meetingPayload(bundleId: "us.zoom.xos", appName: "Zoom",
                           startEpoch: START, endEpoch: END, transcript: "Me: hello")
    #expect(p.source == "meeting")
    #expect(p.uri.hasPrefix("meeting://us.zoom.xos/"))
    #expect(p.title.hasPrefix("Zoom meeting · "))
    #expect(p.meta["app"] == "Zoom")
    #expect(p.meta["durationSec"] == "1800")
    #expect(p.meta["channels"] == "me,others")
    #expect(p.meta["calTitle"] == nil)          // no stamp → no calendar keys
    #expect(p.meta["attendees"] == nil)
}

@Test func calendarStampRewritesTitleAndAddsMeta() {
    let p = meetingPayload(bundleId: "us.zoom.xos", appName: "Zoom",
                           startEpoch: START, endEpoch: END, transcript: "Me: hello",
                           eventTitle: "Sprint standup",
                           attendees: ["Maya R", "Dev P", "Sam K"])
    #expect(p.title.hasPrefix("Sprint standup · Zoom · "))
    #expect(p.meta["calTitle"] == "Sprint standup")
    #expect(p.meta["attendees"] == "Maya R, Dev P, Sam K")
    #expect(p.meta["attendeeCount"] == "3")
    #expect(p.uri.hasPrefix("meeting://us.zoom.xos/"))   // uri scheme unchanged
    #expect(p.meta["durationSec"] == "1800")
}

@Test func stampWithoutAttendeesStillTitles() {
    // Window-title fallback path: a title but no attendee list.
    let p = meetingPayload(bundleId: nil, appName: "Call",
                           startEpoch: START, endEpoch: END, transcript: "Me: hi",
                           eventTitle: "Acme <> Globex sync", attendees: [])
    #expect(p.title.hasPrefix("Acme <> Globex sync · Call · "))
    #expect(p.meta["calTitle"] == "Acme <> Globex sync")
    #expect(p.meta["attendees"] == nil)          // empty list → key absent
    #expect(p.meta["attendeeCount"] == nil)
}

// "Where was I" at the level the machine already knows for free: the time zone
// it was set to while the meeting ran. Singapore in September 2026 read +08:00
// in every timestamp and nowhere a search could find it.
@Test func payloadCarriesTheTimeZoneItWasRecordedIn() {
    let sg = TimeZone(identifier: "Asia/Singapore")!
    let p = meetingPayload(bundleId: nil, appName: "Recording",
                           startEpoch: START, endEpoch: END, transcript: "hello",
                           timeZone: sg)
    #expect(p.meta["tz"] == "Asia/Singapore")
    #expect(p.meta["tzOffset"] == "+08:00")
    let kolkata = TimeZone(identifier: "Asia/Kolkata")!
    #expect(meetingPayload(bundleId: nil, appName: "Recording", startEpoch: START, endEpoch: END,
                           transcript: "x", timeZone: kolkata).meta["tzOffset"] == "+05:30")
}

@Test func ingestParamsWithoutSpeakersAreExactlyTodays() {
    let p = IngestPayload(source: "meeting", uri: "meeting://x/1", title: "t", ts: 1, text: "Me: hi", meta: ["a": "b"])
    #expect(Set(ingestParams(p).keys) == ["source", "uri", "title", "ts", "text", "meta"])
}

@Test func speakersAndSelfSampleTravelWithTheTranscript() {
    let p = IngestPayload(source: "meeting", uri: "meeting://x/1", title: "t", ts: 1, text: "Speaker 1: hi",
                          meta: [:],
                          speakers: [SpeakerPayload(label: "S1", channel: "mic", embedding: "AACAPw==", speechSec: 40)],
                          selfSample: VoiceSamplePayload(embedding: "AACAPw==", speechSec: 31))
    let d = ingestParams(p)
    let s = d["speakers"] as? [[String: Any]]
    #expect(s?.first?["label"] as? String == "S1")
    #expect(s?.first?["channel"] as? String == "mic")
    #expect((d["selfSample"] as? [String: Any])?["speechSec"] as? Double == 31)
}

@Test func aBufferedPayloadKeepsItsSpeakers() {
    // Review focus 5: daemon down → RingBuffer → retry must not lose speakers.
    var buf = RingBuffer<IngestPayload>(capacity: 2)
    buf.append(IngestPayload(source: "meeting", uri: "u", title: "t", ts: 1, text: "x", meta: [:],
                             speakers: [SpeakerPayload(label: "S1", channel: "system", embedding: "", speechSec: 1)]))
    #expect(buf.drain().first?.speakers?.count == 1)
}
