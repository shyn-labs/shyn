import AppKit
import AVFoundation
import UserNotifications
import WhisperKit
import CaptureCore

// shyn-meeting: ambient meeting transcription agent. Detects a live call
// (mic + system audio active, MeetingDetector), records both channels
// locally, transcribes with WhisperKit, ships ONLY the transcript text to
// the daemon, then purges the audio. Audio never crosses the socket.

let home = ProcessInfo.processInfo.environment["SHYN_HOME"]
    ?? (NSHomeDirectory() + "/Library/Application Support/shyn")
let configPath = home + "/capture.json"
let meetingTmp = URL(fileURLWithPath: home + "/meeting-tmp")
let client = DaemonClient(socketPath: home + "/shyn.sock")

let debugEnabled = ProcessInfo.processInfo.environment["SHYN_MEETING_DEBUG"] == "1"
func dbg(_ s: @autoclosure () -> String) {
    guard debugEnabled else { return }
    FileHandle.standardError.write(Data((s() + "\n").utf8))
}

guard #available(macOS 14.2, *) else {
    FileHandle.standardError.write(Data("shyn-meeting requires macOS 14.2+ (CoreAudio process tap)\n".utf8))
    exit(1)
}

// selftest: exercise the meeting wire path (assemble → payload → ingest →
// stats) without audio/TCC — mirrors shyn-capture's selftest.
if CommandLine.arguments.contains("selftest") {
    let segs = [
        TranscriptSegment(start: 0.0, speaker: .me, text: "hello everyone, shall we start the synthetic standup"),
        TranscriptSegment(start: 2.5, speaker: .others, text: "yes, agenda first please"),
        TranscriptSegment(start: 5.0, speaker: .me, text: "retention decision is due today"),
    ]
    let now = Int(Date().timeIntervalSince1970)
    let payload = meetingPayload(bundleId: "com.shyn.selftest", appName: "SelfTest",
                                 startEpoch: now - 300, endEpoch: now,
                                 transcript: assembleTranscript(segs))
    do {
        try await client.ingest(payload)
        var stats = MeetingStats()
        stats.state = "idle"; stats.meetingsCaptured = 1; stats.lastTranscribedTs = now
        try await client.postMeetingStats(stats)
        print("selftest OK: ingested \(payload.uri)")
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("selftest FAIL: \(error)\n".utf8)); exit(1)
    }
}

