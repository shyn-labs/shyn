// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "meeting-probe",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit", exact: "0.18.0"),
    ],
    targets: [
        .executableTarget(name: "meeting-probe", dependencies: [
            .product(name: "WhisperKit", package: "WhisperKit"),
        ], path: "Sources/meeting-probe"),
    ]
)
