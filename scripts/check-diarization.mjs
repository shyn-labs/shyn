#!/usr/bin/env node
// Release gate (spec 2026-10-05): DER on the AMI ES2004a clip must stay within
// the spike baseline. Spike: 11.7% with 1.0s same-speaker bridging; gate 15%.
// Scored the way the spike scored it (0.25 s collar, overlap scored, no UEM) so the number is
// comparable to 11.7%; it is an internal regression gate, not a published-AMI figure.
// Needs: the AMI clip + reference RTTM (spikes/diarization-probe/scripts/fetch-ami.sh on
// branch spike/diarization), the diarizer models downloaded, and `uv`.
// Isolated by default: the binary runs with SHYN_HOME=<AMI dir>/../home (the spike's own home),
// never the real shyn home. Set SHYN_HOME yourself to use another model cache.
// Exit codes: 0 = DER within the gate, 1 = DER over the gate, 2 = setup or tool failure.
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AMI = process.env.SHYN_AMI_DIR ?? join(process.env.HOME, "Library/Application Support/shyn-spike/ami");
const wav = join(AMI, "ES2004a.wav"), ref = join(AMI, "ES2004a.ref.rttm");
const bin = join(root, "packages/capture-agent/.build/release/shyn-meeting");
const GATE = 0.15;
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(2); };
const oneLine = (e) => String(e?.stderr || e?.message || e).trim().split("\n").filter(Boolean).pop() ?? "unknown failure";
const shynHome = process.env.SHYN_HOME ?? join(process.env.HOME, "Library/Application Support/shyn-spike/home");
for (const f of [wav, ref, bin]) if (!existsSync(f)) { console.error(`missing: ${f}`); process.exit(2); }

const hyp = join(mkdtempSync(join(tmpdir(), "shyn-der-")), "hyp.rttm");
console.log(`SHYN_HOME ${shynHome}`);
try {
  writeFileSync(hyp, execFileSync(bin, ["diarize", wav, "--rttm"],
    { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, SHYN_HOME: shynHome } }));
} catch (e) { fail(`diarize failed (models not downloaded?): ${oneLine(e)}`); }
let der;
try {
  der = Number(execFileSync("uv", ["run", "--with", "pyannote.metrics>=3.2", "--with", "pyannote.core>=5",
  "python3", "-c",
  `import sys
from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate
def load(path):
    ann = Annotation()
    for i, line in enumerate(l for l in open(path) if l.split()[:1] == ["SPEAKER"]):
        f = line.split(); start, dur = float(f[3]), float(f[4])
        ann[Segment(start, start + dur), i] = f[7]
    return ann
print(DiarizationErrorRate(collar=0.25, skip_overlap=False)(load(sys.argv[1]), load(sys.argv[2])))`,
  ref, hyp], { encoding: "utf8" }).trim());
} catch (e) { fail(`scoring failed (is uv installed?): ${oneLine(e)}`); }
if (!Number.isFinite(der)) fail("scorer printed no DER");
console.log(`DER ${(der * 100).toFixed(1)}% — gate ${(GATE * 100).toFixed(0)}%`);
process.exit(der <= GATE ? 0 : 1);
