import Foundation
import CoreAudio
import AppKit

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

// Frontmost app identity for the meeting uri/title (falls back to "call").
@MainActor func frontmostAppInfo() -> (bundleId: String?, name: String) {
    let front = NSWorkspace.shared.frontmostApplication
    return (front?.bundleIdentifier, front?.localizedName ?? "Call")
}
