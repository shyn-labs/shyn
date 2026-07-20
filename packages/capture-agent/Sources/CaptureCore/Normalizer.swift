import Foundation

public func normalize(_ raw: String) -> String {
    var s = raw.replacingOccurrences(of: "[\\x{200B}-\\x{200D}\\x{FEFF}]",
                                     with: "", options: .regularExpression)
    // Strip C0/C1 control chars except newline and tab (tab is collapsed below).
    s = s.replacingOccurrences(of: "[\\x{00}-\\x{08}\\x{0B}\\x{0C}\\x{0E}-\\x{1F}\\x{7F}]",
                               with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
    s = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return String(s.prefix(50_000))
}
