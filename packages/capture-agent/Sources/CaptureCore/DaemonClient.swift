import Foundation
import Network

public final class DaemonClient: Sendable {
    public let socketPath: String
    public init(socketPath: String) { self.socketPath = socketPath }

    public func call(method: String, params: [String: Any]) async throws -> [String: Any] {
        let conn = NWConnection(to: .unix(path: socketPath), using: .tcp)
        defer { conn.cancel() }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            let once = OnceResumer(c)
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready: once.resume(nil)
                case .failed(let e): once.resume(e)
                // A local unix socket has no network conditions to wait out:
                // .waiting means the connect failed (daemon down/restarting/
                // socket missing) and would otherwise suspend the caller
                // FOREVER — verified live: it permanently hung the meeting
                // agent's tick loop during a `shyn install` daemon restart.
                // Fail fast; callers retry on their next tick.
                case .waiting(let e): once.resume(e)
                default: break
                }
            }
            conn.start(queue: .global())
        }
        let req: [String: Any] = ["jsonrpc": "2.0", "id": Int.random(in: 1...1_000_000),
                                  "method": method, "params": params]
        var data = try JSONSerialization.data(withJSONObject: req)
        data.append(0x0A)
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { e in
                e == nil ? c.resume() : c.resume(throwing: e!)
            })
        }
        var buf = Data()
        while !buf.contains(0x0A) {
            let chunk: Data = try await withCheckedThrowingContinuation { c in
                conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { d, _, done, e in
                    if let e { c.resume(throwing: e) }
                    else if let d, !d.isEmpty { c.resume(returning: d) }
                    else { c.resume(throwing: done
                        ? DaemonError.closed : DaemonError.empty) }
                }
            }
            buf.append(chunk)
        }
        let line = buf.prefix(while: { $0 != 0x0A })
        guard let obj = try JSONSerialization.jsonObject(with: line) as? [String: Any]
        else { throw DaemonError.badResponse }
        if let err = obj["error"] as? [String: Any] {
            throw DaemonError.rpc(message: (err["message"] as? String) ?? "rpc error")
        }
        return (obj["result"] as? [String: Any]) ?? [:]
    }

    public func ingest(_ p: IngestPayload) async throws {
        _ = try await call(method: "ingest", params: [
            "source": p.source, "uri": p.uri, "title": p.title,
            "ts": p.ts, "text": p.text, "meta": p.meta])
    }
    public func postStats(_ s: Stats) async throws {
        let data = try JSONEncoder().encode(s)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        _ = try await call(method: "captureStats", params: obj)
    }

    /// Anonymous usage event. Fire-and-forget by design: the daemon decides
    /// whether analytics is on at all (this agent never reads consent), and a
    /// telemetry failure must never surface to the caller or interrupt a
    /// capture. Every error is swallowed, including "daemon is down".
    ///
    /// `event` must be one of the names the daemon knows; an unrecognised one
    /// is dropped there rather than erroring, so agent and daemon can skew
    /// across an upgrade without breaking either.
    public func track(_ event: String, _ properties: [String: Any] = [:]) async {
        _ = try? await call(method: "analytics.track",
                            params: ["event": event, "properties": properties])
    }
}

public enum DaemonError: Error { case closed, empty, badResponse, rpc(message: String) }

// NWConnection may report .waiting then .failed (or several .waiting) for
// one connect attempt; a CheckedContinuation must resume exactly once.
private final class OnceResumer: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<Void, Error>?
    init(_ c: CheckedContinuation<Void, Error>) { cont = c }
    func resume(_ error: Error?) {
        lock.lock(); let c = cont; cont = nil; lock.unlock()
        guard let c else { return }
        if let error { c.resume(throwing: error) } else { c.resume() }
    }
}
