import { rpcCall } from "@shyn/daemon/rpc";

// Fire-and-forget onboarding handshake: tells the daemon a real MCP client
// exists (status.lastMcpHelloTs). Must NEVER fail startup — a down daemon
// is already reported to the model by the tools themselves. Returns whether
// the daemon acked, so startHelloLoop can tell a stamp from a drop.
export async function sendHello(sock: string): Promise<boolean> {
  try { await rpcCall(sock, "hello", { client: "mcp" }, 1500); return true; }
  catch { return false; }
}

// One hello per shim process proved too fragile: if the daemon is down or
// mid-restart at the exact moment Claude launches the shim, the stamp is
// silently dropped and stays stale for the shim's multi-day lifetime (lived
// 2026-07-17). Retry until the first ack, then refresh on a slow cadence so
// status's "last hello" tracks liveness. Timers are unref'd — the loop must
// never keep the shim alive once stdio closes. Returns a stop function.
export function startHelloLoop(
  sock: string, opts: { retryMs?: number; refreshMs?: number } = {},
): () => void {
  const retryMs = opts.retryMs ?? 60_000;
  const refreshMs = opts.refreshMs ?? 3_600_000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const attempt = async () => {
    const acked = await sendHello(sock);
    if (stopped) return;
    timer = setTimeout(attempt, acked ? refreshMs : retryMs);
    timer.unref();
  };
  void attempt();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
