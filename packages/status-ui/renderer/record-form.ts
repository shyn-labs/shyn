// The record form's one output: the argument of the "meeting-start" action.
// Pure, so the renderer entry stays wiring and this stays testable.
//
// The form exists because a room recording's name and roster cannot be
// inferred. Every voice is on one channel, there is no tab and often no
// calendar entry that fits — a Singapore bootcamp session was filed as
// "ARR Standup · WhatsApp" (2026-09-11). The user knows what the room is.

export function parseAttendees(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t) out.push(t);
  }
  return out;
}

export function startActionArg(title: string, attendees: string): string {
  const t = title.trim();
  const a = parseAttendees(attendees);
  const payload: { title?: string; attendees?: string[] } = {};
  if (t) payload.title = t;
  if (a.length) payload.attendees = a;
  return JSON.stringify(payload);
}
