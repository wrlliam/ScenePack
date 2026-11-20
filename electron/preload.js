// The only bridge between the page and the rest of the app. The page gets these functions and nothing else.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const listeners = new Map();
ipcRenderer.on("backend", (_e, event, data) => {
  for (const fn of listeners.get(event) || []) fn(data);
});

contextBridge.exposeInMainWorld("sp", {
  call: (method, params) => ipcRenderer.invoke("call", method, params),
  on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  },
  pick: (kind) => ipcRenderer.invoke("pick", kind),
  openPath: (p) => ipcRenderer.invoke("openPath", p),
  openExternal: (url) => ipcRenderer.invoke("openExternal", url),
  setPrefs: (prefs) => ipcRenderer.invoke("setPrefs", prefs),
  startupFiles: () => ipcRenderer.invoke("startupFiles"),
  appInfo: () => ipcRenderer.invoke("appInfo"),
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
