import Foundation

// The two meeting channels (mic, system) transcribe sequentially, so a single
// 0…1 progress fraction for the status UI is the fully-completed channels plus
// the current channel's own fraction, divided by the total. Pure so it can be
// unit-tested away from WhisperKit (whose Progress feeds channelFraction).
public func overallTranscribeProgress(channelsDone: Int, channelFraction: Double, totalChannels: Int) -> Double {
    guard totalChannels > 0 else { return 0 }
    let fraction = min(1, max(0, channelFraction))
    let raw = (Double(channelsDone) + fraction) / Double(totalChannels)
    return min(1, max(0, raw))
}
