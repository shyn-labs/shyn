import Testing
import Foundation
@testable import CaptureCore

// Live-verification finding (2026-07-11): peak-blip activity detection kept
// meetings alive indefinitely — keyboard clicks near the mic and stray system
// sounds each counted as "activity". VoiceActivity discriminates by SUSTAIN:
// a channel is voiced only after its level stays above threshold continuously
// for sustainSeconds (speech is dense, ~300ms+ voiced runs; typing transients
// are isolated ~10ms clicks that never sustain).

@Test func sustainedSpeechBecomesActive() {
    var v = VoiceActivity()   // threshold 0.01, sustain 0.25s
    // 85ms buffers at speech-like RMS 0.05 for 0.34s
    for i in 0..<4 { v.observe(level: 0.05, at: Double(i) * 0.085) }
    #expect(v.activeWithin(10, at: 0.4))
}

@Test func isolatedClickNeverActivates() {
    var v = VoiceActivity()
    v.observe(level: 0.001, at: 0.0)
    v.observe(level: 0.30, at: 0.085)   // single loud keystroke buffer
    v.observe(level: 0.001, at: 0.170)
    #expect(!v.activeWithin(10, at: 0.3))
}

@Test func typingPatternNeverActivates() {
    var v = VoiceActivity()
    // 6 keystrokes/sec for 5 seconds: loud 30ms buffer then two quiet ones
    var t = 0.0
    for _ in 0..<100 {
        v.observe(level: 0.25, at: t); t += 0.03
        v.observe(level: 0.002, at: t); t += 0.03
        v.observe(level: 0.002, at: t); t += 0.03
    }
    #expect(!v.activeWithin(10, at: t))
}

@Test func quietAmbientNeverActivates() {
    var v = VoiceActivity()
    for i in 0..<200 { v.observe(level: 0.002, at: Double(i) * 0.05 ) }
    #expect(!v.activeWithin(60, at: 10.0))
}

@Test func activityExpiresAfterWindow() {
    var v = VoiceActivity()
    for i in 0..<5 { v.observe(level: 0.05, at: Double(i) * 0.085) }
    #expect(v.activeWithin(10, at: 5.0))     // voiced at ~0.34
    #expect(!v.activeWithin(10, at: 20.0))   // >10s later
}

@Test func speechAfterLongSilenceReactivates() {
    var v = VoiceActivity()
    for i in 0..<5 { v.observe(level: 0.05, at: Double(i) * 0.085) }   // voiced ~0.34
    for i in 0..<10 { v.observe(level: 0.001, at: 1.0 + Double(i)) }   // 10s silence
    #expect(!v.activeWithin(5, at: 12.0))
    for i in 0..<5 { v.observe(level: 0.05, at: 15.0 + Double(i) * 0.085) }
    #expect(v.activeWithin(5, at: 15.5))
}
