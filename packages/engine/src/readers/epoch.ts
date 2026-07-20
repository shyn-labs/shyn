const WEBKIT_TO_UNIX_OFFSET_S = 11644473600;
const MAC_TO_UNIX_OFFSET_S = 978307200;

export const webkitToUnix = (webkitMicros: number): number =>
  Math.floor(webkitMicros / 1e6) - WEBKIT_TO_UNIX_OFFSET_S;

export const macToUnix = (macSeconds: number): number =>
  Math.floor(macSeconds) + MAC_TO_UNIX_OFFSET_S;
