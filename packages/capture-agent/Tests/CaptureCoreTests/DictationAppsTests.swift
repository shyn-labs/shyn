import Testing
@testable import CaptureCore

@Test func dictationAloneIsNotAMic() {
    #expect(!micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.pais.handy"]))
    #expect(!micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.electron.wispr-flow"]))
    #expect(!micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.electron.wispr-flow.helper"]))
}

@Test func ownCaptureAndDictationTogetherAreNotAMic() {
    // The 2026-09-30 probe: shyn's own pre-roll plus Handy while dictating.
    #expect(!micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.shyn.meeting", "com.pais.handy"]))
}

@Test func aCallStillCountsAlongsideDictation() {
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.pais.handy", "com.google.Chrome.helper"]))
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: ["us.zoom.xos"]))
}

@Test func unattributableDeviceActivityFallsBackToTheDeviceFlag() {
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: []))
    #expect(!micInUseByNonDictation(deviceRunning: false, inputHolders: ["us.zoom.xos"]))
}

@Test func lookalikeIdsAreNotDictation() {
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.pais.handyman"]))
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.evil.com.pais.handy"]))
}

// meeting.excludeApps is honoured by the app HOLDING the mic, not only the
// frontmost app: an excluded app using the mic in the background (lived
// 2026-10-05, an iPad app running natively) must never start a pre-roll.
@Test func excludedHolderAloneIsNotAMic() {
    #expect(!micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.example.tutor"],
                                    excluded: ["com.example.tutor"]))
}

@Test func excludedHelperProcessMatchesByPrefix() {
    #expect(!micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.example.tutor.helper"],
                                    excluded: ["com.example.tutor"]))
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: ["com.example.tutorial"],
                                   excluded: ["com.example.tutor"]))
}

@Test func aCallStillCountsAlongsideAnExcludedApp() {
    #expect(micInUseByNonDictation(deviceRunning: true,
                                   inputHolders: ["com.example.tutor", "com.google.Chrome.helper"],
                                   excluded: ["com.example.tutor"]))
}

@Test func excludedPlusDictationPlusOwnCaptureIsNotAMic() {
    #expect(!micInUseByNonDictation(deviceRunning: true,
                                    inputHolders: ["com.shyn.meeting", "com.pais.handy", "com.example.tutor"],
                                    excluded: ["com.example.tutor"]))
}

@Test func emptyOrBlankExclusionsChangeNothing() {
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: ["us.zoom.xos"], excluded: []))
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: ["us.zoom.xos"], excluded: [""]))
    #expect(micInUseByNonDictation(deviceRunning: true, inputHolders: [], excluded: ["us.zoom.xos"]))
}
