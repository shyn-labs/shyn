import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const DAEMON_DOWN_CODES = new Set(["ECONNREFUSED", "ENOENT"]);

/** True when `err` means "no daemon is listening on this socket" (missing
 * socket file, or a stale one nothing is bound to) as opposed to any other
 * RPC failure. */
export function isDaemonDownError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && DAEMON_DOWN_CODES.has(code);
}

let nextId = 1;
export function rpcCall(
  socketPath: string, method: string, params: unknown, timeoutMs = 30_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const id = nextId++;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`rpc timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    timer.unref();
    const fail = (err: Error) => { clearTimeout(timer); reject(err); };
    socket.on("error", fail);
    const rl = createInterface({ input: socket });
    // readline's Interface re-emits its input stream's 'error' on itself; with
    // no listener there Node treats it as a second, unhandled 'error' event
    // (on top of the socket's own, which `fail` above already handles) and
    // crashes the process. `fail` is idempotent (reject() only settles once),
    // so wiring it here too just silences that duplicate.
    rl.on("error", fail);
    rl.once("line", (line) => {
      clearTimeout(timer);
      socket.end();
      try {
        const msg = JSON.parse(line);
        if (msg.error) {
          const e = new Error(msg.error.message);
          (e as any).code = msg.error.code;
          reject(e);
        } else resolve(msg.result);
      } catch (e) { reject(e as Error); }
    });
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
