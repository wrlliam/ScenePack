// ScenePack - Electron main process.
// Starts the Python backend, relays messages between it and the window, and owns native things:
// file dialogs, notifications, the tray, taskbar progress and automatic updates.
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const fs = require("fs");
const pkg = require("../package.json");

const ROOT = path.join(__dirname, "..");
const ICON = path.join(ROOT, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");
const TRAY_ICON = path.join(ROOT, "assets", "icon_32.png");
const THEMES = {
  dark: { color: "#16141d", symbolColor: "#9c95a8" },
  light: { color: "#f6f1e8", symbolColor: "#716a79" },
};
const REPO = ((pkg.repository && (pkg.repository.url || pkg.repository)) || "")
  .replace(/^git\+/, "").replace(/\.git$/, "").replace(/^github:/, "https://github.com/");

let win = null;
let tray = null;
let backend = null;
let nextId = 1;
const pending = new Map();
let busy = false;
let running = false;
let quitting = false;
const prefs = { confirm_quit: true, notify: true, open_when_done: false, keep_in_tray: true, auto_update: true, ui_scale: 0.9 };
let trayHintShown = false;
let restarts = [];

// Keep Chromium's own caches out of the folder that holds settings, models and logs.
const DATA_DIR = path.join(process.env.APPDATA || app.getPath("appData"), "ScenePack");
app.setPath("userData", path.join(DATA_DIR, "electron"));
const startupFiles = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-") && fs.existsSync(a));
const send = (event, data) => win && !win.isDestroyed() && win.webContents.send("backend", event, data);

// ---------------------------------------------------------------- backend
function backendCommand() {
  if (app.isPackaged) {
    return { cmd: path.join(process.resourcesPath, "backend", "scenepack-backend.exe"), args: [], cwd: process.resourcesPath };
  }
  return { cmd: process.env.SCENEPACK_PYTHON || "python", args: ["-m", "scenepack.server"], cwd: ROOT };
}

function startBackend() {
  const { cmd, args, cwd } = backendCommand();
  const proc = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
  });
  backend = proc;
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if ("error" in msg) reject(new Error(msg.error));
      else resolve(msg.result);
      return;
    }
    if (msg.event) onBackendEvent(msg.event, msg.data);
  });
  proc.stderr.on("data", (d) => process.env.SCENEPACK_DEBUG && process.stderr.write(d));
  proc.on("exit", (code) => {
    for (const { reject } of pending.values()) reject(new Error("The ScenePack engine stopped."));
    pending.clear();
    if (quitting || proc !== backend) return;
    // Restart the engine by itself (up to 3 times a minute); the page reloads and carries on.
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60000);
    if (restarts.length < 3) {
      restarts.push(now);
      send("restarting", { code });
      setTimeout(() => {
        startBackend();
        setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), 600);
      }, 800);
    } else send("crashed", { code });
  });
  proc.on("error", (err) => send("crashed", { message: String(err) }));
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!backend || backend.exitCode !== null) return reject(new Error("The ScenePack engine isn't running."));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    backend.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

function onBackendEvent(event, data) {
  if (event === "jobs") showProgress(data);
  if (event === "status" && data.ai && data.ai.busy) busy = true;
  if (event === "allDone") {
    const hidden = win && (!win.isVisible() || !win.isFocused());
    if (prefs.notify && hidden) {
      if (win && win.isVisible()) win.flashFrame(true);
      if (Notification.isSupported()) {
        const n = new Notification({
          title: "ScenePack: all finished",
          body: `${data.count} video${data.count === 1 ? "" : "s"} split into clips. Click to open the folder.`,
          icon: ICON,
        });
        n.on("click", () => (data.folder ? shell.openPath(data.folder) : showWindow()));
        n.show();
      }
    }
    if (prefs.open_when_done && data.folder) shell.openPath(data.folder);
  }
  send(event, data);
}

