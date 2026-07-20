export type Source = "file" | "browser" | "notes" | "conversation" | "screen" | "meeting";

const MAX = 1600, OVERLAP = 200;

function packParagraphs(paras: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > MAX) {
      out.push(cur);
      cur = cur.slice(-OVERLAP) + "\n\n" + p; // carry overlap into next chunk
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    while (cur.length > MAX) { out.push(cur.slice(0, MAX)); cur = cur.slice(MAX - OVERLAP); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function chunkFor(source: Source, text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (source === "browser" || source === "conversation") return [trimmed];
  // split into heading-delimited sections, pack paragraphs within each
  const sections = trimmed.split(/^(?=#{1,6}\s)/m);
  return sections.flatMap((s) =>
    packParagraphs(s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean))
  );
}
