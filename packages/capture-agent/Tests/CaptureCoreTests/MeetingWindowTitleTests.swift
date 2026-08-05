import Testing
import Foundation
@testable import CaptureCore

// Title shapes taken from a real Meet call on 2026-08-04 (meeting name
// replaced): its doc shipped as "Google Meet meeting · 4 Aug 2026 at 16:03"
// and could not be found by searching the name the user knew it by.
@Test func extractsMeetingNameFromChromePwaTitle() {
    #expect(cleanMeetingWindowTitle("Google Meet - Meet - Weekly Ops Review") == "Weekly Ops Review")
    #expect(cleanMeetingWindowTitle("Meet \u{2013} Weekly Ops Review") == "Weekly Ops Review")
}

@Test func rejectsGenericAndEmptyTitles() {
    #expect(cleanMeetingWindowTitle("Meet") == nil)
    #expect(cleanMeetingWindowTitle("Zoom Meeting") == nil)
    #expect(cleanMeetingWindowTitle("Google Chrome") == nil)
    #expect(cleanMeetingWindowTitle("   ") == nil)
    #expect(cleanMeetingWindowTitle(nil) == nil)
}

@Test func stripsBrowserChromeAndProfileSuffix() {
    #expect(cleanMeetingWindowTitle(
        "Platform Sync - Google Chrome \u{2013} Sam (example.com)") == "Platform Sync")
}

@Test func keepsHyphenatedMeetingNames() {
    // A recurring meeting name that contains its own separator.
    #expect(cleanMeetingWindowTitle("Sam <> Alex - Fortnightly") == "Sam <> Alex - Fortnightly")
}

@Test func capsAbsurdlyLongTitles() {
    let long = String(repeating: "a", count: 300)
    #expect(cleanMeetingWindowTitle(long)?.count == 120)
}

@Test func profileSuffixDetectionIsNarrow() {
    #expect(isProfileSuffix("Sam (example.com)"))
    // A parenthesised phrase is part of a meeting name, not a profile.
    #expect(!isProfileSuffix("Roadmap review (eng only)"))
}
