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
