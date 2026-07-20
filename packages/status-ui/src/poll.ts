import { rpcCall } from "@shyn/daemon/rpc";
import type { PollResult, WeekStats } from "./derive.js";

// One cheap local RPC; 2s timeout so a wedged daemon reads as down by the
// next 3s tick instead of stacking calls.
export async function poll(sock: string): Promise<PollResult> {
  try {
    const status = await rpcCall(sock, "status", {}, 2000);
    let stats: WeekStats | undefined;
    // Older daemons have no stats method; the popover degrades to no section.
    try { stats = await rpcCall(sock, "stats", { days: 7 }, 2000); } catch { /* absent on old daemons */ }
    return { ok: true, status, stats };
  } catch {
    return { ok: false };
  }
}
