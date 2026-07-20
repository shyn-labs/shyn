import { writeFileSync } from "node:fs";
import { join } from "node:path";

// One-shot control signal for the shyn-meeting agent: the agent polls
// meeting-control.json each tick and consumes it (deletes after read).
// "stop" ends the session and transcribes; "cancel" ends and discards.
function write(home: string, action: "stop" | "cancel"): void {
  writeFileSync(join(home, "meeting-control.json"),
    JSON.stringify({ action, ts: Math.floor(Date.now() / 1000) }) + "\n");
}
export const requestMeetingStop = (home: string) => write(home, "stop");
export const requestMeetingCancel = (home: string) => write(home, "cancel");
