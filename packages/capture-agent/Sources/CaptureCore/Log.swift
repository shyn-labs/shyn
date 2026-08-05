import Foundation

// Every agent line goes to stderr, which launchd routes to
// ~/Library/Logs/shyn/{meeting,capture}.log. Those lines carried no clock
// until 2026-08-05, which made a real transcriber failure undatable — the log
// held one bare "[transcriber] failed: modelsUnavailable(...)" with no way to
// tell whether it was that afternoon or the week before.
//
// Local time on purpose (with offset): these logs are read next to a calendar
// and a meeting the user remembers attending, never across timezones.
// Formatter is built per call — log volume is low (debug lines are gated, real
// failures are rare) and this keeps the helper free of shared mutable state.
public func logLine(_ message: String) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone.current
    f.formatOptions = [.withInternetDateTime]
    return "\(f.string(from: Date())) \(message)\n"
}
