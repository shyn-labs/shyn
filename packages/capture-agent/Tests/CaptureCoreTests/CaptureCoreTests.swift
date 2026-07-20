import Testing
import Foundation
@testable import CaptureCore

@Test func bucketUriShape() {
    let uri = bucketUri(bundleId: "com.google.Chrome", windowTitle: "Gmail — Inbox",
                        epochSeconds: 1_783_000_000)
    // sha256("Gmail — Inbox") prefix must be stable; hour bucket is UTC
    #expect(uri.hasPrefix("screen://com.google.Chrome/"))
    #expect(uri.wholeMatch(of: /screen:\/\/[^\/]+\/[0-9a-f]{12}\/\d{4}-\d{2}-\d{2}-\d{2}/) != nil)
    let again = bucketUri(bundleId: "com.google.Chrome", windowTitle: "Gmail — Inbox",
                          epochSeconds: 1_783_000_000 + 120)  // same hour
    #expect(uri == again)
}

@Test func gateOrderAndReasons() {
    var cfg = CaptureConfig.defaults
    cfg.pausedUntil = Date().timeIntervalSince1970 + 600
    #expect(gate(bundleId: "com.apple.TextEdit", title: "notes", config: cfg,
                 now: Date().timeIntervalSince1970, secureInput: false) == .paused)
    #expect(gate(bundleId: "com.1password.1password", title: "vault",
                 config: .defaults, now: 0, secureInput: false) == .excludedApp)
    #expect(gate(bundleId: "com.google.Chrome", title: "BillDesk - Payment",
                 config: .defaults, now: 0, secureInput: false) == .excludedTitle)
    #expect(gate(bundleId: "com.google.Chrome", title: "Issuer Channel",
                 config: .defaults, now: 0, secureInput: false) == .excludedTitle)
    #expect(gate(bundleId: "com.apple.TextEdit", title: "anything", config: .defaults,
                 now: 0, secureInput: true) == .secureInput)
    #expect(gate(bundleId: "com.apple.TextEdit", title: "normal doc", config: .defaults,
                 now: 0, secureInput: false) == nil)
}

@Test func invalidUserRegexFailsClosedAsLiteral() {
    // A privacy gate must not fail open: a user exclude that isn't a valid regex
    // (title metacharacters) must still block by literal substring match.
    var cfg = CaptureConfig.defaults
    cfg.excludeTitlePatterns = ["Salary [Confidential"]  // invalid regex ('[' unclosed)
    #expect(gate(bundleId: "com.x", title: "My Salary [Confidential Doc", config: cfg,
                 now: 0, secureInput: false) == .excludedTitle)
    // a title NOT containing the literal is still allowed
    #expect(gate(bundleId: "com.x", title: "Unrelated window", config: cfg,
                 now: 0, secureInput: false) == nil)
}

@Test func builtInDenylistSurvivesUserConfig() throws {
    let json = #"{"excludeBundleIds":["com.custom.app"],"excludeTitlePatterns":["secret project"]}"#
    let path = NSTemporaryDirectory() + "capture-\(UUID()).json"
    try json.write(toFile: path, atomically: true, encoding: .utf8)
    let cfg = CaptureConfig.load(from: path)
    #expect(cfg.effectiveExcludedBundleIds.contains("com.1password.1password"))
    #expect(cfg.effectiveExcludedBundleIds.contains("com.custom.app"))
    #expect(gate(bundleId: "com.x", title: "My Secret Project plan", config: cfg,
                 now: 0, secureInput: false) == .excludedTitle)
}

@Test func corruptConfigFallsBackToDefaults() throws {
    let path = NSTemporaryDirectory() + "capture-\(UUID()).json"
    try "{not json".write(toFile: path, atomically: true, encoding: .utf8)
    #expect(CaptureConfig.load(from: path).retentionDays == 30)
    #expect(CaptureConfig.load(from: "/nonexistent/capture.json").retentionDays == 30)
}

@Test func normalizerCollapsesAndCaps() {
    #expect(normalize("a\u{200B}b   c\n\n\n\nd\te") == "ab c\n\nd e")
    #expect(normalize(String(repeating: "x", count: 60_000)).count == 50_000)
}

