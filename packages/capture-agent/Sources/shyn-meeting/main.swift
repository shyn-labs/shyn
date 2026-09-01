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
let whisperModelDir = URL(fileURLWithPath: home + "/models/whisperkit")
let client = DaemonClient(socketPath: home + "/shyn.sock")

let debugEnabled = ProcessInfo.processInfo.environment["SHYN_MEETING_DEBUG"] == "1"
func dbg(_ s: @autoclosure () -> String) {
    guard debugEnabled else { return }
    FileHandle.standardError.write(Data(logLine(s()).utf8))
}

// Operator-visible: failures a user may have to act on (a dropped meeting, a
// refused permission) are NOT gated behind SHYN_MEETING_DEBUG. Verbose tracing
// stays in dbg().
func logErr(_ s: String) {
    FileHandle.standardError.write(Data(logLine(s).utf8))
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
    // Transcription runs OFF the tick path: a long meeting takes minutes to
    // hours, and running it inline froze detection and `shyn meeting stop`.
    // These track the in-flight, serialized transcription(s).
    private var pendingTranscriptions = 0
    private var transcribeTask: Task<Void, Never>? = nil
    private var transcribeProgress: Double? = nil

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
    // Whether a recognized meeting app was frontmost when this session was
    // admitted — the commit gate accepts incoming voice alone for those
    // (muted-listener meetings never voice the mic).
    private var sessionMeetingAppFrontmost = false
    // Calendar sweep (hourly): 0 means "never run", so the first tick does it.
    private var lastCalendarSync = 0
    private var calendarTask: Task<Void, Never>? = nil

    func tick() async {
        let cfg = MeetingConfig.load(from: configPath)       // hot-reload
        let capCfg = CaptureConfig.load(from: configPath)    // shared pausedUntil
        let now = Date().timeIntervalSince1970

        // `shyn meeting stop|cancel` control file (one-shot, consumed here).
        if let control = consumeMeetingControl(home: home) {
            switch control {
            // stop during an unverified pre-roll discards (nothing to keep).
            // cancelUntilQuiet, not cancel: the call the user just skipped is
            // still holding the devices — plain cancel re-detected it ~10s
            // later and notified again, defeating the skip.
            case .stop:   await endSession(transcribe: committed, cfg: cfg); detector.cancelUntilQuiet()
            case .cancel: await endSession(transcribe: false, cfg: cfg); detector.cancelUntilQuiet()
            }
            // `stop` hands transcription off to the background; reflect that
            // rather than flashing idle for a tick.
            await postStats(state: pendingTranscriptions > 0 ? "transcribing" : "idle")
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
        // Mic engine health: covers .candidate (pre-roll) and .recording alike —
        // the 2026-08-18 death happened DURING the grace window.
        if await recorder.recording { await recorder.ensureMicAlive() }
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

        // A purge suppresses detection until the audio goes quiet — which on a
        // live call is not until it ends. Rescue evidence lifts that once per
        // episode, so a wrong verdict costs 40s rather than the whole meeting.
        if detector.state == .idle, conferencingAppHoldingAudio() {
            detector.noteRescueEvidence()
        }
        let state = detector.step(signal: signal, now: now, config: cfg)
        if state != prev { dbg("state \(prev.rawValue) → \(state.rawValue)") }

        switch (prev, state) {
        case (_, .candidate) where prev != .candidate:
            notify("Meeting detected",
                   "Recording starts in \(cfg.graceSeconds)s — `shyn meeting cancel` to skip.")
            await startPreroll(cfg: cfg, meetingAppFrontmost: frontmost)
        case (.candidate, .idle):
            // Signals died during the grace window (call ended, device
            // released). Without this teardown the pre-roll leaked FOREVER:
            // every stop path requires .recording, so nothing ever stopped the
            // recorder (lived 2026-08-18 — a system-audio tap ran for 14+ min
            // after a call ended, growing 12MB/min with the agent "idle").
            logErr("[meeting] candidate dropped during grace — pre-roll discarded")
            await endSession(transcribe: false, cfg: cfg)
        case (.recording, .ended):
            // An unverified pre-roll that reaches .ended is a phantom: purge.
            await endSession(transcribe: committed, cfg: cfg)
        default: break
        }

        // Commit gate: the detector says .recording, but the session only
        // counts once voice is verified in the recorded audio. Mirrors the
        // START gate (MeetingDetector): a two-sided call voices both channels,
        // but a session admitted with a meeting app frontmost commits on
        // incoming voice alone — a muted/listening attendee never voices the
        // mic, and requiring it here purged exactly those meetings AND
        // re-notified every ~57s for the rest of the call (lived 2026-08-18).
        // Verification window extends 30s past the grace so a slow "hello"
        // still commits.
        if state == .recording, !committed, let started = prerollStart, sessionDir != nil {
            let age = now - started
            let micVoiced = recorder.meter.voiceActiveWithin(age, .mic)
            let sysVoiced = recorder.meter.voiceActiveWithin(age, .system)
            // Rescue is re-evaluated EVERY TICK, not snapshotted at preroll.
            // The snapshot was its own bug: alt-tabbing away from Zoom during
            // the grace window lost the term for the whole session, the same
            // failure class as the browser case below. OR-ed with the
            // snapshot so it only ever widens.
            var rescue = sessionMeetingAppFrontmost || frontmost
                || conferencingAppHoldingAudio()
            // Ordered cheapest-first: the calendar probe only runs when the
            // in-memory signals have already failed.
            if !rescue { rescue = await liveConferencingEventInProgress() }
            switch commitDecision(sysVoiced: sysVoiced, micVoiced: micVoiced,
                                  micUnavailable: await recorder.micDeclaredDead,
                                  rescue: rescue, ageSeconds: age,
                                  graceSeconds: cfg.graceSeconds) {
            case .commit:
                commitSession()
                await client.track("meeting_capture_committed",
                                   ["rescued": !micVoiced])
            case .wait: break
            case .purge:
                // cancelUntilQuiet: the devices that admitted this phantom are
                // still held (ambient mic-holder + music); plain cancel meant
                // re-candidate + re-notify ~10s later, forever.
                logErr("[meeting] verification failed (mic=\(micVoiced) sys=\(sysVoiced)"
                       + " rescue=\(rescue)) — phantom, purging")
                // A purge is indistinguishable from "no meeting happened"
                // unless it is counted. The rate of this, against
                // meeting_capture_committed, is the single number that says
                // whether the commit gate is calibrated.
                await client.track("meeting_capture_purged",
                                   ["sys_voiced": sysVoiced, "mic_voiced": micVoiced])
                await endSession(transcribe: false, cfg: cfg)
                detector.cancelUntilQuiet()
            }
        }

        // Hard cap on runaway sessions.
        if state == .recording, sessionDir != nil,
           now - Double(sessionStart) > Double(cfg.maxDurationMinutes) * 60 {
            dbg("max duration reached — ending")
            await endSession(transcribe: committed, cfg: cfg)
            detector.cancel()
        }

        // Idle window: pick up a session whose transcription failed earlier
        // (model was still downloading, machine was offline).
        if state != .recording { await retryPendingTranscription(cfg: cfg) }

        // Calendar events as documents. Off the recording path deliberately: a
        // sweep is a burst of ingests and a live call is the wrong moment.
        if state != .recording, cfg.calendarSync { startCalendarSync(now: Int(now)) }

        await postStats(state: pendingTranscriptions > 0 ? "transcribing" : state.rawValue)
    }

    // Starts recording at candidate time (grace audio is part of the meeting
    // when it commits, purged otherwise). Deliberately NO "Recording"
    // notification and no stats.session* here — those are commit-time.
    private func startPreroll(cfg: MeetingConfig, meetingAppFrontmost: Bool) async {
        let start = Int(Date().timeIntervalSince1970)
        let dir = meetingTmp.appendingPathComponent("session-\(start)")
        // Identity comes from the app HOLDING THE AUDIO, not the app in
        // front. Frontmost is wrong in the ordinary case, not just an edge
        // one: taking notes, reading mail or sitting in Slack during a call
        // is normal, and naming the record after that makes it unfindable by
        // the name the user knows it by (lived 2026-09-01, a recording
        // titled "Ghostty"). Falls back to frontmost when nothing
        // conferencing-capable holds audio.
        let holder = conferencingAppHoldingAudioId()
        let info = await MainActor.run { frontmostAppInfo(preferring: holder) }
        do {
            recorder.meter.reset()
            try await recorder.start(sessionDir: dir)
            sessionDir = dir; sessionStart = start
            sessionBundleId = info.bundleId; sessionAppName = info.name
            // Grabbed at preroll while the call window is likely frontmost;
            // by upload time a browser could be on another tab.
            sessionWindowTitle = await MainActor.run { meetingWindowTitle(bundleId: info.bundleId) }
            prerollStart = Double(start); committed = false
            sessionMeetingAppFrontmost = meetingAppFrontmost
            stats.tcc.audio = true
            dbg("preroll → \(dir.path)")
        } catch {
            // Operator-visible: a session was dropped. cancelUntilQuiet, not
            // cancel — a persistent failure (TCC revoked) otherwise re-tried
            // and re-notified every ~13s for the whole call.
            logErr("[meeting] recorder start failed: \(error)")
            stats.tcc.audio = false
            detector.cancelUntilQuiet()
        }
    }

    private func commitSession() {
        committed = true
        stats.sessionStartedAt = sessionStart
        stats.sessionApp = sessionAppName
        // Recoverability starts HERE, not at transcription failure. A session
        // killed while recording (crash, `shyn setup` during an upgrade, reboot)
        // used to leave orphaned WAVs with no sidecar: nothing retried them and
        // the 24h sweep deleted them. That cost a real 70-minute meeting on
        // 2026-08-06. Written at commit rather than pre-roll on purpose — an
        // unverified pre-roll is ambient noise and SHOULD be discarded.
        // `end: 0` means "still recording"; the retry derives it from the WAVs.
        if let dir = sessionDir {
            _ = writePendingSession(PendingSession(
                start: sessionStart, end: 0, bundleId: sessionBundleId,
                appName: sessionAppName, windowTitle: sessionWindowTitle,
                reason: "interrupted while recording", attempts: 0), in: dir)
        }
        notify("Recording meeting", "\(sessionAppName) — `shyn meeting stop` to end early.")
        dbg("committed (voice verified on both channels)")
    }

    // Tears the session down synchronously (fast: stop recorder, capture
    // metadata, clear session state) and — if keeping it — hands transcription
    // off to a background task so tick() returns immediately and detection /
    // `shyn meeting stop` stay responsive. Session fields are cleared BEFORE
    // the caller posts "transcribing" (derive.ts relies on a transcribing
    // status never carrying session fields).
    private func endSession(transcribe: Bool, cfg: MeetingConfig) async {
        guard let dir = sessionDir, let urls = await recorder.stop() else { return }
        let start = sessionStart
        let end = Int(Date().timeIntervalSince1970)
        let bundleId = sessionBundleId, appName = sessionAppName
        // Preroll runs before the call is joined, so its title read can come
        // back nil (live finding 2026-08-04) while the joined window carries the
        // real name. The window is normally still open at end-of-meeting.
        var windowTitle = sessionWindowTitle
        if windowTitle == nil {
            windowTitle = await MainActor.run { meetingWindowTitle(bundleId: bundleId) }
        }
        sessionDir = nil
        sessionWindowTitle = nil
        prerollStart = nil
        committed = false
        sessionMeetingAppFrontmost = false
        stats.sessionStartedAt = nil
        stats.sessionApp = nil
        guard transcribe else { purgeAudio(sessionDir: dir); dbg("canceled — audio purged"); return }
        startTranscription(dir: dir, urls: urls, start: start, end: end,
                           bundleId: bundleId, appName: appName, windowTitle: windowTitle, cfg: cfg)
    }

    // Kicks off a transcription, chained onto any in-flight one so only a
    // single job contends for the ANE at a time (two meetings can end close
    // together). pendingTranscriptions keeps the status "transcribing" across
    // the whole chain.
    private func startTranscription(dir: URL, urls: (mic: URL, system: URL),
                                    start: Int, end: Int, bundleId: String?, appName: String,
                                    windowTitle: String?, cfg: MeetingConfig) {
        if pendingTranscriptions == 0 { transcribeProgress = 0 }   // don't snap a running % back to 0
        pendingTranscriptions += 1
        let prev = transcribeTask
        transcribeTask = Task {
            await prev?.value
            await self.runTranscription(dir: dir, urls: urls, start: start, end: end,
                                        bundleId: bundleId, appName: appName, windowTitle: windowTitle, cfg: cfg)
        }
    }

    // The heavy work: `await transcribeMeeting` runs off-actor (it is a
    // nonisolated free function), so the actor stays free for tick() while the
    // ANE grinds. finishTranscription always runs, even on an empty drop.
    private func runTranscription(dir: URL, urls: (mic: URL, system: URL),
                                  start: Int, end: Int, bundleId: String?, appName: String,
                                  windowTitle: String?, cfg: MeetingConfig) async {
        defer { finishTranscription() }
        let outcome = await transcribeMeeting(mic: urls.mic, system: urls.system,
                                              model: cfg.whisperModel,
                                              modelDir: whisperModelDir,
                                              onProgress: { p in await self.updateTranscribeProgress(p) })
        let segs: [TranscriptSegment]
        switch outcome {
        case .segments(let s):
            segs = s
        case .failure(let reason):
            // Infra failure (model missing, offline, unusable): the recording is
            // the only irreplaceable thing here, so keep it and retry once the
            // model is present. Bounded by maxPendingAttempts and the 24h sweep.
            keepForRetry(dir: dir, start: start, end: end, bundleId: bundleId,
                         appName: appName, windowTitle: windowTitle, reason: reason)
            // Only the failure CLASS, never the reason string: it can carry a
            // model path or a URL. The daemon would scrub it anyway; not
            // sending it at all is the stronger guarantee.
            await client.track("transcription_failed", ["outcome": "error"])
            return
        }
        // Stamp first: the far-side roster decides how speakers are labelled.
        let stampEarly = await calendarStamp(startEpoch: start, endEpoch: end)
        let label = farSideLabel(segs, others: stampEarly?.others ?? [])
        var transcript = assembleTranscript(segs, farSide: label)
        // Tell the reader when the labels are unusual rather than leaving them
        // to infer it — an unlabelled transcript with no explanation is its own
        // small mystery.
        if let note = speakerNote(label) { transcript = "[\(note)]\n\n" + transcript }
        guard !transcript.isEmpty else {
            // Decode ran and heard nothing — genuine silence, drop the session.
            purgeAudio(sessionDir: dir); dbg("empty transcript — dropped"); return
        }
        // A transcript exists from here on: never re-transcribe this session,
        // even if the ship below only reaches the ring buffer.
        clearPendingSession(in: dir)
        // Stamp precedence (spec 2026-07-23): EventKit match → preroll
        // window title → plain "appName meeting · date".
        let stamp = stampEarly
        // Which fallback won, so a generic doc title is diagnosable next time.
        dbg("stamp: \(stamp != nil ? "eventkit" : (windowTitle != nil ? "window" : "none")) "
            + "(calendar tcc=\(calendarAccessAuthorized()))")
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

    // Failure path for a transcription: audio stays on disk with a sidecar
    // holding what the retry needs (the agent can restart in between). Attempts
    // are counted so a present-but-unusable model cannot spin the ANE forever.
    private func keepForRetry(dir: URL, start: Int, end: Int, bundleId: String?,
                              appName: String, windowTitle: String?, reason: String) {
        let attempts = (readPendingSession(in: dir)?.attempts ?? 0) + 1
        guard attempts <= maxPendingAttempts else {
            logErr("[meeting] transcription failed \(attempts)x — giving up, purging \(dir.lastPathComponent)")
            purgeAudio(sessionDir: dir)
            return
        }
        let pending = PendingSession(start: start, end: end, bundleId: bundleId, appName: appName,
                                     windowTitle: windowTitle, reason: reason, attempts: attempts)
        if writePendingSession(pending, in: dir) {
            logErr("[meeting] transcription failed (attempt \(attempts)): \(reason) — audio kept for retry")
        } else {
            // Cannot record the retry intent, so the audio would linger unowned.
            logErr("[meeting] transcription failed and sidecar unwritable — purging \(dir.lastPathComponent)")
            purgeAudio(sessionDir: dir)
        }
    }

    // Retries one pending session per tick while idle. Gated on the model being
    // present locally: retrying without it just reproduces the same failure and
    // burns an attempt (the offline case that started this).
    private func retryPendingTranscription(cfg: MeetingConfig) async {
        guard pendingTranscriptions == 0, sessionDir == nil, !(await recorder.recording) else { return }
        guard whisperModelPresent(model: cfg.whisperModel, modelDir: whisperModelDir) else { return }
        guard let dir = pendingSessions(root: meetingTmp).first,
              let p = readPendingSession(in: dir) else { return }
        // A commit-time sidecar has end == 0 ("was still recording"): the process
        // that would have stamped the end is the one that died. Recover it from
        // how far the WAVs got, so durationSec and the doc title are truthful.
        let end = p.end > p.start ? p.end : inferredEnd(in: dir, start: p.start)
        logErr("[meeting] recovering \(dir.lastPathComponent): \(p.reason)"
               + " (attempt \(p.attempts), \(end - p.start)s of audio)")
        startTranscription(dir: dir,
                           urls: (mic: dir.appendingPathComponent("mic.wav"),
                                  system: dir.appendingPathComponent("system.wav")),
                           start: p.start, end: end, bundleId: p.bundleId,
                           appName: p.appName, windowTitle: p.windowTitle, cfg: cfg)
    }

    // Ships calendar events as documents. Failures are logged and dropped: a
    // calendar that cannot be read is not a reason to disturb meeting capture.
    private func startCalendarSync(now: Int) {
        guard now - lastCalendarSync >= calendarSyncIntervalSeconds else { return }
        guard calendarTask == nil else { return }      // one sweep at a time
        lastCalendarSync = now
        let c = client
        calendarTask = Task { [weak self] in
            let payloads = await readCalendarEvents(now: now)
            let shipped = await shipCalendarEvents(payloads, via: c)
            await self?.finishCalendarSync(shipped: shipped, total: payloads.count)
        }
    }

    private func finishCalendarSync(shipped: Int, total: Int) {
        calendarTask = nil
        // A sweep that shipped NOTHING must not burn the hour. Lived 2026-08-08:
        // `shyn setup` restarts the agent and the daemon together, the agent
        // ticked first, every ingest hit a socket that was not up yet, and
        // shipCalendarEvents stopped at the first failure — so the interval was
        // spent on zero events and the calendar stayed empty for an hour.
        if shipped == 0 && total > 0 {
            lastCalendarSync = 0
            logErr("[meeting] calendar sync shipped 0/\(total) — daemon unreachable? retrying next tick")
            return
        }
        // Operator-visible, not dbg: a brand-new subsystem whose only feedback
        // is behind SHYN_MEETING_DEBUG cannot be told apart from one that never
        // ran — which is exactly how this went undiagnosed for the first sweep.
        if total > 0 { logErr("[meeting] calendar sync: \(shipped)/\(total) events") }
    }

    private func updateTranscribeProgress(_ p: Double) { transcribeProgress = p }

    private func finishTranscription() {
        pendingTranscriptions = max(0, pendingTranscriptions - 1)
        if pendingTranscriptions == 0 { transcribeProgress = nil }
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
        stats.transcribeProgress = transcribeProgress
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
        await primeCalendarPrompt()   // Calendars pane has no drag-in; ask once here
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
