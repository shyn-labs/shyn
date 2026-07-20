import Foundation
import AVFoundation
import CaptureCore

// Live-verification finding (2026-07-10): while recording, OUR OWN mic tap
// and process tap keep both audio devices "running", so the
// kAudioDevicePropertyDeviceIsRunningSomewhere probes (MeetingProbes.swift)
// never drop — the meeting signal must come from the RECORDED AUDIO itself.
//
// Second live finding (2026-07-11): peak-blip detection kept meetings alive
// through keyboard clicks and stray dings. The meter now feeds per-buffer
// RMS into sustain-based VoiceActivity (CaptureCore, unit-tested): a channel
// is active only after ≥250ms of continuous signal — speech qualifies,
// typing transients don't. Music still qualifies (accepted limitation, see
// docs/known-issues.md).
final class ActivityMeter: @unchecked Sendable {
    enum Channel { case mic, system }

    private let lock = NSLock()
    private var mic = VoiceActivity()
    private var system = VoiceActivity()

    func mark(_ channel: Channel, buffer: AVAudioPCMBuffer) {
        let level = bufferRMS(buffer)
        let now = Date().timeIntervalSince1970
        lock.lock(); defer { lock.unlock() }
        switch channel {
        case .mic: mic.observe(level: level, at: now)
        case .system: system.observe(level: level, at: now)
        }
    }

    func voiceActiveWithin(_ seconds: Double, _ channel: Channel) -> Bool {
        let now = Date().timeIntervalSince1970
        lock.lock(); defer { lock.unlock() }
        switch channel {
        case .mic: return mic.activeWithin(seconds, at: now)
        case .system: return system.activeWithin(seconds, at: now)
        }
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        mic = VoiceActivity()
        system = VoiceActivity()
    }
}

// RMS (0…1) over the first channel of a PCM buffer. RMS, not peak: a 5ms
// keystroke click dominates a peak reading but contributes little energy
// to an 85ms buffer, while speech keeps RMS high across whole buffers.
func bufferRMS(_ buffer: AVAudioPCMBuffer) -> Float {
    let frames = Int(buffer.frameLength)
    guard frames > 0 else { return 0 }
    if let f = buffer.floatChannelData {
        var sum: Float = 0
        var n = 0
        let data = f[0]
        for i in stride(from: 0, to: frames, by: 4) { sum += data[i] * data[i]; n += 1 }
        return n > 0 ? (sum / Float(n)).squareRoot() : 0
    }
    if let i16 = buffer.int16ChannelData {
        var sum: Float = 0
        var n = 0
        let data = i16[0]
        for i in stride(from: 0, to: frames, by: 4) {
            let v = Float(data[i]) / Float(Int16.max)
            sum += v * v; n += 1
        }
        return n > 0 ? (sum / Float(n)).squareRoot() : 0
    }
    return 0
}
