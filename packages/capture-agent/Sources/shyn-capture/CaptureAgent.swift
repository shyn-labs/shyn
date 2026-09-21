import AppKit
import ApplicationServices
import CoreGraphics
import CaptureCore

let home = ProcessInfo.processInfo.environment["SHYN_HOME"]
    ?? (NSHomeDirectory() + "/Library/Application Support/shyn")
let configPath = home + "/capture.json"
let client = DaemonClient(socketPath: home + "/shyn.sock")

// Opt-in tick tracing (SHYN_CAPTURE_DEBUG=1) — writes one stderr line per tick
// decision. Off by default so the agent stays silent in production.
let debugEnabled = ProcessInfo.processInfo.environment["SHYN_CAPTURE_DEBUG"] == "1"
func dbg(_ s: @autoclosure () -> String) {
    guard debugEnabled else { return }
    FileHandle.standardError.write(Data(logLine(s()).utf8))
}

// What the agent needs from the daemon. DaemonClient is the real one; tests
// record instead of connecting.
protocol CaptureSink: Sendable {
    func ingest(_ p: IngestPayload) async throws
    func postStats(_ s: Stats) async throws
}
extension DaemonClient: CaptureSink {}

// The machine-state probes tick() consults before it reads anything. Each is
// a CG/AX/IOKit call that only answers correctly inside a real GUI session,
// which a test is not — so they are injected, and `.live` is the production
// set.
struct AgentEnv: Sendable {
    var isScreenLocked: @Sendable () -> Bool
    var idleSeconds: @Sendable () -> Double
    var frontWindow: @Sendable () -> FrontWindow?
    var isSecureInputActive: @Sendable () -> Bool
    var axTrusted: @Sendable () -> Bool
    var screenGranted: @Sendable () -> Bool

    static let live = AgentEnv(
        isScreenLocked: { shyn_capture.isScreenLocked() },
        idleSeconds: { shyn_capture.idleSeconds() },
        frontWindow: { shyn_capture.frontWindow() },
        isSecureInputActive: { shyn_capture.isSecureInputActive() },
        axTrusted: { AXIsProcessTrusted() },
        screenGranted: { CGPreflightScreenCaptureAccess() })
}

actor Agent {
    var state = PipelineState()
    var buffer = RingBuffer<IngestPayload>(capacity: 200)
    var lastFire = Date.distantPast
    var lastTitleSig = ""
    private let sink: any CaptureSink
    private let configPath: String
    private let env: AgentEnv

    init(sink: any CaptureSink, configPath: String, env: AgentEnv = .live) {
        self.sink = sink; self.configPath = configPath; self.env = env
    }

    // Called once at launch: the daemon learns the agent is alive, and reads
    // its TCC grants, before the first tick has any reason to ship.
    func start() async { await heartbeat() }

    // Every tick ends in a heartbeat, whatever the observation decided. The
    // daemon marks the screen agent "reporting" from post recency alone, and
    // this used to post only inside ship() — so a locked screen, an idle desk,
    // or an excluded app in front made a healthy agent read as dead after two
    // minutes. Three diagnoses were spent on that (2026-09-06, -07, -21).
    // Alive and capturing are different facts.
    func tick() async {
        // debounce: focus-change and poll both funnel here
        guard Date().timeIntervalSince(lastFire) >= 2.0 else { return }
        lastFire = Date()
        await observe()
        await heartbeat()
    }

    private func heartbeat() async {
        // Surface TCC grant state in status (spec §4) so a missing Screen
        // Recording / Accessibility grant is visible, not silent.
        state.stats.tcc = TccStatus(ax: env.axTrusted(), screen: env.screenGranted())
        try? await sink.postStats(state.stats)
    }

    private func observe() async {
        let config = CaptureConfig.load(from: configPath)   // hot-reload by re-reading
        // SHYN_CAPTURE_FORCE_ACTIVE bypasses the lock/idle presence gate. Needed
        // only for terminal-launched smoke tests: a nohup-backgrounded process
        // isn't in the console GUI session, so CGSessionCopyCurrentDictionary()
        // and CGEventSource idle misreport (locked=true / huge idle). A real
        // LaunchAgent in gui/<uid> reads them correctly, so this is never set in
        // production.
        let forceActive = ProcessInfo.processInfo.environment["SHYN_CAPTURE_FORCE_ACTIVE"] == "1"
        if !forceActive, env.isScreenLocked() || env.idleSeconds() > 300 {
            dbg("skip: locked=\(env.isScreenLocked()) idle=\(Int(env.idleSeconds()))"); return
        }
        guard let win = env.frontWindow() else { dbg("skip: no frontWindow"); return }
        lastTitleSig = titleSignature(bundleId: win.bundleId, title: win.title)
        let secure = env.isSecureInputActive()
        let now = Int(Date().timeIntervalSince1970)

        // Gate BEFORE any content read (spec §3.2 step 1)
        if gate(bundleId: win.bundleId, title: win.title, config: config,
                now: Double(now), secureInput: secure) != nil {
            // run through decide() with empty text purely to count the skip
            let e = CaptureEvent(bundleId: win.bundleId, appName: win.appName,
                                 windowTitle: win.title, text: "", ts: now)
            _ = decide(event: e, config: config, state: &state, secureInput: secure)
            return
        }
        var method = "ax"
        var raw = axText(pid: win.pid)?.text ?? ""
        let axChars = normalize(raw).count
        if needsOcr(bundleId: win.bundleId, axCharCount: axChars) {
            raw = await ocrText(for: win); method = "ocr"
        }
        dbg("win=\(win.bundleId) '\(win.title)' ax=\(axChars) method=\(method) final=\(normalize(raw).count)")
        let event = CaptureEvent(bundleId: win.bundleId, appName: win.appName,
                                 windowTitle: win.title, text: raw, ts: now, method: method)
        guard let payload = decide(event: event, config: config,
                                   state: &state, secureInput: secure) else { dbg("decide: skip"); return }
        dbg("SHIP \(payload.uri)")
        await ship(payload)
    }

    // Cheap title-watch trigger: fires a full capture when the frontmost
    // window's (normalized) title changes — catching intra-app navigation
    // (email->email, page->page) that neither the app-switch notification nor
    // the 30s heartbeat reliably sample. tick() owns updating lastTitleSig.
    func onTitlePoll() async {
        guard let w = env.frontWindow() else { return }
        guard titleSignature(bundleId: w.bundleId, title: w.title) != lastTitleSig else { return }
        await tick()
    }

    private func ship(_ payload: IngestPayload) async {
        for queued in buffer.drain() + [payload] {
            do { try await sink.ingest(queued) }
            catch { buffer.append(queued) }   // daemon down → re-buffer, retry next tick
        }
        // The stats post that used to live here is now the heartbeat at the
        // end of every tick, ship or no ship.
    }
}
