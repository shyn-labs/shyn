import AppKit
import AVFoundation
import ScreenCaptureKit
import WhisperKit

// SP2 finding: a headless launchd agent must establish an Aqua/WindowServer
// session before any CG/SCK call or it crashes CGS_REQUIRE_INIT.
let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.accessory)

// --- Mic capture (AVAudioEngine → 16kHz mono WAV) ---
// Spike finding: TCC mic access must be requested EXPLICITLY before touching
// the input node. Without the grant, inputNode.outputFormat(forBus:0) is a
// 0 Hz/0 ch format and AVAudioConverter(from:to:)! traps (exit 133) with no
// prompt ever shown. Task 8's AudioRecorder must do this too.
// Starts the mic tap and returns a stop closure. No internal sleep: the
// caller must keep the process alive (and PUMP THE MAIN RUNLOOP — spike
// finding: SCK stream callbacks starve without it, see recordFor below).
func startMic(to url: URL) async throws -> () -> Void {
    let granted = await AVCaptureDevice.requestAccess(for: .audio)
    FileHandle.standardError.write(Data("[mic] tcc granted=\(granted)\n".utf8))
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard granted, inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
        throw NSError(domain: "meeting-probe", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "mic unavailable (tcc granted=\(granted), format=\(inFormat))"])
    }
    // Spike finding: DON'T run AVAudioConverter inside the tap — the manual
    // convert() + write() pattern aborts in CoreAudio's realtime machinery
    // (CAVerboseAbort → terminate, silent SIGTRAP). Instead create the
    // AVAudioFile with WAV settings at the tap's NATIVE sample rate and write
    // tap buffers directly: AVAudioFile converts Float32→Int16 but does NOT
    // resample (a 16kHz label over 48kHz frames plays 3× slow). WhisperKit
    // resamples on load, so native-rate WAVs are fine.
    let outSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: inFormat.sampleRate,
        AVNumberOfChannelsKey: inFormat.channelCount,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
    ]
    let file = try AVAudioFile(forWriting: url, settings: outSettings,
                               commonFormat: inFormat.commonFormat,
                               interleaved: inFormat.isInterleaved)
    input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
        do { try file.write(from: buffer) }
        catch { FileHandle.standardError.write(Data("[mic] write failed: \(error)\n".utf8)) }
    }
    try engine.start()
    return { input.removeTap(onBus: 0); engine.stop() }
}

// Spike finding: SCStream (and other AppKit-adjacent XPC callbacks) starve
// unless the MAIN RUNLOOP is serviced — top-level `await Task.sleep` is not
// enough (SP2's agent ends in NSApplication.shared.run() for the same
// reason). Pump the runloop for the capture window instead of sleeping.
@MainActor func pumpRunLoop(seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
}

// --- System audio capture (ScreenCaptureKit audio-only) ---
// Spike finding: SCK delivers audio in ITS OWN format (48kHz Float32
// deinterleaved on this machine) regardless of SCStreamConfiguration's
// sampleRate/channelCount — a file pre-opened as 16kHz Int16 rejects every
// write. Create the AVAudioFile lazily from the first buffer's actual format
// (Int16 WAV at the native rate; WhisperKit resamples on load).
final class SysAudioWriter: NSObject, SCStreamOutput {
    let url: URL
    var file: AVAudioFile?
    init(_ url: URL) { self.url = url }
    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        if file == nil {
            FileHandle.standardError.write(Data(
                "[sys] cb type=\(type.rawValue) samples=\(CMSampleBufferGetNumSamples(sb)) pcm=\(sb.toPCMBuffer() != nil)\n".utf8))
        }
        guard type == .audio, let pcm = sb.toPCMBuffer() else { return }
        do {
            if file == nil {
                let f = pcm.format
                FileHandle.standardError.write(Data("[sys] first buffer format: \(f)\n".utf8))
                let settings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: f.sampleRate,
                    AVNumberOfChannelsKey: f.channelCount,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false,
                ]
                file = try AVAudioFile(forWriting: url, settings: settings,
                                       commonFormat: f.commonFormat, interleaved: f.isInterleaved)
            }
            try file?.write(from: pcm)
        } catch {
            FileHandle.standardError.write(Data("[sys] write failed: \(error)\n".utf8))
        }
    }
}
final class StreamWatcher: NSObject, SCStreamDelegate, Sendable {
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("[sys] stream stopped: \(error)\n".utf8))
    }
}
let streamWatcher = StreamWatcher()

