import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation

// FALLBACK system-audio capture: CoreAudio process tap (macOS 14.4+).
// Spike finding on macOS 26.5: ScreenCaptureKit's `.audio` stream output
// delivers ZERO callbacks (video flows, no error raised) regardless of TCC
// grants or process identity. The dedicated audio API below requests
// kTCCServiceAudioCapture properly (NSAudioCaptureUsageDescription) and is
// the validated path for Task 8.
//
// Pattern: global process tap → private aggregate device containing the
// tap → IOProc reading the tap's input buffers → AVAudioFile (native
// format; WhisperKit resamples on load).

enum TapError: Error { case osStatus(String, OSStatus) }

private func check(_ what: String, _ status: OSStatus) throws {
    guard status == noErr else { throw TapError.osStatus(what, status) }
}

@available(macOS 14.2, *)
final class SystemAudioTapRecorder {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var file: AVAudioFile?
    private var format: AVAudioFormat?

    func start(to url: URL) throws {
        // 1. Global tap: all processes' output, mixed down to stereo.
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.name = "meeting-probe-tap"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        try check("AudioHardwareCreateProcessTap", AudioHardwareCreateProcessTap(desc, &tapID))

        // 2. Read the tap's stream format.
        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check("get tap format", AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &size, &asbd))
        guard let avFormat = AVAudioFormat(streamDescription: &asbd) else {
            throw TapError.osStatus("AVAudioFormat(streamDescription:)", -1)
        }
        format = avFormat
        FileHandle.standardError.write(Data("[tap] format: \(avFormat)\n".utf8))

        // 3. Private aggregate device wrapping the tap.
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "meeting-probe-agg",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [Any](),
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: desc.uuid.uuidString],
            ],
        ]
        try check("AudioHardwareCreateAggregateDevice",
                  AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID))

        // 4. WAV file at the tap's native rate (Int16 for size).
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: avFormat.sampleRate,
            AVNumberOfChannelsKey: avFormat.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let f = try AVAudioFile(forWriting: url, settings: settings,
                                commonFormat: avFormat.commonFormat,
                                interleaved: avFormat.isInterleaved)
        file = f

        // 5. IOProc: the tap's audio arrives as the aggregate's INPUT.
        try check("AudioDeviceCreateIOProcIDWithBlock",
                  AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) {
                      [weak self] _, inInputData, _, _, _ in
                      self?.write(inInputData)
                  })
        try check("AudioDeviceStart", AudioDeviceStart(aggID, procID))
    }

    private func write(_ abl: UnsafePointer<AudioBufferList>) {
        guard let format, let file else { return }
        let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: abl))
        guard let first = src.first, first.mDataByteSize > 0 else { return }
        let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
        guard bytesPerFrame > 0 else { return }
        let frames = first.mDataByteSize / bytesPerFrame
        guard frames > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        pcm.frameLength = frames
        let dst = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        for (i, s) in src.enumerated() where i < dst.count {
            guard let sd = s.mData, let dd = dst[i].mData else { continue }
            memcpy(dd, sd, min(Int(s.mDataByteSize), Int(dst[i].mDataByteSize)))
        }
        do { try file.write(from: pcm) }
        catch { FileHandle.standardError.write(Data("[tap] write failed: \(error)\n".utf8)) }
    }

    func stop() {
        if let procID, aggID != kAudioObjectUnknown {
            AudioDeviceStop(aggID, procID)
            AudioDeviceDestroyIOProcID(aggID, procID)
        }
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        file = nil
    }
}
