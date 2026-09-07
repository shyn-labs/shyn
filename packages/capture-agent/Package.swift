// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "capture-agent",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Pinned to the exact version the SP3 spike validated
        // (spikes/meeting-probe/README.md) — API shapes differ across minors.
        .package(url: "https://github.com/argmaxinc/WhisperKit", exact: "0.18.0"),
    ],
    targets: [
        .target(name: "CaptureCore"),
        .executableTarget(name: "shyn-capture", dependencies: ["CaptureCore"]),
        .executableTarget(name: "shyn-meeting", dependencies: [
            "CaptureCore", .product(name: "WhisperKit", package: "WhisperKit"),
        ]),
        .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
        // shyn-meeting carries the meeting lifecycle — over half the Swift in
        // this package — and had no tests until 2026-09-07, because a module
        // with top-level code cannot be imported. Entry.swift moved the
        // process entry behind @main precisely to lift that restriction. See
        // the note there before adding top-level code back.
        .testTarget(name: "MeetingAgentTests", dependencies: ["shyn-meeting", "CaptureCore"]),
    ]
)
