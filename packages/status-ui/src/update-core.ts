// Browser-safe half of the update machinery: imported by the renderer
// bundle (platform: "browser" — no node builtins allowed) and by derive.
// Filesystem/spawn helpers live in update.ts, which re-exports this file.

export const UPGRADE_COMMAND = "brew update && brew upgrade --cask shyn && shyn setup";

export const RELEASES_URL =
  "https://api.github.com/repos/shyn-labs/homebrew-tap/releases/latest";

// "0.4.13-alpha" scheme: compare the numeric dotted prefix, ignore the
// suffix. null on malformed input — a bad tag must never look like an update.
export function compareShynVersions(a: string, b: string): number | null {
  const parse = (s: string): number[] | null => {
    const m = s.replace(/^v/, "").match(/^(\d+(?:\.\d+)*)/);
    return m ? m[1].split(".").map(Number) : null;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Silent on every failure: offline is a normal state, never a warning.
export async function checkLatest(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const r = await fetchFn(RELEASES_URL, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) return null;
    const tag = (await r.json() as { tag_name?: unknown })?.tag_name;
    return typeof tag === "string" && tag.length > 0 ? tag.replace(/^v/, "") : null;
  } catch { return null; }
}
