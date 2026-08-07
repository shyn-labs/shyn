import { describe, it, expect } from "vitest";
import { isPlumbingUri, canonicalUri, stripScreenFurniture, metaHeader } from "../src/hygiene.js";

// Every case below is drawn from the real 32,238-document corpus these rules
// were measured against, not from imagination.

describe("isPlumbingUri", () => {
  it("rejects auth, OAuth and redirect interstitials", () => {
    // 2,012 docs (6.2% of the corpus) — 818 share the title "Sign in – Google accounts".
    expect(isPlumbingUri("https://accounts.google.com/ServiceLogin")).toBe(true);
    expect(isPlumbingUri("https://accounts.google.com/signin/oauth/consent?x=1")).toBe(true);
    expect(isPlumbingUri("https://accounts.google.com/v3/signin/accountchooser")).toBe(true);
    expect(isPlumbingUri("https://www.google.com/url?q=https://example.com")).toBe(true);
    expect(isPlumbingUri("https://accounts.zoho.in/signin?servicename=AaaServer")).toBe(true);
  });

  it("keeps real pages, including ones that merely mention login", () => {
    expect(isPlumbingUri("https://mail.google.com/mail/u/0/#inbox/FMfcgzQ")).toBe(false);
    expect(isPlumbingUri("https://www.google.com/search?q=rbi+e-mandate")).toBe(false);
    expect(isPlumbingUri("https://example.com/blog/how-to-login-securely")).toBe(false);
    expect(isPlumbingUri("meeting://com.google.Chrome/2026-08-07-1100")).toBe(false);
  });
});

describe("canonicalUri", () => {
  it("PRESERVES the fragment — it is Gmail's document identity", () => {
    // The rule that was not written: stripping fragments collapsed 14,749 docs,
    // 4,992 of them distinct emails behind one mail.google.com/mail/u/0.
    const a = canonicalUri("https://mail.google.com/mail/u/0/#inbox/FMfcgzQhVhdzMKFQ");
    const b = canonicalUri("https://mail.google.com/mail/u/0/#inbox/OTHERTHREADID");
    expect(a).not.toBe(b);
    expect(a).toContain("#inbox/FMfcgzQhVhdzMKFQ");
  });

  it("PRESERVES search terms and video ids", () => {
    expect(canonicalUri("https://www.google.com/search?q=rbi+mandate&ved=xyz"))
      .toBe("https://www.google.com/search?q=rbi+mandate");
    expect(canonicalUri("https://www.youtube.com/watch?v=abc123&utm_source=x"))
      .toBe("https://www.youtube.com/watch?v=abc123");
  });

  it("collapses the same page reached with different UI state", () => {
    // The observed case: one Chat thread stored as several docs differing only
    // by compose/projector/messagePartId/authuser.
    const base = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQ";
    expect(canonicalUri(`${base}?compose=new`)).toBe(canonicalUri(base));
    expect(canonicalUri(`${base}?projector=1&messagePartId=0.1`)).toBe(canonicalUri(base));
    expect(canonicalUri("https://x.example/p?authuser=0")).toBe("https://x.example/p");
  });

  it("normalises a trailing slash and leaves non-URLs alone", () => {
    expect(canonicalUri("https://example.com/path/")).toBe("https://example.com/path");
    expect(canonicalUri("screen://com.apple.finder/abc/2026-08-07-11"))
      .toBe("screen://com.apple.finder/abc/2026-08-07-11");
    expect(canonicalUri("not a url at all")).toBe("not a url at all");
  });
});

describe("stripScreenFurniture", () => {
  it("removes browser chrome measured in ~53% of screen docs", () => {
    const out = stripScreenFurniture([
      "Back", "Forward", "Reload", "Extensions", "Address and search bar",
      "Bookmarks", "Tab groups", "Saved tab groups",
      "the crediting start date is what matters",
    ].join("\n"));
    expect(out).toBe("the crediting start date is what matters");
  });

  it("drops within-doc repetition (14.9% of lines) but keeps the first", () => {
    const out = stripScreenFurniture("Slack — arr-tech-pod\nSlack — arr-tech-pod\nreal content here");
    expect(out).toBe("Slack — arr-tech-pod\nreal content here");
  });

  it("never strips a line merely because it is short or capitalised", () => {
    const out = stripScreenFurniture("Q3\nOKR\nARR standup notes");
    expect(out).toBe("Q3\nOKR\nARR standup notes");
  });

  it("survives an all-furniture capture without throwing", () => {
    expect(stripScreenFurniture("Back\nForward\nReload")).toBe("");
  });
});

describe("metaHeader", () => {
  it("makes the calendar title and attendees searchable", () => {
    expect(metaHeader({ calTitle: "ARR Standup", attendees: "Sam, Alex" }))
      .toBe("Meeting: ARR Standup · Attendees: Sam, Alex");
    expect(metaHeader({ calTitle: "ARR Standup" })).toBe("Meeting: ARR Standup");
  });

  it("returns null when there is nothing to add", () => {
    expect(metaHeader(undefined)).toBeNull();
    expect(metaHeader({})).toBeNull();
    expect(metaHeader({ app: "Google Chrome", bundleId: "com.google.Chrome" })).toBeNull();
    expect(metaHeader({ calTitle: "   " })).toBeNull();
  });
});

describe("ingest hygiene end to end", () => {
  it("counts a rejected document as rejected, never as ingested", async () => {
    // The bug this guards: `if (deduped) deduped++; else ingested++;` counted
    // every rejection as an ingest, so reader stats would claim credit for
    // 2,428 documents that were thrown away.
    const { Engine } = await import("../src/engine.js");
    const { StaticKeyProvider } = await import("../src/keys.js");
    const { Embedder } = await import("../src/embedder.js");
    const { EMBEDDING_DIM } = await import("../src/storage.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const e = new Engine({
      dbPath: join(mkdtempSync(join(tmpdir(), "shyn-")), "t.db"),
      keyProvider: new StaticKeyProvider(null),
      embedder: new Embedder(async () => ({
        embed: async () => new Float32Array(EMBEDDING_DIM), dispose: async () => {},
      }) as any),
    });
    const reader = {
      name: "mixed", available: async () => ({ ok: true as const }),
      read: async () => [
        { source: "browser" as const, uri: "https://accounts.google.com/ServiceLogin",
          title: "Sign in – Google accounts", ts: 1000, text: "Sign in – Google accounts" },
        { source: "browser" as const, uri: "https://example.com/real?utm_source=x",
          title: "A real page", ts: 1001, text: "A real page worth remembering" },
      ],
    };
    const [r] = await e.syncReaders([reader as any]);
    expect(r.rejected).toBe(1);
    expect(r.ingested).toBe(1);
    // And the surviving doc was stored under its canonical URL.
    expect(e.document({ uri: "https://example.com/real" })).not.toBeNull();
    expect(e.document({ uri: "https://accounts.google.com/ServiceLogin" })).toBeNull();
    await e.close();
  });
});
