import Foundation

// Transcription runs for tens of minutes on the ANE after a meeting ends,
// which is exactly when the user walks away. Without an assertion the display
// sleeps, the system follows, and WhisperKit pauses until the next wake: a
// 25-minute decode took 4h40m of wall time on 2026-09-05. This holds idle
// sleep off for the duration of a body and lets the caller log both clocks.
//
// A closed lid still sleeps a portable regardless of any assertion (Apple's
// rule, not ours); the popover says so while a transcription is running.

public struct SleepHoldToken: Sendable, Equatable {
    public let id: Int
    public init(id: Int) { self.id = id }
}

public protocol SleepHolder: Sendable {
    func hold(reason: String) -> SleepHoldToken
    func release(_ token: SleepHoldToken)
}

// The real one: ProcessInfo activities. `.userInitiated` also lifts App Nap
// throttling, which matters for a background agent doing sustained compute.
public final class ProcessInfoSleepHolder: SleepHolder, @unchecked Sendable {
    public static let shared = ProcessInfoSleepHolder()
    private let lock = NSLock()
    private var next = 0
    private var live: [Int: NSObjectProtocol] = [:]

    public func hold(reason: String) -> SleepHoldToken {
        let activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled], reason: reason)
        lock.lock(); defer { lock.unlock() }
        next += 1
        live[next] = activity
        return SleepHoldToken(id: next)
    }

    public func release(_ token: SleepHoldToken) {
        lock.lock()
        let activity = live.removeValue(forKey: token.id)
        lock.unlock()
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
    }
}

// Holds sleep off for exactly the body's lifetime, released on every exit
// path including a throw.
public func withSystemAwake<T>(holder: any SleepHolder = ProcessInfoSleepHolder.shared,
                               reason: String,
                               _ body: () async throws -> T) async rethrows -> T {
    let token = holder.hold(reason: reason)
    defer { holder.release(token) }
    return try await body()
}

// Awake time comes from the monotonic clock, which does not advance while
// the machine sleeps; wall time from the calendar clock, which does. Their
// gap is the sleep. Sub-2s skew is clock noise and is not reported.
// modelLoadSec, when known, is the fixed cost of bringing Whisper up — about
// a minute and a half for large-v3_turbo — which otherwise hides inside
// "awake" and makes a 10-second recording look like it decoded for 1m41s.
public func transcribeTimingLine(awakeSec: Double, wallSec: Double, modelLoadSec: Double? = nil) -> String {
    var line = "took \(fmtDuration(awakeSec)) awake · \(fmtDuration(wallSec)) wall"
    let asleep = wallSec - awakeSec
    if asleep >= 2 { line += " · asleep \(fmtDuration(asleep))" }
    if let load = modelLoadSec { line += " · model load \(fmtDuration(load))" }
    return line
}

public func fmtDuration(_ seconds: Double) -> String {
    let s = Int(seconds.rounded())
    let h = s / 3600, m = (s % 3600) / 60, r = s % 60
    return h > 0 ? String(format: "%dh%02dm%02ds", h, m, r) : String(format: "%dm%02ds", m, r)
}
