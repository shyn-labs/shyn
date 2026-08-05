import Testing
import Foundation
@testable import CaptureCore

private func seg(_ text: String, _ start: Double = 0, _ who: Speaker = .others) -> TranscriptSegment {
    TranscriptSegment(start: start, speaker: who, text: text)
}

private func quality(noSpeech: Float = 0.0, logprob: Float = -0.2, compression: Float = 1.2) -> SegmentQuality {
    SegmentQuality(noSpeechProb: noSpeech, avgLogprob: logprob, compressionRatio: compression)
}

@Test func annotationFilterCatchesBracketsParensAndAsterisks() {
    #expect(isNonSpeechAnnotation("[BLANK_AUDIO]"))
    #expect(isNonSpeechAnnotation("(music)"))
    #expect(isNonSpeechAnnotation("*Humming*"))
    #expect(isNonSpeechAnnotation("*whistling*"))
    #expect(isNonSpeechAnnotation("*ding*"))
    #expect(!isNonSpeechAnnotation("we only do nature-based carbon credit"))
    // A bare asterisk or an unpaired one is real text, not an annotation.
    #expect(!isNonSpeechAnnotation("*"))
    #expect(!isNonSpeechAnnotation("*starts a sentence"))
}

@Test func qualityGatesDropSilenceLowConfidenceAndDegenerateSegments() {
    #expect(passesQualityGates(quality()))                        // healthy
    #expect(!passesQualityGates(quality(noSpeech: 0.61)))         // silence
    #expect(passesQualityGates(quality(noSpeech: 0.60)))          // boundary is exclusive
    #expect(!passesQualityGates(quality(logprob: -1.01)))         // low confidence
    #expect(passesQualityGates(quality(logprob: -1.00)))          // boundary is exclusive
    #expect(!passesQualityGates(quality(compression: 2.41)))      // degenerate
    #expect(passesQualityGates(quality(compression: 2.40)))       // boundary is exclusive
}

@Test func collapseRepeatsDropsALongRunEntirely() {
    let junk = (0..<40).map { seg("you", Double($0)) }
    let real = [seg("so that's the elevator pitch", 40, .me)]
    let out = collapseRepeats(junk + real)
    #expect(out.count == 1)
    #expect(out[0].text == "so that's the elevator pitch")
}

@Test func collapseRepeatsKeepsRunsOfThreeOrFewer() {
    let segs = [seg("yes.", 0), seg("Yes", 1), seg("yes", 2), seg("moving on", 3)]
    #expect(collapseRepeats(segs).count == 4)
}

@Test func collapseRepeatsNormalisesCaseAndTrailingPunctuation() {
    let segs = (0..<5).map { seg($0 % 2 == 0 ? "Thank you." : "thank you", Double($0)) }
    #expect(collapseRepeats(segs).isEmpty)
}

@Test func collapseRepeatsOnlyCollapsesConsecutiveSegments() {
    let segs = [seg("okay", 0), seg("real line", 1), seg("okay", 2), seg("another", 3), seg("okay", 4)]
    #expect(collapseRepeats(segs).count == 5)
}

@Test func regressionAwsTranscriptShape() {
    // Shaped like the 2026-08-04 AWS capture: real speech buried in a long
    // silence-hallucination run. The real lines MUST survive.
    var segs: [TranscriptSegment] = []
    segs.append(seg("Hi there, how are you doing?", 0))
    segs += (1...30).map { seg("you", Double($0)) }
    segs.append(seg("So we are a climate tech company.", 31, .me))
    segs += (32...50).map { seg("Thank you.", Double($0), .me) }
    segs.append(seg("I'll let the team work on the invoice thing.", 51))
    let out = collapseRepeats(segs)
    #expect(out.count == 3)
    #expect(out.map(\.text) == [
        "Hi there, how are you doing?",
        "So we are a climate tech company.",
        "I'll let the team work on the invoice thing.",
    ])
}
