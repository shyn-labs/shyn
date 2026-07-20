import Foundation

public struct CaptureConfig: Codable, Sendable {
    public var excludeBundleIds: [String] = []
    public var excludeTitlePatterns: [String] = []
    public var retentionDays: Int = 30
    public var pollIntervalSeconds: Int = 30
    public var titleWatchIntervalSeconds: Int = 3
    public var pausedUntil: Double? = nil

    public init() {}

    // Partial-JSON tolerant: the CLI (Task 8) writes a capture.json containing
    // only the fields it changes (e.g. just pausedUntil for `pause`). Every
    // property decodes-if-present and otherwise keeps its default, so a partial
    // file still loads instead of failing the whole decode.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.excludeBundleIds = try c.decodeIfPresent([String].self, forKey: .excludeBundleIds) ?? []
        self.excludeTitlePatterns = try c.decodeIfPresent([String].self, forKey: .excludeTitlePatterns) ?? []
        self.retentionDays = try c.decodeIfPresent(Int.self, forKey: .retentionDays) ?? 30
        self.pollIntervalSeconds = try c.decodeIfPresent(Int.self, forKey: .pollIntervalSeconds) ?? 30
        self.titleWatchIntervalSeconds = try c.decodeIfPresent(Int.self, forKey: .titleWatchIntervalSeconds) ?? 3
        self.pausedUntil = try c.decodeIfPresent(Double.self, forKey: .pausedUntil)
    }

    public static let defaults = CaptureConfig()

    public static let builtInBundleIds: [String] = [
        "com.1password.1password", "com.agilebits.onepassword7",
        "com.bitwarden.desktop", "org.keepassxc.keepassxc",
        "com.apple.keychainaccess", "com.apple.Passwords",
        "com.apple.systempreferences",
    ]
    public static let builtInTitlePatterns: [String] = [
        "incognito", "private browsing", "billdesk", "razorpay", "payu",
        "ccavenue", "3-?d ?secure", "issuer channel", "\\botp\\b",
        "verified by visa", "mastercard identity check",
        // Credential-management pages: never capture them at all. The token/
        // key is rendered as page text, so gating on the title (which these
        // pages put "API Tokens"/"API Keys"/etc. into) keeps the whole page
        // out. Content-level secret scrubbing (containsSecret) is the backstop
        // for pages whose title does NOT advertise the secret.
        "api tokens?", "api keys?", "personal access token",
        "secret key", "access key", "client secret",
        "service account key", "ssh key", "private key",
        "create.{0,15}token",
    ]

    public var effectiveExcludedBundleIds: Set<String> {
        Set(Self.builtInBundleIds).union(excludeBundleIds)
    }
    public var effectiveTitlePatterns: [String] {
        Self.builtInTitlePatterns + excludeTitlePatterns
    }
    public func isPaused(now: Double) -> Bool { (pausedUntil ?? 0) > now }

    public static func load(from path: String) -> CaptureConfig {
        guard let data = FileManager.default.contents(atPath: path),
              let cfg = try? JSONDecoder().decode(CaptureConfig.self, from: data)
        else { return .defaults }
        return cfg
    }
}
