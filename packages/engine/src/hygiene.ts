// Ingest hygiene: reject what carries no recall value, canonicalise what is the
// same page twice, and strip interface furniture out of screen captures.
//
// Every rule here was measured against a real 32,238-document corpus first,
// because the guesses were wrong. Recorded so nobody re-guesses:
//
//   browser 23,502 (73%) · screen 8,664 · notes 36 · meeting 34 · file 4
//   auth/redirect plumbing ............ 2,012 docs (6.2% of corpus)
//   surgical URL canonicalisation ....... 647 docs (2.0%)
//   "pure chrome" screen docs ............. 1 in 500  (assumed common — it is not)
//   duplicate lines within a screen doc ... 14.9%      (modest)
//   Chrome furniture lines .............. in ~53% of screen docs
//
// And the rule that was NOT written, with the number that stopped it: stripping
// the fragment and query from browser URLs would have collapsed 14,749 docs
// (45.8%). It looked like the big win. It was Gmail and Google Search, whose
// document identity lives in exactly those parts — 4,992 distinct emails behind
// one `mail.google.com/mail/u/0`. Canonicalisation must be surgical or it
// destroys the corpus it is meant to clean.

/// Auth, OAuth consent and redirect interstitials. Zero recall value: nobody
/// searches their memory for a sign-in page. Rejected at ingest, never stored.
const PLUMBING = [
  /^https?:\/\/accounts\.google\.com\//i,
  /^https?:\/\/accounts\.zoho\.[a-z.]+\//i,
  /^https?:\/\/[^/]+\/url\?/i,                 // google.com/url?… redirect hops
  /^https?:\/\/[^/]+\/(signin|sign-in|login|oauth2?|auth)(\/|\?|$)/i,
  /^https?:\/\/[^/]+\/v\d+\/signin/i,
];

export function isPlumbingUri(uri: string): boolean {
  return PLUMBING.some((re) => re.test(uri));
}

/// Query parameters that never identify a page: session/UI state, mail-client
/// view flags, analytics. Deliberately an ALLOW-nothing list rather than a
/// deny-everything rule — `q` (search terms), `v` (YouTube video) and the
/// fragment are what make those URLs distinct and are always preserved.
const NOISE_PARAMS = new Set([
  "authuser", "compose", "projector", "messagePartId", "usp", "ved", "sca_esv",
  "source", "sourceid", "ie", "oe", "gs_lcrp", "hl", "gs_lp", "sclient",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "ref", "ref_src",
]);

const stripNoise = (query: string): string => {
  const p = new URLSearchParams(query);
  for (const k of [...p.keys()]) if (NOISE_PARAMS.has(k)) p.delete(k);
  return p.toString();
};

export function canonicalUri(uri: string): string {
  // http(s) ONLY. `new URL("screen://app/hash/bucket").origin` returns the
  // literal string "null" for non-special schemes, so canonicalising our own
  // screen:// and meeting:// URIs would rewrite the identity of every capture
  // (8,664 screen docs) and break the hourly-bucket replace. Caught by a test,
  // which is the only reason this comment exists rather than a bug report.
  if (!/^https?:\/\//i.test(uri)) return uri;
  let url: URL;
  try { url = new URL(uri); } catch { return uri; }

  const search = stripNoise(url.search);
  // SPA noise lives INSIDE the fragment: Gmail writes
  // `#inbox/<threadId>?compose=new` and `?projector=1&messagePartId=0.1`, so the
  // junk never reaches url.search. Strip it there too — this is the actual
  // mechanism behind the duplicate-document count.
  let hash = url.hash;
  const qIn = hash.indexOf("?");
  if (qIn !== -1) {
    const inner = stripNoise(hash.slice(qIn + 1));
    hash = hash.slice(0, qIn) + (inner ? `?${inner}` : "");
  }
  // Trailing slash is not identity; the fragment IS (Gmail, Slack, SPAs).
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}${search ? `?${search}` : ""}${hash}`;
}

/// Browser and OS interface labels that an AX read or OCR pass picks up on every
/// capture. Measured in ~53% of screen documents, so as search terms they carry
/// no information and only dilute BM25 and the embeddings.
///
/// Deliberately GENERIC — browser and window-manager affordances only. A user's
/// own bookmark-folder names also recur on every capture, but they are personal
/// vocabulary, not furniture, and cannot be recognised without corpus-frequency
/// statistics this function does not have. Left in on purpose.
const FURNITURE = new Set([
  "back", "forward", "reload", "extensions", "bookmarks", "address and search bar",
  "tab groups", "saved tab groups", "reading list", "reading list – pinned",
  "reading list - pinned", "new tab", "close", "minimize", "maximize", "zoom",
  "chrome", "safari", "search tabs", "view site information", "show history",
  "back in history", "forward in history", "show workspace switcher",
  "history navigation", "main navigation", "customize and control google chrome",
]);

export function stripScreenFurniture(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (FURNITURE.has(key)) continue;
    // Within-doc repetition (14.9% of lines) is an artefact of reading the same
    // pane twice, never meaning. Keep the first occurrence only.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join("\n");
}

/// Meeting metadata is captured but was never searchable: FTS indexes chunk
/// text, and the calendar title and attendee list live in meta_json. Prepending
/// one header line makes "who did I meet with" answerable, and reads better at
/// the top of a transcript than it would as invisible metadata.
export function metaHeader(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const title = typeof meta.calTitle === "string" ? meta.calTitle.trim() : "";
  const attendees = typeof meta.attendees === "string" ? meta.attendees.trim() : "";
  if (!title && !attendees) return null;
  const parts = [title && `Meeting: ${title}`, attendees && `Attendees: ${attendees}`];
  return parts.filter(Boolean).join(" · ");
}
