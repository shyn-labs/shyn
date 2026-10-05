import Foundation

// Dictation tools hold the microphone for the length of a spoken sentence and
// are never a meeting. The start gate reads the DEVICE flag (mic AND system
// audio), which cannot tell them from a call: dictating while any audio plays
// raised "meeting detected, recording in 10 seconds" (lived 2026-09-30, Handy
// + Music). The commit gate purged each one, but only after a banner and a
// live pre-roll.
//
// Ids marked (observed) were read off a running machine with the process
// probe. The rest are inferred and unverified: a wrong id here fails silently
// (the banner keeps appearing), so confirm with the probe when adding one.
public let dictationBundlePrefixes: [String] = [
    "com.pais.handy",               // Handy (observed 2026-09-30)
    "com.electron.wispr-flow",      // Wispr Flow (installed, id read from Info.plist)
    "com.superduper.superwhisper",  // Superwhisper (unverified)
    // Apple's speech service (macOS Dictation, Siri, any app on the Speech
    // framework) holds its OWN input stream beside the app using it, so
    // excluding that app is not enough (observed 2026-10-05).
    "com.apple.CoreSpeech",
]

/// The agent's own bundle id. Its pre-roll and recording hold an input stream
/// that must never count as somebody else's microphone use.
public let ownBundleId = "com.shyn.meeting"

public func isDictationBundleId(_ bundleId: String) -> Bool {
    matchesBundlePrefix(bundleId, dictationBundlePrefixes)
}

/// `bundleId` is one of `prefixes` or a helper under it (`prefix.` + more).
/// Blank prefixes never match: an empty excludeApps entry must not swallow
/// every holder.
func matchesBundlePrefix(_ bundleId: String, _ prefixes: [String]) -> Bool {
    for prefix in prefixes where !prefix.isEmpty {
        if bundleId == prefix || bundleId.hasPrefix(prefix + ".") { return true }
    }
    return false
}

/// Is the microphone in use by something that could be a call?
///
/// `deviceRunning` is the device-level flag. `inputHolders` are the bundle ids
/// of processes holding an input stream. When the device is running but the
/// process list is empty we cannot attribute it, so the device flag stands:
/// dropping a real call is worse than one false banner. When holders ARE
/// known, dictation tools, this agent and the user's `meeting.excludeApps`
/// are set aside, and the mic counts only if something else remains.
/// Excluded apps are matched by HOLDER here, so one using the mic in the
/// background never starts a pre-roll; the frontmost-app check in the agent
/// only caught them while in front (lived 2026-10-05).
public func micInUseByNonDictation(deviceRunning: Bool, inputHolders: [String],
                                   excluded: [String] = []) -> Bool {
    guard deviceRunning else { return false }
    guard !inputHolders.isEmpty else { return true }
    return inputHolders.contains {
        $0 != ownBundleId && !isDictationBundleId($0) && !matchesBundlePrefix($0, excluded)
    }
}
