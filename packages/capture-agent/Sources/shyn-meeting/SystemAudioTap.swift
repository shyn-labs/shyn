import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation

// System-audio capture via CoreAudio process tap (macOS 14.2+), copied from
// the validated spike (spikes/meeting-probe/SystemAudioTap.swift).
// ScreenCaptureKit's `.audio` output delivers ZERO callbacks on macOS 26.5
// with all TCC grants in place — the process tap is the adopted path (spike
// README, plan amendment). It requests kTCCServiceAudioCapture
// (NSAudioCaptureUsageDescription) and needs no Screen Recording grant.
//
// Pattern: global process tap → private aggregate device containing the
// tap → IOProc reading the tap's input buffers → AVAudioFile at the tap's
// NATIVE format (AVAudioFile converts sample format but NOT rate; WhisperKit
// resamples on load).

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
    private let onError: (String) -> Void
    private let meter: ActivityMeter?

    init(meter: ActivityMeter? = nil, onError: @escaping (String) -> Void = { _ in }) {
        self.meter = meter; self.onError = onError
    }

    func start(to url: URL) throws {
        // Global tap: all processes' output, mixed to stereo. Private so it
        // is invisible to other audio clients.
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.name = "shyn-meeting-tap"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        try check("AudioHardwareCreateProcessTap", AudioHardwareCreateProcessTap(desc, &tapID))

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

        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "shyn-meeting-agg",
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

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: avFormat.sampleRate,
            AVNumberOfChannelsKey: avFormat.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        file = try AVAudioFile(forWriting: url, settings: settings,
                               commonFormat: avFormat.commonFormat,
                               interleaved: avFormat.isInterleaved)

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
        meter?.mark(.system, buffer: pcm)
        do { try file.write(from: pcm) }
        catch { onError("tap write failed: \(error)") }
    }

    func stop() {
        if let procID, aggID != kAudioObjectUnknown {
            AudioDeviceStop(aggID, procID)
            AudioDeviceDestroyIOProcID(aggID, procID)
        }
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil; aggID = kAudioObjectUnknown; tapID = kAudioObjectUnknown
        file = nil
    }
}
