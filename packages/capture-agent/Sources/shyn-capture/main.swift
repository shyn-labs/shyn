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

actor Agent {
    var state = PipelineState()
    var buffer = RingBuffer<IngestPayload>(capacity: 200)
    var lastFire = Date.distantPast
    var lastTitleSig = ""

    func tick() async {
        // debounce: focus-change and poll both funnel here
        guard Date().timeIntervalSince(lastFire) >= 2.0 else { return }
        lastFire = Date()
        let config = CaptureConfig.load(from: configPath)   // hot-reload by re-reading
        // SHYN_CAPTURE_FORCE_ACTIVE bypasses the lock/idle presence gate. Needed
        // only for terminal-launched smoke tests: a nohup-backgrounded process
        // isn't in the console GUI session, so CGSessionCopyCurrentDictionary()
        // and CGEventSource idle misreport (locked=true / huge idle). A real
        // LaunchAgent in gui/<uid> reads them correctly, so this is never set in
        // production.
        let forceActive = ProcessInfo.processInfo.environment["SHYN_CAPTURE_FORCE_ACTIVE"] == "1"
        if !forceActive, isScreenLocked() || idleSeconds() > 300 {
            dbg("skip: locked=\(isScreenLocked()) idle=\(Int(idleSeconds()))"); return
        }
        guard let win = frontWindow() else { dbg("skip: no frontWindow"); return }
        lastTitleSig = titleSignature(bundleId: win.bundleId, title: win.title)
        let secure = isSecureInputActive()
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
        guard let w = frontWindow() else { return }
        guard titleSignature(bundleId: w.bundleId, title: w.title) != lastTitleSig else { return }
        await tick()
    }

    private func ship(_ payload: IngestPayload) async {
        for queued in buffer.drain() + [payload] {
            do { try await client.ingest(queued) }
            catch { buffer.append(queued) }   // daemon down → re-buffer, retry next tick
        }
        // Surface TCC grant state in status (spec §4) so a missing Screen
        // Recording / Accessibility grant is visible, not silent.
        state.stats.tcc = TccStatus(ax: AXIsProcessTrusted(),
                                    screen: CGPreflightScreenCaptureAccess())
        try? await client.postStats(state.stats)
    }
}

// selftest: exercise the DaemonClient JSON-RPC socket path end-to-end without
// needing a GUI session / TCC (which only a real LaunchAgent gets). Ships one
// synthetic screen payload through decide() + ingest + postStats, then exits.
if CommandLine.arguments.contains("selftest") {
    var st = PipelineState()
    let text = String(repeating: "selftest screen capture payload alpha bravo charlie. ", count: 4)
    let e = CaptureEvent(bundleId: "com.shyn.selftest", appName: "SelfTest",
                         windowTitle: "SelfTest Window",
                         text: text, ts: Int(Date().timeIntervalSince1970))
    guard let p = decide(event: e, config: .defaults, state: &st, secureInput: false) else {
        FileHandle.standardError.write(Data("selftest: decide returned nil\n".utf8)); exit(1)
    }
    do {
        try await client.ingest(p)
        st.stats.tcc = TccStatus(ax: AXIsProcessTrusted(), screen: CGPreflightScreenCaptureAccess())
        try await client.postStats(st.stats)
        print("selftest OK: ingested \(p.uri)")
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("selftest FAIL: \(error)\n".utf8)); exit(1)
    }
}

let agent = Agent()
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { _ in Task { await agent.tick() } }
Task {
    while true {
        try? await Task.sleep(for: .seconds(CaptureConfig.load(from: configPath).pollIntervalSeconds))
        await agent.tick()
    }
}
Task {
    while true {
        try? await Task.sleep(for: .seconds(max(1, CaptureConfig.load(from: configPath).titleWatchIntervalSeconds)))
        await agent.onTitlePoll()
    }
}
// Spike finding (spikes/capture-probe): a headless agent must establish a
// GUI (Aqua/WindowServer) session via .accessory before any CG/SCK call, or
// the first capture trips CGS_REQUIRE_INIT. .prohibited does NOT give a
// WindowServer connection, so OCR would crash — use .accessory (no Dock icon,
// no menu bar, but WindowServer-connected).
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()   // keeps the runloop alive for NSWorkspace notifications
