#!/usr/bin/env node
// Release gate (spec 2026-10-05): DER on the AMI ES2004a clip must stay within
// the spike baseline. Spike: 11.7% with 1.0s same-speaker bridging; gate 15%.
// Scored the way the spike scored it (0.25 s collar, overlap scored, no UEM) so the number is
// comparable to 11.7%; it is an internal regression gate, not a published-AMI figure.
// Needs: the AMI clip + reference RTTM (spikes/diarization-probe/scripts/fetch-ami.sh on
// branch spike/diarization), the diarizer models downloaded, and `uv`.
// The caller's environment goes to the binary untouched, so SHYN_HOME selects the model cache.
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
for (const f of [wav, ref, bin]) if (!existsSync(f)) { console.error(`missing: ${f}`); process.exit(2); }

const hyp = join(mkdtempSync(join(tmpdir(), "shyn-der-")), "hyp.rttm");
writeFileSync(hyp, execFileSync(bin, ["diarize", wav, "--rttm"], { encoding: "utf8", maxBuffer: 64 << 20 }));
const der = Number(execFileSync("uv", ["run", "--with", "pyannote.metrics>=3.2", "--with", "pyannote.core>=5",
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
console.log(`DER ${(der * 100).toFixed(1)}% — gate ${(GATE * 100).toFixed(0)}%`);
process.exit(der <= GATE ? 0 : 1);
