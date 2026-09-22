import Testing
import Foundation
@testable import CaptureCore

// A 75-minute meeting transcribes in ~25 awake minutes on this hardware and
// took 4h40m of wall time on 2026-09-05. The agent held no power assertion:
// the user walked away, the display slept, the system followed, and WhisperKit
// paused with it. Two things fix the two halves of that: hold idle sleep off
// while a decode runs, and log awake time next to wall time so the next
// report says which clock the hours went to.

final class RecordingSleepHolder: SleepHolder, @unchecked Sendable {
    var held: [String] = []
    var released = 0
    var live: Int { held.count - released }
    func hold(reason: String) -> SleepHoldToken { held.append(reason); return SleepHoldToken(id: held.count) }
    func release(_ token: SleepHoldToken) { released += 1 }
}

@Test func holdsSleepOffForTheWholeBodyAndReleasesAfter() async {
    let holder = RecordingSleepHolder()
    var liveInside = -1
    let result = await withSystemAwake(holder: holder, reason: "transcribing") {
        liveInside = holder.live
        return 42
    }
    #expect(result == 42)
    #expect(liveInside == 1)
    #expect(holder.live == 0)
    #expect(holder.held == ["transcribing"])
}

@Test func releasesTheHoldWhenTheBodyThrows() async {
    let holder = RecordingSleepHolder()
    struct Boom: Error {}
    await #expect(throws: Boom.self) {
        try await withSystemAwake(holder: holder, reason: "transcribing") { () throws -> Int in throw Boom() }
    }
    #expect(holder.live == 0)
}

@Test func timingLineNamesBothClocksAndTheGapWhenTheMacSlept() {
    // 25 awake minutes inside 4h40m of wall time — the 5 Sep shape.
    let line = transcribeTimingLine(awakeSec: 25 * 60 + 12, wallSec: 4 * 3600 + 40 * 60)
    #expect(line == "took 25m12s awake · 4h40m00s wall · asleep 4h14m48s")
}

@Test func timingLineStaysShortWhenTheClocksAgree() {
    let line = transcribeTimingLine(awakeSec: 1490, wallSec: 1491)
    // Sub-2s skew is clock noise, not sleep — say nothing about it.
    #expect(line == "took 24m50s awake · 24m51s wall")
}

// A 10-second recording took 1m41s: the Whisper model load is a fixed cost
// of about a minute and a half that the line was hiding inside "awake".
@Test func timingLineSeparatesModelLoadFromDecoding() {
    let line = transcribeTimingLine(awakeSec: 101, wallSec: 101, modelLoadSec: 90)
    #expect(line == "took 1m41s awake · 1m41s wall · model load 1m30s")
    // Without the load figure the line is unchanged (older call sites, tests).
    #expect(transcribeTimingLine(awakeSec: 101, wallSec: 101) == "took 1m41s awake · 1m41s wall")
}
