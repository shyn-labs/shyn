import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("shyn", {
  onView: (cb: (vm: unknown) => void) =>
    ipcRenderer.on("view", (_e, vm) => cb(vm)),
  action: (name: string, arg?: string) => ipcRenderer.send("action", name, arg),
  resize: (h: number) => ipcRenderer.send("resize", h),
  // Settings window: request/response, unlike the fire-and-forget actions.
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSave: (payload: unknown) => ipcRenderer.invoke("settings:save", payload),
});
