import Testing
import Foundation
@testable import CaptureCore

// Live-verification finding (2026-07-10): when the daemon socket is absent
// or not accepting (e.g. mid-`shyn install` restart), NWConnection parks in
// .waiting — which never resolves for a local unix socket — and the caller's
// continuation suspended FOREVER, permanently hanging the agent's tick loop.
// call() must fail fast so callers retry on their next tick.
@Test func daemonClientFailsFastWhenSocketMissing() async {
    let client = DaemonClient(socketPath: NSTemporaryDirectory() + "nope-\(UUID()).sock")
    let outcome = await withTaskGroup(of: String.self) { group in
        group.addTask {
            do { _ = try await client.call(method: "status", params: [:]); return "succeeded" }
            catch { return "threw" }
        }
        group.addTask {
            try? await Task.sleep(for: .seconds(3))
            return "hung"
        }
        let first = await group.next()!
        group.cancelAll()
        return first
    }
    #expect(outcome == "threw")
}
