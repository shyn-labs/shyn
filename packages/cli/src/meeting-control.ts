import { writeFileSync } from "node:fs";
import { join } from "node:path";

// One-shot control signal for the shyn-meeting agent: the agent polls
// meeting-control.json each tick and consumes it (deletes after read).
// "start" begins a recording the detector would never start on its own;
// "stop" ends the session and transcribes; "cancel" ends and discards.
function write(home: string, action: "start" | "stop" | "cancel",
               title?: string, attendees?: string[]): void {
  writeFileSync(join(home, "meeting-control.json"),
    JSON.stringify({ action, title, attendees: attendees?.length ? attendees : undefined,
                     ts: Math.floor(Date.now() / 1000) }) + "\n");
}
// Detection is audio-shaped: the commit gate requires far-side voice on the
// system channel, so a room — where every voice arrives on the microphone —
// is invisible to it by construction. This is the way in. The optional title
// is the only name such a recording can get; there is no tab and no calendar
// entry to infer one from.
export const requestMeetingStart = (home: string, title?: string, attendees: string[] = []) =>
  write(home, "start", title, attendees);

// `shyn meeting start <title words…> [--with "a, b"]`. Everything that is
// not the --with flag and its value is the title. The roster is the one
// fact about a room recording shyn cannot infer, so it can be typed here
// the same way the menu bar form asks for it.
export function parseMeetingStartArgs(rest: string[]): { title: string | undefined; attendees: string[] } {
  const words: string[] = [];
  let attendees: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--with") {
      attendees = (rest[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      i++;
      continue;
    }
    words.push(rest[i]);
  }
  const title = words.join(" ").trim() || undefined;
  return { title, attendees };
}
export const requestMeetingStop = (home: string) => write(home, "stop");
export const requestMeetingCancel = (home: string) => write(home, "cancel");
