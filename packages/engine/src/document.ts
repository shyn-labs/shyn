import { OVERLAP } from "./chunk.js";

export type DocumentResult = {
  docId: number;
  source: string;
  uri: string;
  title: string;
  ts: number;
  text: string;
  chunkCount: number;
};

// Reassemble a document from its chunks. chunkFor carries OVERLAP characters
// from the tail of one chunk into the head of the next, so adjacent chunks
// from the SAME section share a prefix/suffix that must be stripped exactly
// once. Chunks from DIFFERENT heading-split sections share nothing, and the
// blank line that separated them was consumed at chunk time — restore it.
//
// Not byte-identical to the original input: chunkFor already normalises
// paragraph breaks (splits on /\n{2,}/, rejoins with "\n\n"), so runs of 3+
// blank lines were collapsed at ingest. Pre-existing, and irrelevant for
// transcripts whose segments are single lines.
export function joinChunks(chunks: string[]): string {
  let out = "";
  for (const c of chunks) {
    if (!out) { out = c; continue; }
    const max = Math.min(OVERLAP, out.length, c.length);
    let k = 0;
    for (let n = max; n > 0; n--) {
      if (out.endsWith(c.slice(0, n))) { k = n; break; }
    }
    out += k > 0 ? c.slice(k) : `\n\n${c}`;
  }
  return out;
}
