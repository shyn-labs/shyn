import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// Anchor every path to the repo root (scripts/ is one level below it) so the
// script is cwd-independent — a relative rmSync run from the wrong working
// directory would silently damage whatever tree it lands in.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!ROOT.endsWith("/shyn")) {
  throw new Error(`Refusing to build: resolved root is not the shyn project: ${ROOT}`);
}

const PKG = join(ROOT, "packages/capture-agent");
execFileSync("swift", ["build", "-c", "release", "--package-path", PKG], {
  stdio: "inherit",
  cwd: ROOT,
});

// Signing identity is parameterized (SP2 spike finding: *ad-hoc* signing —
// `-s -`, no stable identity — gets NO effective Screen Recording grant). The
// fix is a STABLE code-signing identity so the app has a persistent designated
// requirement TCC can pin grants to. That does NOT require a paid Developer ID:
// a free local self-signed cert works for your own machine (run
// scripts/setup-signing.sh to create "Shyn Dev"). A Developer ID is only needed
// to *distribute* to other machines (notarization). Set SHYN_CODESIGN_IDENTITY
// to the identity name; unset → ad-hoc "-" (AX-only, OCR self-gates off;
// meeting agent's mic/system-audio grants also won't stick).
const identity = process.env.SHYN_CODESIGN_IDENTITY ?? "-";

function buildApp(name: string, bundleId: string, extraPlistKeys = "") {
  const app = join(ROOT, `dist/capture/${name}.app/Contents`);
  mkdirSync(join(app, "MacOS"), { recursive: true });
  cpSync(join(PKG, `.build/release/${name}`), join(app, `MacOS/${name}`));
  writeFileSync(join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Elastic License 2.0</string>${extraPlistKeys}
</dict></plist>
`);
  execFileSync("codesign", ["--force", "--sign", identity, join(ROOT, `dist/capture/${name}.app`)],
    { stdio: "inherit", cwd: ROOT });
  console.log(identity === "-"
    ? `dist/capture/${name}.app ready (ad-hoc — set SHYN_CODESIGN_IDENTITY for full TCC)`
    : `dist/capture/${name}.app ready (signed: ${identity})`);
}

rmSync(join(ROOT, "dist/capture"), { recursive: true, force: true });
buildApp("shyn-capture", "com.shyn.capture");
// Usage strings: mic prompt + kTCCServiceAudioCapture (process tap) — both
// required for the prompts to appear at all (spike finding: a binary without
// them dies silently or never prompts).
buildApp("shyn-meeting", "com.shyn.meeting", `
  <key>NSMicrophoneUsageDescription</key><string>Shyn transcribes your meetings locally.</string>
  <key>NSAudioCaptureUsageDescription</key><string>Shyn records system audio during meetings to transcribe the other side of the call locally.</string>`);
