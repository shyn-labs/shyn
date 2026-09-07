import { writeFileSync } from "node:fs";
import { join } from "node:path";

// One-shot control signal for the shyn-meeting agent: the agent polls
// meeting-control.json each tick and consumes it (deletes after read).
// "start" begins a recording the detector would never start on its own;
// "stop" ends the session and transcribes; "cancel" ends and discards.
function write(home: string, action: "start" | "stop" | "cancel",
               title?: string): void {
  writeFileSync(join(home, "meeting-control.json"),
    JSON.stringify({ action, title, ts: Math.floor(Date.now() / 1000) }) + "\n");
}
// Detection is audio-shaped: the commit gate requires far-side voice on the
// system channel, so a room — where every voice arrives on the microphone —
// is invisible to it by construction. This is the way in. The optional title
// is the only name such a recording can get; there is no tab and no calendar
// entry to infer one from.
export const requestMeetingStart = (home: string, title?: string) =>
  write(home, "start", title);
export const requestMeetingStop = (home: string) => write(home, "stop");
export const requestMeetingCancel = (home: string) => write(home, "cancel");
