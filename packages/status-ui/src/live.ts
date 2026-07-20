// Electron objects (BrowserWindow, Tray, webContents) throw
// "TypeError: Object has been destroyed" on ANY method call once destroyed —
// optional chaining only guards null, not destruction. Lived 2026-07-17:
// tick() hit a destroyed window and logged "tick failed" every 3s. Route all
// post-await touches of long-lived Electron refs through this.
export function live<T extends { isDestroyed(): boolean }>(o: T | null): T | null {
  return o && !o.isDestroyed() ? o : null;
}