@Test func ringBufferDropsOldest() {
    var rb = RingBuffer<Int>(capacity: 3)
    for i in 1...5 { rb.append(i) }
    #expect(rb.drain() == [3, 4, 5])
    #expect(rb.count == 0)
}

@Test func needsOcrForcesBrowsersRegardlessOfAxLength() {
    // browsers: AX serves tab-strip junk, never page bodies — OCR always
    #expect(needsOcr(bundleId: "com.google.Chrome", axCharCount: 5000))
    #expect(needsOcr(bundleId: "com.apple.Safari", axCharCount: 500))
    #expect(needsOcr(bundleId: "com.google.Chrome.canary", axCharCount: 500))
    // native apps: rich AX is trusted, sparse AX falls back to OCR
    #expect(!needsOcr(bundleId: "com.tinyspeck.slackmacgap", axCharCount: 500))
    #expect(needsOcr(bundleId: "com.tinyspeck.slackmacgap", axCharCount: 30))
}

@Test func titleSignatureCollapsesCountsButKeepsNavigation() {
    // unread-count flips must NOT change the signature (no capture spam)
    #expect(titleSignature(bundleId: "com.google.Chrome", title: "Inbox (11) - Gmail")
         == titleSignature(bundleId: "com.google.Chrome", title: "Inbox (12) - Gmail"))
    // leading bullet markers normalized away
    #expect(titleSignature(bundleId: "x", title: "• Inbox") == titleSignature(bundleId: "x", title: "Inbox"))
    // genuine navigation DOES change the signature (fires a capture)
    #expect(titleSignature(bundleId: "com.google.Chrome", title: "Inbox (11) - Gmail")
         != titleSignature(bundleId: "com.google.Chrome", title: "[Need Attention] TAT Pending - Gmail"))
    // same title, different app → different signature
    #expect(titleSignature(bundleId: "com.google.Chrome", title: "Docs")
         != titleSignature(bundleId: "com.apple.Safari", title: "Docs"))
}

@Test func containsSecretCatchesRealTokensNotProse() {
    // real credentials → true
    #expect(containsSecret("Your API Token cfat_K38VwN4gA780TJFA40XVJAmKJFKE6p1DME6TdBR80"))
    #expect(containsSecret("token ghp_abcdefghijklmnopqrstuvwxyz0123456789"))
    #expect(containsSecret("key AKIAIOSFODNN7EXAMPLE here"))
    #expect(containsSecret("-----BEGIN RSA PRIVATE KEY-----"))
    #expect(containsSecret("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"))
    // prose that merely mentions tokens/keys → false (no false positives)
    #expect(!containsSecret("We discussed the API token strategy and access key rotation policy."))
    #expect(!containsSecret("Create a token on the settings page, then paste it into the app."))
}

@Test func decideDropsCaptureContainingASecret() {
    var st = PipelineState()
    let leaked = String(repeating: "dashboard analytics content padding ", count: 4)
        + " Your API Token cfat_K38VwN4gA780TJFA40XVJAmKJFKE6p1DME6TdBR80faedef0"
    let e = CaptureEvent(bundleId: "com.google.Chrome", appName: "Chrome",
                         windowTitle: "Some Dashboard", text: leaked, ts: 1, method: "ocr")
    #expect(decide(event: e, config: .defaults, state: &st, secureInput: false) == nil)
    #expect(st.stats.skips["secret"] == 1)
}

@Test func credentialPageTitleIsGatedPreCapture() {
    let cfg = CaptureConfig.defaults
    // the exact page that leaked the token
    #expect(gate(bundleId: "com.google.Chrome",
                 title: "Account API tokens | Acme Corp's Account | Cloudflare",
                 config: cfg, now: 0, secureInput: false) == .excludedTitle)
    #expect(gate(bundleId: "com.google.Chrome", title: "GitHub — Personal access tokens",
                 config: cfg, now: 0, secureInput: false) == .excludedTitle)
    // a normal page is NOT gated
    #expect(gate(bundleId: "com.google.Chrome", title: "Inbox — Gmail",
                 config: cfg, now: 0, secureInput: false) == nil)
}
