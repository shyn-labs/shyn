import Testing
import Foundation
@testable import CaptureCore

private struct Boom: Error {}

@Test func fastWorkReturnsItsValue() async throws {
    let v = try await withTimeout(seconds: 5) { 42 }
    #expect(v == 42)
}

@Test func slowWorkHitsTheLimitAndReturnsNil() async throws {
    let t0 = Date()
    let v: Int? = try await withTimeout(seconds: 0.05) {
        try await Task.sleep(for: .seconds(10))
        return 1
    }
    #expect(v == nil)
    #expect(Date().timeIntervalSince(t0) < 5)
}

@Test func workThatIgnoresCancellationStillLetsTheCallerMoveOn() async throws {
    // A CoreML call may not honour cancellation: the caller must not wait for it.
    let t0 = Date()
    let v: Int? = try await withTimeout(seconds: 0.05) {
        usleep(1_000_000)
        return 1
    }
    #expect(v == nil)
    #expect(Date().timeIntervalSince(t0) < 0.8)
}

@Test func workErrorsPropagate() async {
    await #expect(throws: Boom.self) {
        let _: Int? = try await withTimeout(seconds: 5) { throw Boom() }
    }
}
