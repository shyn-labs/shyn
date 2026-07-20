import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../src/setup.js";

function mkPayload(root: string) {
  // payload carries a real dist/: daemon bundle + three apps, plus cli/mcp bundles + signing script at root
  mkdirSync(join(root, "dist", "daemon", "bin"), { recursive: true });
  writeFileSync(join(root, "dist", "daemon", "daemon.mjs"), "// daemon");
  writeFileSync(join(root, "dist", "daemon", "bin", "node"), "#!/bin/sh\n");
  for (const app of ["capture/shyn-capture.app", "capture/shyn-meeting.app", "status/shyn-status.app"]) {
    const bin = join(root, "dist", app, "Contents", "MacOS");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, app.split("/")[1].replace(".app", "")), "#!/bin/sh\n");
  }
  mkdirSync(join(root, "cli"), { recursive: true });
  writeFileSync(join(root, "cli", "main.mjs"), "// cli");
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(join(root, "mcp", "index.mjs"), "// mcp");
  mkdirSync(join(root, "setup"), { recursive: true });
  writeFileSync(join(root, "setup", "setup-signing.sh"), "#!/bin/bash\n");
}

const deps = (base: string) => {
  const calls: string[][] = [];
  return {
    calls,
    d: {
      payloadRoot: join(base, "payload"),
      shynHome: join(base, "home"),
      launchAgentsDir: join(base, "LaunchAgents"),
      logDir: join(base, "Logs"),
      exec: (c: string, a: string[]) => calls.push([c, ...a]),
      print: () => {},
    },
  };
};

describe("shyn setup (payload mode)", () => {
  it("signs, clears quarantine, stages all four services, installs cli+mcp shims", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-setup-"));
    mkPayload(join(base, "payload"));
    const { calls, d } = deps(base);
    const res = await runSetup(d);
    expect(res.ok).toBe(true);
    // identity mint via the shipped script
    expect(calls.some((c) => c[0] === "bash" && c[1].endsWith("setup-signing.sh"))).toBe(true);
    // quarantine cleared on the payload
    expect(calls.some((c) => c[0] === "xattr" && c.includes("com.apple.quarantine"))).toBe(true);
    // each app re-signed with the local identity
    const signed = calls.filter((c) => c[0] === "codesign");
    expect(signed.length).toBe(3);
    for (const c of signed) expect(c).toContain("Shyn Dev");
    // all four services bootstrapped
    const boots = calls.filter((c) => c[0] === "launchctl" && c[1] === "bootstrap");
    expect(boots.length).toBe(4);
    // daemon plist points at the staged vendored node
    const plist = readFileSync(join(d.launchAgentsDir, "com.shyn.daemon.plist"), "utf8");
    expect(plist).toContain(join(d.shynHome, "bin", "daemon", "bin", "node"));
    // mcp bundle staged with shim
    expect(existsSync(join(d.shynHome, "bin", "mcp", "index.mjs"))).toBe(true);
    const mcpShim = readFileSync(join(d.shynHome, "bin", "shyn-mcp"), "utf8");
    expect(mcpShim).toContain(join(d.shynHome, "bin", "daemon", "bin", "node"));
    expect(mcpShim).toContain(join(d.shynHome, "bin", "mcp", "index.mjs"));
  });

  it("fails loudly on a payload missing pieces", async () => {
    const base = mkdtempSync(join(tmpdir(), "shyn-setup-"));
    mkdirSync(join(base, "payload"), { recursive: true });   // empty payload
    const { d } = deps(base);
    const res = await runSetup(d);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toMatch(/daemon/);
  });
});