// Overall progress on the taskbar button, in the window title and on the tray icon.
function showProgress(data) {
  const jobs = data.jobs || [];
  running = data.running;
  const active = jobs.filter((j) => j.state === "scanning" || j.state === "exporting");
  busy = data.running || active.length > 0;
  if (!win || win.isDestroyed()) return;
  const left = jobs.filter((j) => j.state !== "done");
  if (!jobs.length || (!busy && !left.length)) {
    win.setProgressBar(-1);
    win.setTitle("ScenePack");
  } else if (busy) {
    const p = jobs.reduce((a, j) => a + (["done", "error", "nocuts"].includes(j.state) ? 1 : j.progress), 0) / jobs.length;
    win.setProgressBar(Math.max(p, 0.01), { mode: data.running ? "normal" : "paused" });
    win.setTitle(`ScenePack  ·  ${Math.round(p * 100)}%${data.running ? "" : " (paused)"}`);
  } else {
    win.setProgressBar(-1);
    win.setTitle("ScenePack");
  }
  updateTray();
}

// ---------------------------------------------------------------- tray
function updateTray() {
  if (!tray) return;
  tray.setToolTip(win ? win.getTitle() : "ScenePack");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show ScenePack", click: showWindow },
    { label: running ? "Pause" : "Start", click: () => call("queue.toggle").catch(() => {}) },
    { type: "separator" },
    { label: "Quit", click: quitApp },
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16, quality: "best" }));
  tray.on("click", showWindow);
  updateTray();
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function quitApp() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- automatic updates
// Works when the app was built with a GitHub repository (the release workflow sets it), using the
// installer, latest.yml and .blockmap files attached to each GitHub Release.
let updater = null;
let update = { state: "unavailable" };
function setUpdate(u) {
  update = { ...update, ...u };
  send("update", update);
}
function setupUpdates() {
  if (!app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))) return;
  try {
    updater = require("electron-updater").autoUpdater;
  } catch {
    return;
  }
  update = { state: "idle" };
  const logFile = path.join(DATA_DIR, "update.log");
  const write = (level) => (...a) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${level} ${a.map(String).join(" ")}\n`);
    } catch {}
  };
  updater.logger = { info: write("info"), warn: write("warn"), error: write("error"), debug: () => {} };
  updater.autoDownload = prefs.auto_update;
  updater.autoInstallOnAppQuit = true;
  updater.on("checking-for-update", () => setUpdate({ state: "checking" }));
  updater.on("update-available", (i) => setUpdate({ state: updater.autoDownload ? "downloading" : "available", version: i.version, percent: 0 }));
  updater.on("update-not-available", () => setUpdate({ state: "current", checked: Date.now() }));
  updater.on("download-progress", (p) => setUpdate({ state: "downloading", percent: p.percent }));
  updater.on("update-downloaded", (i) => setUpdate({ state: "ready", version: i.version }));
  updater.on("error", (e) => setUpdate({ state: "error", message: String((e && e.message) || e).split("\n")[0].slice(0, 200) }));
  const check = () => updater.checkForUpdates().catch(() => {});
  if (prefs.auto_update) setTimeout(check, 8000);
  setInterval(() => prefs.auto_update && check(), 6 * 3600 * 1000);
}
ipcMain.handle("update:get", () => update);
ipcMain.handle("update:check", async () => {
  if (!updater) return update;
  await updater.checkForUpdates().catch((e) => setUpdate({ state: "error", message: String(e.message || e).split("\n")[0] }));
  return update;
});
ipcMain.handle("update:download", () => updater && updater.downloadUpdate().catch(() => {}));
ipcMain.handle("update:install", async () => {
  if (!updater || update.state !== "ready") return;
  quitting = true;
  await call("app.quit").catch(() => {});
  setTimeout(() => updater.quitAndInstall(true, true), 300);
});

// ---------------------------------------------------------------- window
function createWindow(theme) {
  const t = THEMES[theme] || THEMES.dark;
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    backgroundColor: t.color,
    title: "ScenePack",
    icon: ICON,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: t.color, symbolColor: t.symbolColor, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(ROOT, "renderer", "index.html"));
  // Interface size: zoom the whole page, so every button, panel and font scales together.
  win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(Number(prefs.ui_scale) || 0.9));
  win.once("ready-to-show", () => win.show());
  win.on("focus", () => win.flashFrame(false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("close", (e) => {
    if (quitting || !busy) return;
    if (prefs.keep_in_tray) {
      // Keep working quietly in the tray instead of stopping.
      e.preventDefault();
      win.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: "ScenePack is still working", body: "It carries on in the background. Click the tray icon to open it again.", icon: ICON }).show();
      }
      return;
    }
    if (!prefs.confirm_quit) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Quit", "Keep working"],
      defaultId: 1,
      cancelId: 1,
      title: "ScenePack",
      message: "ScenePack is still working.",
      detail: "Quit anyway? Clips already saved are kept, and the queue picks up where it left off next time.",
    });
    if (choice !== 0) e.preventDefault();
    else quitting = true;
  });
}

// ---------------------------------------------------------------- IPC from the page
ipcMain.handle("call", (_e, method, params) => call(method, params));
ipcMain.handle("startupFiles", () => startupFiles.splice(0));
ipcMain.handle("appInfo", () => ({ version: app.getVersion(), repo: REPO, packaged: app.isPackaged, justUpdated: process.argv.includes("--updated") }));
ipcMain.handle("pick", async (_e, kind) => {
  const video = { name: "Videos", extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm", "mxf", "wmv", "flv", "ts", "mts", "m2ts", "mpg", "mpeg"] };
  const opts = {
    films: { title: "Choose videos", properties: ["openFile", "multiSelections"], filters: [video, { name: "All files", extensions: ["*"] }] },
    folder: { title: "Choose a folder", properties: ["openDirectory"] },
    pictures: { title: "Pictures of what you're looking for", properties: ["openFile", "multiSelections"], filters: [{ name: "Pictures", extensions: ["jpg", "jpeg", "png", "webp", "bmp"] }] },
    ffmpeg: { title: "Locate ffmpeg.exe", properties: ["openFile"], filters: [{ name: "ffmpeg", extensions: ["exe"] }] },
  }[kind];
  const r = await dialog.showOpenDialog(win, opts);
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("openPath", (_e, p) => {
  if (!p) return;
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return shell.openPath(p);
});
ipcMain.handle("openExternal", (_e, url) => {
  if (/^https:\/\/(github\.com|huggingface\.co)\//.test(url)) shell.openExternal(url);
});
ipcMain.handle("setPrefs", (_e, p) => {
  for (const k of Object.keys(prefs)) if (k in p) prefs[k] = p[k];
  if (updater && "auto_update" in p) updater.autoDownload = !!p.auto_update;
  if ("ui_scale" in p && win) win.webContents.setZoomFactor(Number(p.ui_scale) || 0.9);
  if (p.theme && win) {
    const t = THEMES[p.theme] || THEMES.dark;
    win.setTitleBarOverlay({ color: t.color, symbolColor: t.symbolColor, height: 44 });
    win.setBackgroundColor(t.color);
  }
});

// ---------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    showWindow();
    const files = argv.slice(1).filter((a) => !a.startsWith("-") && fs.existsSync(a));
    if (files.length) send("openFiles", { paths: files });
  });
  // Windows shows the name and icon registered for this ID (taskbar, Start, notifications). Runs from source use
  // their own ID, otherwise Electron registers "Electron" with its own icon under the installed app's ID.
  app.setAppUserModelId(app.isPackaged ? "club.scenepack.app" : "club.scenepack.app.dev");
  app.whenReady().then(() => {
    let theme = "dark";
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));
      theme = s.theme || "dark";
      for (const k of Object.keys(prefs)) if (k in s) prefs[k] = s[k];
    } catch {}
    startBackend();
    createWindow(theme);
    createTray();
    setupUpdates();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    quitting = true;
    if (backend && backend.exitCode === null) {
      call("app.quit").catch(() => {});
      setTimeout(() => backend && backend.exitCode === null && backend.kill(), 1500);
    }
    app.quit();
  });
}
