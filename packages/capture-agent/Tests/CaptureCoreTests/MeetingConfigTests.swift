import Testing
import Foundation
@testable import CaptureCore

@Test func chunkedTranscriptionDefaultsOnAndCanBeTurnedOff() throws {
    #expect(MeetingConfig.defaults.chunkedTranscription == true)
    let on = try JSONDecoder().decode(MeetingConfig.self, from: Data(#"{"whisperModel":"small"}"#.utf8))
    #expect(on.chunkedTranscription == true)
    let off = try JSONDecoder().decode(MeetingConfig.self, from: Data(#"{"chunkedTranscription":false}"#.utf8))
    #expect(off.chunkedTranscription == false)
}

@Test func diarizationIsOffUnlessTurnedOn() throws {
    #expect(MeetingConfig.defaults.diarization == false)
    let on = try JSONDecoder().decode(MeetingConfig.self, from: Data(#"{"diarization": true}"#.utf8))
    #expect(on.diarization == true)
    let other = try JSONDecoder().decode(MeetingConfig.self, from: Data(#"{"whisperModel": "small"}"#.utf8))
    #expect(other.diarization == false)
}
