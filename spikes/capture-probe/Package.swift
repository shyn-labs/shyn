// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "capture-probe",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "capture-probe", path: "Sources/capture-probe")
    ]
)
