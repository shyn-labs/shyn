import AppKit
import ApplicationServices
import CoreGraphics
import CaptureCore

// Process entry point, kept in its own file and behind @main so the rest of
// the target has NO top-level code. A Swift module with top-level statements
// cannot be imported, so the Agent actor — the whole capture decision loop —
// had no test target until 2026-09-21. shyn-meeting made the same move on
// 2026-09-07 (see its Entry.swift). Keep this file free of logic.
@main
struct CaptureMain {
    static func main() async {
        if CommandLine.arguments.contains("selftest") { await runSelfTest() }
        await runAgent()
    }

    // selftest: exercise the DaemonClient JSON-RPC socket path end-to-end
    // without needing a GUI session / TCC (which only a real LaunchAgent gets).
    // Ships one synthetic screen payload through decide() + ingest + postStats,
    // then exits.
    private static func runSelfTest() async -> Never {
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

    @MainActor
    private static func runAgent() async -> Never {
        let agent = Agent(sink: client, configPath: configPath)
        // Say "alive" before the first tick has any reason to ship.
        await agent.start()
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { _ in Task.detached { await agent.tick() } }
        // Detached on purpose. This function is main-actor isolated and ends
        // in NSApplication.run(), which never returns — a plain `Task {}` here
        // would inherit the main actor and queue behind that blocking call
        // forever. Verified 2026-09-21 against a fake daemon socket: one
        // heartbeat at start, then silence, until these were detached.
        Task.detached {
            while true {
                try? await Task.sleep(for: .seconds(CaptureConfig.load(from: configPath).pollIntervalSeconds))
                await agent.tick()
            }
        }
        Task.detached {
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
        exit(0)
    }
}
