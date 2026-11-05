import Foundation

/// "Did the last run of this agent die?" without the agent being able to tell us.
///
/// A crashing process cannot report its own crash, so the agent leaves a small
/// file while it is running and removes it on a clean exit. Found on the NEXT
/// start, it means the previous run never reached a clean exit: a crash, a
/// SIGKILL, a power loss. The next run then reports `agent_crashed` through the
/// daemon (which sends it only if the user has opted in).
///
/// Clean exit includes SIGTERM and SIGINT, which is how launchd stops an agent
/// for an upgrade, a reload or a logout; without that, every upgrade would read
/// as a crash. Same idea as the diarizer's "crashed last attempt" breadcrumb,
/// at process scope.
public enum RunBreadcrumb {
    public static func path(home: String, agent: String) -> String { home + "/agent-\(agent).running" }

    /// Records this run and says whether the previous one died. A breadcrumb
    /// whose pid is still alive is another live instance, not a corpse.
    @discardableResult
    public static func begin(home: String, agent: String, pid: Int32 = getpid(),
                             isAlive: (Int32) -> Bool = { kill($0, 0) == 0 }) -> Bool {
        let p = path(home: home, agent: agent)
        var previousDied = false
        if let data = FileManager.default.contents(atPath: p) {
            let old = Int32(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
            previousDied = !(old != nil && old != pid && isAlive(old!))
        }
        try? Data("\(pid)\n".utf8).write(to: URL(fileURLWithPath: p), options: .atomic)
        return previousDied
    }

    public static func end(home: String, agent: String) {
        try? FileManager.default.removeItem(atPath: path(home: home, agent: agent))
    }

    // The signal sources must outlive this call or the handlers vanish.
    nonisolated(unsafe) private static var sources: [DispatchSourceSignal] = []

    /// Removes the breadcrumb and exits 0 on SIGTERM / SIGINT.
    ///
    /// NOT on the main queue. Both agents sit inside NSApplication.run(), which
    /// is itself running as a main-queue job, and a serial queue runs nothing
    /// else while a job is active: a main-queue source never fires. Found by
    /// the fake-daemon gate on 2026-11-05 (the agent ignored SIGTERM and lived
    /// on, because the signal was set to SIG_IGN for the source to own). Same
    /// starvation as the heartbeat bug of 2026-09-21. The handler only unlinks a
    /// file and exits, so a background queue is safe.
    public static func endOnTerminate(home: String, agent: String,
                                      exit terminate: @escaping @Sendable (Int32) -> Void = { Foundation.exit($0) }) {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)   // let the dispatch source own it
            let s = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global(qos: .utility))
            s.setEventHandler { end(home: home, agent: agent); terminate(0) }
            s.resume()
            sources.append(s)
        }
    }
}
