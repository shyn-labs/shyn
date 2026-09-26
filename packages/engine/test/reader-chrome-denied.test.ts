import { describe, it, expect, vi, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A home whose Chrome folder cannot be listed: what TCC does to a process
// without Full Disk Access (EPERM there; EACCES from chmod 000 here).
const home = mkdtempSync(join(tmpdir(), "shyn-home-"));
const chrome = join(home, "Library", "Application Support", "Google", "Chrome");
mkdirSync(join(chrome, "Default"), { recursive: true });
chmodSync(chrome, 0o000);
afterAll(() => chmodSync(chrome, 0o755));

vi.mock("node:os", async (orig) => ({
  ...(await orig<typeof import("node:os")>()),
  homedir: () => home,
}));

describe("ChromeHistoryReader without folder access", () => {
  // Lived 2026-09-26: the scandir threw out of the constructor and took the
  // whole daemon down at startup.
  it("constructs, and reports the Full Disk Access hint instead of throwing", async () => {
    const { ChromeHistoryReader } = await import("../src/readers/chrome.js");
    const reader = new ChromeHistoryReader();
    const a = await reader.available();
    expect(a.ok).toBe(false);
    expect(a.ok ? "" : a.reason).toMatch(/Full Disk Access/);
  });
});