func recordSystem(to url: URL, seconds: Double) async throws -> SCStream {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    let display = content.displays.first!
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.capturesAudio = true
    cfg.excludesCurrentProcessAudio = true
    // Spike: request SCK's native audio format (48k stereo); asking for 16k
    // mono was one suspect for zero audio callbacks. Downstream handles any
    // format now (lazy writer + WhisperKit resample).
    cfg.sampleRate = 48000
    cfg.channelCount = 1
    cfg.width = 64; cfg.height = 64   // minimal-but-valid video config (2x2 may stall the stream)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)  // 1 fps video, we discard it
    let stream = SCStream(filter: filter, configuration: cfg, delegate: streamWatcher)
    let writer = SysAudioWriter(url)
    try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: .global())
    // Diagnostic: also attach a video output. If video frames flow while
    // audio doesn't, the stall is audio-specific; if neither flows, the
    // stream as a whole never started delivering.
    try stream.addStreamOutput(frameCounter, type: .screen, sampleHandlerQueue: .global())
    try await stream.startCapture()
    FileHandle.standardError.write(Data("[sys] startCapture OK, display=\(display.displayID) \(display.width)x\(display.height)\n".utf8))
    return stream   // caller stops after `seconds`
}

final class FrameCounter: NSObject, SCStreamOutput, Sendable {
    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        struct Once { nonisolated(unsafe) static var logged = false }
        if type == .screen, !Once.logged {
            Once.logged = true
            FileHandle.standardError.write(Data("[sys] VIDEO frame arrived\n".utf8))
        }
    }
}
let frameCounter = FrameCounter()

