import Foundation

public enum Speaker: String, Sendable { case me = "Me", others = "Others" }

public struct TranscriptSegment: Sendable {
    public let start: Double
    public let speaker: Speaker
    public let text: String
    public init(start: Double, speaker: Speaker, text: String) {
        self.start = start; self.speaker = speaker; self.text = text
    }
}

public func assembleTranscript(_ segments: [TranscriptSegment]) -> String {
    segments.sorted { $0.start < $1.start }
        .map { "\($0.speaker.rawValue): \($0.text)" }
        .joined(separator: "\n")
}
