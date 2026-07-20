// Minimal protobuf wire-format walker: collects every length-delimited field
// that decodes as valid UTF-8 (recursing into ones that parse as messages)
// and returns the longest string found. Good enough to pull the body text out
// of an Apple Notes gzipped document without a schema.
function readVarint(buf: Buffer, pos: number): { value: number; next: number } | null {
  let value = 0, shift = 0, p = pos;
  while (p < buf.length && shift <= 35) {
    const b = buf[p++];
    // Accumulate with multiplication rather than bitwise ops: bitwise operators
    // in JS coerce to 32-bit ints and lose precision once shift exceeds 31 bits.
    // The values here stay well within Number.isSafeInteger range.
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: p };
    shift += 7;
  }
  return null;
}

// Walks `buf` as a protobuf message. Returns null on ANY structural parse
// failure (bad varint, truncated field, unsupported wire type) — that's the
// signal to the caller that `buf` is not a message, so it should be treated
// as leaf text instead. On success, returns the candidate strings gathered
// from its length-delimited fields (leaf-preferring: see below).
//
// For each length-delimited field, we first try to recurse into it. If that
// recursion succeeds AND yields at least one real candidate string, we take
// those child candidates and discard the field's own raw bytes — the raw
// bytes are just tag/len framing glued onto the child's payload, spuriously
// *longer* than the child's real text by that framing overhead. But if the
// slice does NOT parse as a message, OR it parses as an (structurally valid)
// empty message with no candidates of its own — which happens easily for
// short strings that incidentally decode as tag+varint — we fall back to
// treating the slice itself as leaf text. This preserves the original fix
// (containers lose to their own real child text) while guaranteeing that
// short/leaf strings and deeply-nested (depth-capped) text are never
// silently dropped.
function parseMessage(buf: Buffer, depth: number): string[] | null {
  const out: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) return null;
    const wireType = tag.value & 7;
    pos = tag.next;
    if (wireType === 0) {            // varint
      const v = readVarint(buf, pos); if (!v) return null; pos = v.next;
    } else if (wireType === 1) {     // 64-bit
      pos += 8;
    } else if (wireType === 5) {     // 32-bit
      pos += 4;
    } else if (wireType === 2) {     // length-delimited
      const len = readVarint(buf, pos); if (!len) return null;
      const start = len.next, end = start + len.value;
      if (end > buf.length) return null;
      const slice = buf.subarray(start, end);
      const children = depth < 6 ? parseMessage(slice, depth + 1) : null;
      if (children !== null && children.length > 0) {
        out.push(...children);       // real container: use its child text
      } else {
        const text = slice.toString("utf8");
        if (!text.includes("�") && /\S/.test(text)) out.push(text);
      }
      pos = end;
    } else return null;              // wire types 3/4 (groups) unsupported
  }
  return out;
}

export function extractLongestString(buf: Buffer): string | null {
  const candidates = parseMessage(buf, 0) ?? [];
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}
