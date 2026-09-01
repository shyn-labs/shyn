import Foundation
import CoreAudio
import AppKit
import CaptureCore

// OS-level signal probes feeding MeetingDetector (CaptureCore). All three
// are cheap property reads — safe to poll every few seconds.

private func defaultDevice(selector: AudioObjectPropertySelector) -> AudioObjectID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var dev = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev)
    return status == noErr && dev != kAudioObjectUnknown ? dev : nil
}

// kAudioDevicePropertyDeviceIsRunningSomewhere: true when ANY process has
// live IO on the device — exactly the "is a call happening" signal we want
// (no TCC needed for the property read).
private func deviceRunningSomewhere(_ dev: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var running = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &running) == noErr else { return false }
    return running != 0
}

func micActive() -> Bool {
    guard let dev = defaultDevice(selector: kAudioHardwarePropertyDefaultInputDevice) else { return false }
    return deviceRunningSomewhere(dev)
}

func systemAudioActive() -> Bool {
    guard let dev = defaultDevice(selector: kAudioHardwarePropertyDefaultOutputDevice) else { return false }
    return deviceRunningSomewhere(dev)
}

// Booster signal only (spec: not required, so browser-tab calls still
// trigger via the audio signals alone).
//
// Membership bar: being frontmost in the app must ITSELF predict "user is in
// a call". Dedicated meeting apps qualify. Slack does NOT — it is frontmost
// all day as a chat app, so with the listen-only booster (system audio +
// frontmost, no mic required) any music/podcast while reading Slack became a
// phantom pre-roll (lived 2026-07-22: a notification click + speakers =
// red dot). Slack huddles still record via the two-channel path the moment
// the user speaks; pure listen-only huddles are the accepted loss.
let meetingBundleIds: Set<String> = [
    "us.zoom.xos",                  // Zoom
    "com.microsoft.teams2",         // Teams (new)
    "com.microsoft.teams",          // Teams (classic)
    "Cisco-Systems.Spark",          // Webex
    "com.cisco.webexmeetingsapp",   // Webex Meetings
    "com.apple.FaceTime",           // FaceTime
]

@MainActor func meetingAppFrontmost() -> Bool {
    guard let front = NSWorkspace.shared.frontmostApplication,
          let id = front.bundleIdentifier else { return false }
    return meetingBundleIds.contains(id)
}

// WHICH process is holding audio, not merely whether the device is hot.
//
// `deviceRunningSomewhere` above cannot distinguish a call from an ambient
// mic-holder, and on a machine running Granola or Wispr Flow it is pinned
// true all day — which is why the START gate leans on system audio and why
// the commit gate needed a rescue term at all. macOS 14.2 (already this
// agent's floor, for CATapDescription) exposes CoreAudio *process* objects,
// so we can ask the honest question instead: is a conferencing-capable app
// holding an audio stream right now?
//
// Immune to our own capture — these flags are per-process, and shyn-meeting
// running input does not set Chrome's. That makes this the first probe here
// that stays valid DURING recording.
//
// Read-only property reads, same class as deviceRunningSomewhere: no device
// opened, no aggregate created, nothing shared reconfigured. This is
// categorically not the AEC failure mode (see docs/known-issues.md).
private func audioProcessObjects() -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0
    else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr
    else { return [] }
    return ids
}

private func processBundleId(_ obj: AudioObjectID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyBundleID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    // kAudioProcessPropertyBundleID returns a RETAINED CFString — the caller
    // owns it, so the retain must be consumed exactly once or this leaks a
    // string per process per tick. Read into untyped storage and bridge
    // explicitly: passing `&cfStringOptional` straight to the CoreAudio call
    // forms a raw pointer to a managed reference, which is unsound.
    var raw: UnsafeMutableRawPointer? = nil
    var size = UInt32(MemoryLayout<UnsafeMutableRawPointer?>.size)
    let status = withUnsafeMutablePointer(to: &raw) {
        AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0)
    }
    guard status == noErr, let raw else { return nil }
    return Unmanaged<CFString>.fromOpaque(raw).takeRetainedValue() as String
}

private func processRunningFlag(_ obj: AudioObjectID,
                                _ selector: AudioObjectPropertySelector) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var running = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &running) == noErr else { return false }
    return running != 0
}

/// True when a conferencing-capable app currently holds an audio stream —
/// input OR output.
///
/// OUTPUT is the load-bearing half, and the reason the 2026-08-31 meeting
/// was lost. A muted listener may release the mic, but the browser keeps
/// PLAYING the other participants for the whole call, so its output stream
/// is held continuously. Observed live 2026-09-01 during a real Meet call:
/// `com.google.Chrome.helper` appeared on both input and output.
///
/// Safe because it is gated on a conferencing-capable bundle id: Music and
/// QuickTime hold output all day and match nothing here. Far-side voice
/// also remains mandatory at the commit gate, so this can never commit
/// silence on its own.
func conferencingAppHoldingAudio() -> Bool {
    for obj in audioProcessObjects() {
        let active = processRunningFlag(obj, kAudioProcessPropertyIsRunningInput)
            || processRunningFlag(obj, kAudioProcessPropertyIsRunningOutput)
        guard active, let id = processBundleId(obj) else { continue }
        if isConferencingCapableBundleId(id) { return true }
    }
    return false
}

/// Full input-holder dump for verification. The bundle ids that matter here
/// were inferred, not observed, and a rescue signal keyed on a guessed id
/// fails silently — so make them recordable on a real machine before the
/// live checklist is run.
func debugDumpAudioInputHolders() -> String {
    var lines: [String] = []
    for obj in audioProcessObjects() {
        let id = processBundleId(obj) ?? "(no bundle id)"
        let input = processRunningFlag(obj, kAudioProcessPropertyIsRunningInput)
        let output = processRunningFlag(obj, kAudioProcessPropertyIsRunningOutput)
        guard input || output else { continue }
        lines.append("  input=\(input) conferencing=\(isConferencingCapableBundleId(id)) \(id)")
    }
    return lines.isEmpty ? "  (no process holding an input stream)" : lines.joined(separator: "\n")
}

// Frontmost app identity for the meeting uri/title (falls back to "call").
@MainActor func frontmostAppInfo() -> (bundleId: String?, name: String) {
    let front = NSWorkspace.shared.frontmostApplication
    return (front?.bundleIdentifier, front?.localizedName ?? "Call")
}
