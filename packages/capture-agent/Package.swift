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
    ]
)
