import Foundation

// Decides when the meeting agent kicks a background Whisper pre-download.
// Called every tick with "is the CURRENTLY CONFIGURED model on disk" — so a
// model switch in capture.json (status-ui writes it) is picked up the same
// way the startup download is: absent + idle → kick. One download at a
// time; a failed download backs off instead of retrying every 3s tick.
public struct ModelPredownloadGate: Sendable {
    private var inFlight = false
    private var lastFailureEpoch: Int? = nil
    private let cooldownSeconds: Int

    public init(cooldownSeconds: Int = 300) {
        self.cooldownSeconds = cooldownSeconds
    }

    public mutating func shouldKick(present: Bool, now: Int) -> Bool {
        guard !present, !inFlight else { return false }
        if let f = lastFailureEpoch, now - f < cooldownSeconds { return false }
        inFlight = true
        return true
    }

    public mutating func finished(success: Bool, now: Int) {
        inFlight = false
        lastFailureEpoch = success ? nil : now
    }
}
