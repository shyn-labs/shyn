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

// All sources share one chunker. browser docs (title\nurl one-liners) come
// out as a single chunk regardless; conversation docs usually do too, but an
// oversized pasted `remember` must split — the embedder truncates input at
// EMBED_MAX_INPUT_TOKENS, so a monolithic chunk would only be searchable
// semantically by its head. Search dedups multi-chunk docs via PER_DOC_CAP.
export function chunkFor(source: Source, text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // split into heading-delimited sections, pack paragraphs within each
  const sections = trimmed.split(/^(?=#{1,6}\s)/m);
  return sections.flatMap((s) =>
    packParagraphs(s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean))
  );
}
