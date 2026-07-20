import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poll } from "../src/poll.js";

describe("poll", () => {
  it("ok:false when socket absent (no throw)", async () => {
    expect(await poll(join(mkdtempSync(join(tmpdir(), "shyn-poll-")), "no.sock"))).toEqual({ ok: false });
  });

  it("ok:true with the daemon's status result", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "shyn-poll-")), "s.sock");
    const server = createServer((c) => c.on("data", (d) => {
      const req = JSON.parse(d.toString());
      c.write(JSON.stringify({ jsonrpc: "2.0", id: req.id,
        result: { documents: 5, daemonVersion: "0.2.0" } }) + "\n");
    }));
    await new Promise<void>((res) => server.listen(sock, res));
    try {
      const r = await poll(sock);
      expect(r).toMatchObject({ ok: true, status: { documents: 5 } });
    } finally { server.close(); }
  });
});
