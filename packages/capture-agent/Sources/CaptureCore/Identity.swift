import Foundation
import CryptoKit

public func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

public func windowKey(bundleId: String, windowTitle: String) -> String {
    return "\(bundleId)/\(String(sha256Hex(windowTitle).prefix(12)))"
}

public func bucketUri(bundleId: String, windowTitle: String, epochSeconds: Int) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd-HH"
    f.timeZone = TimeZone(identifier: "UTC")
    f.locale = Locale(identifier: "en_US_POSIX")
    let bucket = f.string(from: Date(timeIntervalSince1970: Double(epochSeconds)))
    return "screen://\(windowKey(bundleId: bundleId, windowTitle: windowTitle))/\(bucket)"
}
