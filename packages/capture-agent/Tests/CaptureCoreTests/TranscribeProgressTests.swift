import Testing
import Foundation
@testable import CaptureCore

// overallTranscribeProgress maps per-channel WhisperKit progress into a single
// 0…1 fraction for the status UI. Channels transcribe sequentially, so overall
// = (fully-done channels + current channel's fraction) / total channels.

@Test func progressIsZeroAtStart() {
    #expect(overallTranscribeProgress(channelsDone: 0, channelFraction: 0, totalChannels: 2) == 0)
}

@Test func firstChannelDoneIsHalf() {
    #expect(overallTranscribeProgress(channelsDone: 1, channelFraction: 0, totalChannels: 2) == 0.5)
}

@Test func halfwayThroughSecondChannelIsThreeQuarters() {
    #expect(overallTranscribeProgress(channelsDone: 1, channelFraction: 0.5, totalChannels: 2) == 0.75)
}

@Test func allChannelsDoneIsOne() {
    #expect(overallTranscribeProgress(channelsDone: 2, channelFraction: 0, totalChannels: 2) == 1.0)
}

@Test func overshootingChannelFractionIsClamped() {
    // A fractionCompleted that momentarily reads >1 must not push overall past
    // its channel's share.
    #expect(overallTranscribeProgress(channelsDone: 0, channelFraction: 1.5, totalChannels: 2) == 0.5)
}

@Test func zeroTotalChannelsIsSafe() {
    #expect(overallTranscribeProgress(channelsDone: 0, channelFraction: 0, totalChannels: 0) == 0)
}
