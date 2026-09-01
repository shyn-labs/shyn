import Foundation
import AVFoundation
import CaptureCore

// Records mic (AVAudioEngine tap) + system audio (CoreAudio process tap,
// SystemAudioTap.swift) to WAVs in a session directory. Every pattern here
// is spike-validated — see "Hard-won capture findings" in
// spikes/meeting-probe/README.md before changing anything:
//   - request mic TCC explicitly BEFORE touching inputNode (silent SIGTRAP)
//   - no AVAudioConverter inside the tap callback (CoreAudio abort)
//   - AVAudioFile at the tap's NATIVE rate (no SRC on write; WhisperKit
//     resamples on load)
//   - DO NOT enable voice processing (AEC) here. Tried in 0.4.18, reverted in
//     0.4.19 after it degraded a real call: AUVoiceProcessingIO reconfigures the
//     shared input device, so its automatic gain control (audible as level
//     pumping) and a persistent tone reached the meeting itself, not just our
//     recording. Speaker→mic bleed is handled AFTER the fact by
//     dropEchoDuplicates in CaptureCore, which cannot touch live audio.
//     See docs/known-issues.md before attempting AEC again.
@available(macOS 14.2, *)   // process tap floor; the agent requires 14.2+
actor AudioRecorder {
    private var engine: AVAudioEngine?
    private var tap: SystemAudioTapRecorder?
    private var micURL: URL?
    private var systemURL: URL?
    private(set) var recording = false
    private var micFormat: AVAudioFormat?   // input format the tap + file were built for
    private var micRestartAttempts = 0
    // Read by the commit gate: once the mic engine is declared dead, that
    // channel's silence means "cannot report", not "nobody spoke". Treating
    // it as a negative made the gate's mic term dead code for the rest of
    // the session and purged real meetings (2 of 8 logged purges).
    private(set) var micDeclaredDead = false
    // Signal-level activity from the recorded buffers themselves — the ONLY
    // valid end-of-meeting signal while recording (our own taps keep the
    // devices "running", so the device probes read active forever).
    nonisolated let meter = ActivityMeter()

    struct RecorderError: Error { let message: String }

    func start(sessionDir: URL) async throws {
        guard !recording else { return }
        try FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
        let mic = sessionDir.appendingPathComponent("mic.wav")
        let sys = sessionDir.appendingPathComponent("system.wav")

        // System audio first (no prompt once granted; fails fast on TCC).
        let t = SystemAudioTapRecorder(meter: meter, onError: { msg in
            FileHandle.standardError.write(Data(logLine("[recorder] \(msg)").utf8))
        })
        try t.start(to: sys)

        // Mic. Explicit TCC request — without it the input node reports a
        // 0 Hz format and AVAudioConverter/engine setup traps.
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        let eng = AVAudioEngine()
        let input = eng.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard granted, inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
            t.stop()
            throw RecorderError(message: "mic unavailable (tcc granted=\(granted))")
        }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: inFormat.sampleRate,
            AVNumberOfChannelsKey: inFormat.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let file = try AVAudioFile(forWriting: mic, settings: settings,
                                   commonFormat: inFormat.commonFormat,
                                   interleaved: inFormat.isInterleaved)
        let meter = self.meter
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
            // `file` is captured by the render-thread closure and written
            // only here — never touched from actor context after start.
            meter.mark(.mic, buffer: buffer)
            try? file.write(from: buffer)
        }
        do { try eng.start() }
        catch { input.removeTap(onBus: 0); t.stop(); throw error }

        engine = eng; tap = t; micURL = mic; systemURL = sys; recording = true
        micFormat = inFormat; micRestartAttempts = 0; micDeclaredDead = false
    }

    // The mic AVAudioEngine stops silently on an input-device configuration
    // change (call app releasing the device, AirPods → built-in switch) and
    // never restarts itself — lived 2026-08-18: mic.wav froze 3.7s into a
    // session while the system tap kept going. Called every tick while
    // recording: restart the engine when the input format is unchanged (tap
    // and file are still valid); if the format changed they are stale — no
    // converter is allowed in the tap callback (spike finding) — so declare
    // the channel dead, loudly, once. The session survives on system audio.
    func ensureMicAlive() {
        guard recording, let eng = engine, !eng.isRunning, !micDeclaredDead else { return }
        let current = eng.inputNode.outputFormat(forBus: 0)
        guard micRestartAttempts < 3, let started = micFormat, current == started else {
            micDeclaredDead = true
            logErr("[recorder] mic engine dead (format changed or \(micRestartAttempts) restarts failed)"
                   + " — continuing on system audio only")
            return
        }
        micRestartAttempts += 1
        do {
            try eng.start()
            logErr("[recorder] mic engine stopped (device change?) — restarted, attempt \(micRestartAttempts)")
        } catch {
            logErr("[recorder] mic engine restart failed (attempt \(micRestartAttempts)): \(error)")
        }
    }

    func stop() -> (mic: URL, system: URL)? {
        guard recording, let mic = micURL, let sys = systemURL else { return nil }
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        tap?.stop()
        engine = nil; tap = nil; micURL = nil; systemURL = nil; recording = false
        micFormat = nil
        return (mic: mic, system: sys)
    }
}