// User-visible notification at the grace boundary (consent: spec §semi-auto).
// UNUserNotificationCenter traps outside an .app bundle, so guard on identity.
func notify(_ title: String, _ body: String) {
    guard Bundle.main.bundleIdentifier != nil else { dbg("notify (no bundle): \(title)"); return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { granted, _ in
        guard granted else { return }
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

@available(macOS 14.2, *)   // AudioRecorder / process-tap floor
actor MeetingAgent {
    private var detector = MeetingDetector()
    private let recorder = AudioRecorder()
    private var buffer = RingBuffer<IngestPayload>(capacity: 20)
    private var stats = MeetingStats()
    private var transcribing = false

    // active session
    private var sessionDir: URL?
    private var sessionStart = 0
    private var sessionBundleId: String?
    private var sessionAppName = "Call"
    private var sessionWindowTitle: String?   // AX fallback title, preroll-time
    // Pre-roll verification (live finding 2026-07-11: device probes alone
    // spawned a phantom meeting from ambient noise — ambient mic-holders
    // like Granola/Hand Mirror keep the mic device "running" permanently).
    // Recording starts at candidate time, but the session only COMMITS once
    // both channels have shown sustained voice; otherwise it is purged.
    private var prerollStart: Double? = nil
    private var committed = false

    func tick() async {
        let cfg = MeetingConfig.load(from: configPath)       // hot-reload
        let capCfg = CaptureConfig.load(from: configPath)    // shared pausedUntil
        let now = Date().timeIntervalSince1970

        // `shyn meeting stop|cancel` control file (one-shot, consumed here).
        if let control = consumeMeetingControl(home: home) {
            switch control {
            // stop during an unverified pre-roll discards (nothing to keep).
            case .stop:   await endSession(transcribe: committed, cfg: cfg); detector.cancel()
            case .cancel: await endSession(transcribe: false, cfg: cfg); detector.cancel()
            }
            await postStats(state: "idle")
            return
        }

        // Pause / disabled / excluded-app: privacy first — cancel any live
        // recording (discard + purge) rather than keeping the tail.
        let paused = (capCfg.pausedUntil ?? 0) > now
        let excluded = await MainActor.run { () -> Bool in
            guard let id = frontmostAppInfo().bundleId else { return false }
            return cfg.excludeApps.contains(id)
        }
        if !cfg.enabled || paused || excluded {
            // Covers committed recordings AND unverified pre-rolls alike.
            if await recorder.recording { await endSession(transcribe: false, cfg: cfg) }
            detector.cancel()
            await postStats(state: paused ? "paused" : "idle")
            return
        }

        // SHYN_MEETING_FORCE_ACTIVE: terminal-smoke bypass (probes misread
        // outside a real gui/<uid> LaunchAgent session, like SP2's flag).
        let force = ProcessInfo.processInfo.environment["SHYN_MEETING_FORCE_ACTIVE"] == "1"
        let frontmost = await MainActor.run { meetingAppFrontmost() }
        let prev = detector.state
        let signal: MeetingSignal
        if prev == .recording, await recorder.recording {
            // Live-verification findings: while recording, our own taps keep
            // both devices "running" (probes useless), and peak-blip metering
            // kept sessions alive through typing — use sustained-voice
            // activity from the recorded audio. During .candidate the device
            // probes still drive the detector (the meter needs time to see
            // sustained voice; the commit gate below arbitrates instead).
            signal = MeetingSignal(
                micActive: recorder.meter.voiceActiveWithin(10, .mic),
                systemAudioActive: recorder.meter.voiceActiveWithin(10, .system),
                meetingAppFrontmost: frontmost)
        } else {
            signal = MeetingSignal(
                micActive: force || micActive(),
                systemAudioActive: force || systemAudioActive(),
                meetingAppFrontmost: frontmost)
        }

        let state = detector.step(signal: signal, now: now, config: cfg)
        if state != prev { dbg("state \(prev.rawValue) → \(state.rawValue)") }

        switch (prev, state) {
        case (_, .candidate) where prev != .candidate:
            notify("Meeting detected",
                   "Recording starts in \(cfg.graceSeconds)s — `shyn meeting cancel` to skip.")
            await startPreroll(cfg: cfg)
        case (.recording, .ended):
            // An unverified pre-roll that reaches .ended is a phantom: purge.
            await endSession(transcribe: committed, cfg: cfg)
        default: break
        }

        // Commit gate: the detector says .recording, but the session only
        // counts once BOTH channels have shown sustained voice at some point
        // since the pre-roll began (a real call has two live sides; music or
        // ambient noise doesn't voice the mic). Verification window extends
        // 30s past the grace so a slow "hello" still commits.
        if state == .recording, !committed, let started = prerollStart, sessionDir != nil {
            let age = now - started
            let micVoiced = recorder.meter.voiceActiveWithin(age, .mic)
            let sysVoiced = recorder.meter.voiceActiveWithin(age, .system)
            if micVoiced && sysVoiced {
                commitSession()
            } else if age > Double(cfg.graceSeconds) + 30 {
                dbg("verification failed (mic=\(micVoiced) sys=\(sysVoiced)) — phantom, purging")
                await endSession(transcribe: false, cfg: cfg)
                detector.cancel()
            }
        }

        // Hard cap on runaway sessions.
        if state == .recording, sessionDir != nil,
           now - Double(sessionStart) > Double(cfg.maxDurationMinutes) * 60 {
            dbg("max duration reached — ending")
            await endSession(transcribe: committed, cfg: cfg)
            detector.cancel()
        }

        await postStats(state: transcribing ? "transcribing" : state.rawValue)
    }

    // Starts recording at candidate time (grace audio is part of the meeting
    // when it commits, purged otherwise). Deliberately NO "Recording"
    // notification and no stats.session* here — those are commit-time.
    private func startPreroll(cfg: MeetingConfig) async {
        let start = Int(Date().timeIntervalSince1970)
        let dir = meetingTmp.appendingPathComponent("session-\(start)")
        let info = await MainActor.run { frontmostAppInfo() }
        do {
            recorder.meter.reset()
            try await recorder.start(sessionDir: dir)
            sessionDir = dir; sessionStart = start
            sessionBundleId = info.bundleId; sessionAppName = info.name
            // Grabbed at preroll while the call window is likely frontmost;
            // by upload time a browser could be on another tab.
            sessionWindowTitle = await MainActor.run { meetingWindowTitle(bundleId: info.bundleId) }
            prerollStart = Double(start); committed = false
            stats.tcc.audio = true
            dbg("preroll → \(dir.path)")
        } catch {
            dbg("recorder start failed: \(error)")
            stats.tcc.audio = false
            detector.cancel()
        }
    }

    private func commitSession() {
        committed = true
        stats.sessionStartedAt = sessionStart
        stats.sessionApp = sessionAppName
        notify("Recording meeting", "\(sessionAppName) — `shyn meeting stop` to end early.")
        dbg("committed (voice verified on both channels)")
    }

    private func endSession(transcribe: Bool, cfg: MeetingConfig) async {
        guard let dir = sessionDir, let urls = await recorder.stop() else { return }
        let start = sessionStart
        let end = Int(Date().timeIntervalSince1970)
        let bundleId = sessionBundleId, appName = sessionAppName
        let windowTitle = sessionWindowTitle
        sessionDir = nil
        sessionWindowTitle = nil
        prerollStart = nil
        committed = false
        stats.sessionStartedAt = nil
        stats.sessionApp = nil
        guard transcribe else { purgeAudio(sessionDir: dir); dbg("canceled — audio purged"); return }

        transcribing = true
        defer { transcribing = false }
        // Post the honest state up front: transcription (incl. first-run
        // model download) can take minutes, and ticks queue behind it.
        await postStats(state: "transcribing")
        let segs = await transcribeMeeting(mic: urls.mic, system: urls.system,
                                           model: cfg.whisperModel,
                                           modelDir: URL(fileURLWithPath: home + "/models/whisperkit"))
        let transcript = assembleTranscript(segs)
        guard !transcript.isEmpty else {
            // Nothing recognizable — drop the session, still purge the audio.
            purgeAudio(sessionDir: dir); dbg("empty transcript — dropped"); return
        }
        // Stamp precedence (spec 2026-07-23): EventKit match → preroll
        // window title → plain "appName meeting · date".
        let stamp = await calendarStamp(startEpoch: start, endEpoch: end)
        let payload = meetingPayload(bundleId: bundleId, appName: appName,
                                     startEpoch: start, endEpoch: end, transcript: transcript,
                                     eventTitle: stamp?.title ?? windowTitle,
                                     attendees: stamp?.attendees ?? [])
        if await ship(payload) {
            purgeAudio(sessionDir: dir)   // byte-honest: audio gone on ingest ack
            stats.meetingsCaptured += 1
            stats.lastTranscribedTs = end
            dbg("shipped \(payload.uri); audio purged")
        } else {
            // Daemon down: transcript is buffered (retried on later ticks);
            // audio stays until ship succeeds or the 24h orphan sweep.
            dbg("daemon down — transcript buffered, audio kept")
        }
    }

    // Drains the ring buffer plus the new payload; false if the new payload
    // could not be delivered (it is then buffered for the next attempt).
    private func ship(_ payload: IngestPayload? = nil) async -> Bool {
        var delivered = true
        for queued in buffer.drain() + (payload.map { [$0] } ?? []) {
            do { try await client.ingest(queued) }
            catch {
                buffer.append(queued)
                if queued.uri == payload?.uri { delivered = false }
            }
        }
        return delivered
    }

    private func postStats(state: String) async {
        stats.state = state
        stats.modelReady = whisperModelPresent(
            model: MeetingConfig.load(from: configPath).whisperModel,
            modelDir: URL(fileURLWithPath: home + "/models/whisperkit"))
        stats.tcc.mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        stats.tcc.calendar = calendarAccessAuthorized()
        _ = await ship()   // retry any buffered transcripts opportunistically
        try? await client.postMeetingStats(stats)
    }

    func setWhisperDownloading(_ downloading: Bool) async {
        stats.whisperDownloading = downloading ? true : nil
        await postStats(state: detector.state.rawValue)
    }

    // Pre-download the CURRENTLY CONFIGURED Whisper model (spec 2026-07-23):
    // one path covers first onboarding AND a model switch from the popover
    // (status-ui writes capture.json; checked every tick). The gate
    // serializes downloads and backs off after a failure.
    private var predownloadGate = ModelPredownloadGate()

    func maybeKickPredownload() async {
        let cfg = MeetingConfig.load(from: configPath)
        let dir = URL(fileURLWithPath: home + "/models/whisperkit")
        guard predownloadGate.shouldKick(
            present: whisperModelPresent(model: cfg.whisperModel, modelDir: dir),
            now: Int(Date().timeIntervalSince1970)) else { return }
        let model = cfg.whisperModel
        await setWhisperDownloading(true)
        Task.detached(priority: .background) {
            let ok = (try? await WhisperKit(WhisperKitConfig(model: model, downloadBase: dir))) != nil
            await self.finishPredownload(success: ok)
        }
    }

    private func finishPredownload(success: Bool) async {
        predownloadGate.finished(success: success, now: Int(Date().timeIntervalSince1970))
        await setWhisperDownloading(false)
    }
}

@available(macOS 14.2, *)
@MainActor func runAgent() -> Never {
    // Orphaned audio from a crashed session: purge anything >24h old at startup.
    sweepOrphanAudio(root: meetingTmp)

    let agent = MeetingAgent()

    // Onboarding (spec SP6): prime the permission prompts at startup —
    // macOS only lists an app in a privacy pane after its first request,
    // so a fresh install's Settings deep-link would otherwise open a pane
    // where shyn-meeting doesn't appear. Mic prompts immediately (expected
    // right after install); the throwaway tap registers
    // kTCCServiceAudioCapture. Both are no-ops once granted.
    Task {
        _ = await AVCaptureDevice.requestAccess(for: .audio)
        if #available(macOS 14.2, *) {
            let warmDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("shyn-tap-warmup-\(ProcessInfo.processInfo.processIdentifier)")
            try? FileManager.default.createDirectory(at: warmDir, withIntermediateDirectories: true)
            let tap = SystemAudioTapRecorder()
            try? tap.start(to: warmDir.appendingPathComponent("warm.wav"))
            tap.stop()
            try? FileManager.default.removeItem(at: warmDir)
        }
    }

    // Onboarding (spec SP6) + model switches (spec 2026-07-23): the Whisper
    // pre-download is tick-driven so the FIRST meeting never stalls for
    // minutes and a popover model switch starts downloading immediately.
    // whisperDownloading drives the busy state in both flows.
    Task {
        while true {
            await agent.tick()
            await agent.maybeKickPredownload()
            try? await Task.sleep(for: .seconds(3))
        }
    }

    // Keep the main runloop alive (spike finding: XPC/AppKit callback delivery
    // starves without it; same pattern as shyn-capture).
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApplication.shared.run()
    fatalError("NSApplication.run returned")
}
if #available(macOS 14.2, *) { runAgent() }   // unreachable else: guarded above