// --- WhisperKit transcription ---
// WhisperKit 0.18.0: no `WhisperKit(model:)` convenience init; construct via
// WhisperKitConfig(model:). transcribe(audioPath:) has an array-returning
// overload whose element (`TranscriptionResult`) exposes `.text: String`.
// `language` (e.g. "hi", "en") pins Whisper's language token; nil = auto-detect.
// Spike finding: auto-detect on Hinglish speech *translates* to English rather
// than transcribing verbatim — hence this knob to compare.
func transcribe(_ wav: URL, model: String, language: String? = nil) async throws -> String {
    let pipe = try await WhisperKit(WhisperKitConfig(model: model))   // e.g. "small" (multilingual)
    let opts = DecodingOptions(task: .transcribe, language: language)
    let results: [TranscriptionResult] = try await pipe.transcribe(audioPath: wav.path, decodeOptions: opts)
    for r in results {
        FileHandle.standardError.write(Data(
            "[debug] language=\(r.language) segments=\(r.segments.count)\n".utf8))
        for s in r.segments.prefix(6) {
            FileHandle.standardError.write(Data(
                "[debug]   seg \(s.start)-\(s.end) noSpeech=\(s.noSpeechProb) avgLogprob=\(s.avgLogprob): \(s.text.prefix(80))\n".utf8))
        }
    }
    return results.map { $0.text }.joined(separator: " ")
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "record"
switch mode {
case "record":
    let secs = Double(args[2]) ?? 30, dir = URL(fileURLWithPath: args[3])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let sys = try await recordSystem(to: dir.appendingPathComponent("system.wav"), seconds: secs)
    let stopMic = try await startMic(to: dir.appendingPathComponent("mic.wav"))
    pumpRunLoop(seconds: secs)
    stopMic()
    sys.stopCapture()   // macOS 26 SDK: sync overload (async variant is redundant here)
    print("recorded \(secs)s to \(dir.path)")
case "recordmic":
    // Mic-only mode: isolates the Microphone TCC domain from Screen Recording
    // (record's SCShareableContent call aborts first if SR is missing).
    let secs = Double(args[2]) ?? 10, dir = URL(fileURLWithPath: args[3])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let stopMic = try await startMic(to: dir.appendingPathComponent("mic.wav"))
    pumpRunLoop(seconds: secs)
    stopMic()
    print("recorded mic \(secs)s to \(dir.path)")
case "recordtap":
    // FALLBACK system-audio path: CoreAudio process tap (see SystemAudioTap.swift).
    guard #available(macOS 14.2, *) else { print("recordtap needs macOS 14.2+"); exit(1) }
    let secs = Double(args[2]) ?? 10, dir = URL(fileURLWithPath: args[3])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let tap = SystemAudioTapRecorder()
    try tap.start(to: dir.appendingPathComponent("system.wav"))
    let stopMic2 = try await startMic(to: dir.appendingPathComponent("mic.wav"))
    pumpRunLoop(seconds: secs)
    stopMic2()
    tap.stop()
    print("recorded tap \(secs)s to \(dir.path)")
case "transcribe":
    let text = try await transcribe(URL(fileURLWithPath: args[2]),
                                    model: args.count > 3 ? args[3] : "small",
                                    language: args.count > 4 ? args[4] : nil)
    print("chars=\(text.count)\n\(text.prefix(2000))")
case "loop":
    // Headless launchd probe: CoreAudio process tap for system audio (the
    // validated fallback — SCK `.audio` delivers nothing on macOS 26.5).
    guard #available(macOS 14.2, *) else { print("loop needs macOS 14.2+"); exit(1) }
    let dir = URL(fileURLWithPath: args.count > 2 ? args[2] : "/tmp/meeting-probe")
    while true {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tap = SystemAudioTapRecorder()
        try tap.start(to: dir.appendingPathComponent("system.wav"))
        let stopMic = try await startMic(to: dir.appendingPathComponent("mic.wav"))
        pumpRunLoop(seconds: 30)
        stopMic()
        tap.stop()
        let m = (try? await transcribe(dir.appendingPathComponent("mic.wav"), model: "small")) ?? ""
        let sysT = (try? await transcribe(dir.appendingPathComponent("system.wav"), model: "small")) ?? ""
        try? ("mic=\(m.count) system=\(sysT.count)\n").appendToFile(dir.appendingPathComponent("loop.log").path)
        pumpRunLoop(seconds: 30)
    }
default: print("usage: meeting-probe record <secs> <dir> | transcribe <wav> [model] | loop [dir]")
}

// --- CMSampleBuffer → AVAudioPCMBuffer (in the buffer's OWN format) ---
// Verified spike implementation — the reference Task 8 copies verbatim.
// NB: SCK does NOT honor SCStreamConfiguration.sampleRate/channelCount; it
// delivers its own format (48kHz Float32 stereo deinterleaved observed).
func CMSampleBufferToPCM(_ sb: CMSampleBuffer) -> AVAudioPCMBuffer? {
    // Derive the source audio format from the sample buffer itself. SCK
    // delivers ITS OWN format (48kHz Float32 stereo DEINTERLEAVED here) —
    // deinterleaved stereo means TWO AudioBuffers in the list, so a
    // fixed-size AudioBufferList (the C API with
    // MemoryLayout<AudioBufferList>.size) fails silently. Use the Swift
    // withAudioBufferList overlay, which sizes the list correctly.
    guard let fmtDesc = CMSampleBufferGetFormatDescription(sb),
          let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else {
        return nil
    }
    var asbd = asbdPtr.pointee
    let interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
    guard let avFormat = AVAudioFormat(streamDescription: &asbd,
        channelLayout: asbd.mChannelsPerFrame > 2
            ? nil : AVAudioChannelLayout(layoutTag: asbd.mChannelsPerFrame == 1
                ? kAudioChannelLayoutTag_Mono : kAudioChannelLayoutTag_Stereo)) else { return nil }
    _ = interleaved

    let frameCount = CMSampleBufferGetNumSamples(sb)
    guard frameCount > 0,
          let pcm = AVAudioPCMBuffer(pcmFormat: avFormat,
                                     frameCapacity: AVAudioFrameCount(frameCount)) else {
        return nil
    }
    pcm.frameLength = AVAudioFrameCount(frameCount)

    do {
        try sb.withAudioBufferList { srcList, _ in
            let dst = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
            for (i, src) in srcList.enumerated() where i < dst.count {
                guard let s = src.mData, let d = dst[i].mData else { continue }
                memcpy(d, s, min(Int(src.mDataByteSize), Int(dst[i].mDataByteSize)))
            }
        }
    } catch {
        FileHandle.standardError.write(Data("[sys] toPCM failed: \(error)\n".utf8))
        return nil
    }
    return pcm
}

extension CMSampleBuffer {
    func toPCMBuffer() -> AVAudioPCMBuffer? {
        return CMSampleBufferToPCM(self)
    }
}
extension String {
    func appendToFile(_ path: String) throws {
        if let h = FileHandle(forWritingAtPath: path) {
            defer { try? h.close() }; try h.seekToEnd(); try h.write(contentsOf: Data(utf8))
        } else { try write(toFile: path, atomically: true, encoding: .utf8) }
    }
}
