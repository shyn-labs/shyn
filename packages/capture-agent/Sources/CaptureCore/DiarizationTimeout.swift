import Foundation

/// Upper bound on one session's diarization. Spike: 2 h of audio diarizes in
/// ~16 s, so hitting this means something is wedged, and the transcript ships.
public let diarizationTimeoutSeconds: Double = 600

private final class RaceState: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false
    private var work: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    /// True for exactly one caller: the first to settle the race.
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if settled { return false }
        settled = true
        return true
    }
    func set(work: Task<Void, Never>, timer: Task<Void, Never>) {
        lock.lock(); self.work = work; self.timer = timer; lock.unlock()
    }
    func cancelBoth() {
        lock.lock(); let w = work, t = timer; lock.unlock()
        w?.cancel(); t?.cancel()
    }
}

/// Runs `op`, returning its value, or nil if `seconds` pass first. Unlike a task
/// group, it does not wait for `op` after the limit: work that ignores
/// cancellation (a CoreML call) is abandoned, so the caller moves on at once.
/// An error from `op` before the limit is rethrown.
public func withTimeout<T: Sendable>(seconds: Double,
                                     _ op: @escaping @Sendable () async throws -> T) async throws -> T? {
    let state = RaceState()
    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T?, Error>) in
        let work = Task {
            do {
                let v = try await op()
                if state.claim() { cont.resume(returning: v); state.cancelBoth() }
            } catch {
                if state.claim() { cont.resume(throwing: error); state.cancelBoth() }
            }
        }
        let timer = Task {
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            if state.claim() { cont.resume(returning: nil); state.cancelBoth() }
        }
        state.set(work: work, timer: timer)
    }
}
