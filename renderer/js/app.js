/* App shell: talks to the backend, owns shared state, sidebar, page transitions, footer and drag-and-drop. */
(function (SP) {
  const { h, icon, toast, Button, errorText } = SP;
  const api = window.sp;

  const state = (SP.state = { settings: {}, options: {}, status: {}, jobs: { jobs: [], running: false, finished: "" } });
  const bus = {};
  SP.on = (ev, fn) => (bus[ev] = bus[ev] || []).push(fn);
  const fire = (ev, data) => (bus[ev] || []).forEach((fn) => fn(data));

  SP.call = async (method, params) => {
    try {
      return await api.call(method, params || {});
    } catch (e) {
      throw new Error(errorText(e));
    }
  };
  SP.save = async (patch) => {
    Object.assign(state.settings, patch);
    try {
      state.settings = await SP.call("settings.update", { patch });
    } catch (e) {
      toast("Couldn't save that setting", errorText(e), "alert");
    }
    api.setPrefs(patch);
    document.querySelectorAll("[data-setting]").forEach((el) => el.set && el.dataset.setting in state.settings && el.set(state.settings[el.dataset.setting]));
    fire("settings", state.settings);
  };
  SP.applyLook = () => {
    document.documentElement.dataset.theme = state.settings.theme || "dark";
    document.documentElement.dataset.motion = state.settings.animations === false ? "off" : "on";
  };

  // ---------------------------------------------------------------- pages + sidebar
  const PAGES = [
    ["queue", "Queue", "queue"],
    ["tv", "TV shows", "tv"],
    ["ai", "AI search", "ai"],
    ["library", "Library", "library"],
    ["settings", "Settings", "settings"],
    ["about", "About", "about"],
  ];
  const pages = (SP.pages = {});
  let current = null;
  const navButtons = {};
  const navThumb = h("div", { class: "nav-thumb sticker" });
  const badge = h("span", { class: "ml-auto chip !bg-accent !text-on-accent !px-2 !py-0.5 !text-xs hidden" });

  function buildNav() {
    const nav = document.getElementById("nav");
    nav.appendChild(navThumb);
    PAGES.forEach(([key, label, ic], i) => {
      const b = h("button", { class: "nav-item" }, icon(ic, "w-[20px] h-[20px]"), h("span", {}, label), key === "queue" ? badge : null);
      b.addEventListener("click", () => SP.go(key));
      navButtons[key] = b;
      nav.appendChild(b);
    });
  }

  SP.go = (key) => {
    if (key === current) return;
    const order = PAGES.map((p) => p[0]);
    const forward = current === null || order.indexOf(key) > order.indexOf(current);
    const old = current && pages[current];
    current = key;
    Object.entries(navButtons).forEach(([k, b]) => (k === key ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    navThumb.style.transform = `translateY(${order.indexOf(key) * 48}px)`;
    const next = pages[key];
    if (old) {
      old.el.classList.remove("page-in-right", "page-in-left");
      old.el.classList.add("page-out");
      setTimeout(() => {
        old.el.classList.remove("page-out");
        old.el.hidden = true;
      }, 170);
    }
    setTimeout(() => {
      next.el.hidden = false;
      next.el.classList.remove("page-in-right", "page-in-left");
      void next.el.offsetWidth;
      next.el.classList.add(forward ? "page-in-right" : "page-in-left");
      next.onShow && next.onShow();
    }, old ? 150 : 0);
  };
  SP.current = () => current;

  // ---------------------------------------------------------------- footer
  let goBtn, clearBtn, overall;
  function buildFooter() {
    goBtn = Button("Start", toggleQueue, { kind: "primary", size: "big", iconName: "play", cls: "min-w-[150px]" });
    clearBtn = Button("Clear finished", () => SP.call("queue.clearFinished"), {});
    goBtn.title = "Start or pause  (Space)";
    overall = SP.Bar();
    overall.classList.add("!h-1.5", "w-40");
    document.getElementById("footer-left").append(goBtn, clearBtn);
    document.getElementById("overall").append(overall);
  }
  async function toggleQueue() {
    try {
      const r = await SP.call("queue.toggle");
      if (r.nothing) toast("Nothing to do yet", "Add films on the Queue page, or episodes from TV shows.", "warn");
    } catch (e) {
      toast("Couldn't start", errorText(e), "alert");
    }
  }
  function renderFooter() {
    const { jobs, running, finished } = state.jobs;
    const active = jobs.filter((j) => j.state === "scanning" || j.state === "exporting").length;
    const done = jobs.filter((j) => j.state === "done").length;
    const left = jobs.length - done;
    goBtn.setLabel(running ? "Pause" : active ? "Resume" : "Start");
    goBtn.firstChild.replaceWith(icon(running ? "pause" : "play", "w-[18px] h-[18px]"));
    clearBtn.disabled = !done;
    const p = jobs.length ? jobs.reduce((a, j) => a + (["done", "error", "nocuts"].includes(j.state) ? 1 : j.progress), 0) / jobs.length : 0;
    overall.parentElement.hidden = !jobs.length || (!active && !running && !finished);
    overall.set(p, finished ? "done" : "", running && active > 0);
    badge.textContent = left;
    badge.classList.toggle("hidden", !left);
    const sum = document.getElementById("summary");
    if (finished) {
      sum.textContent = finished;
      sum.className = "ml-auto text-up font-bold text-[15px]";
    } else {
      sum.className = "ml-auto text-muted text-[15px]";
      sum.textContent = jobs.length ? `${done} of ${jobs.length} done${active ? `  ·  ${active} ${running ? "running" : "paused"}` : ""}` : "";
    }
  }

  function renderEngine() {
    const s = state.status;
    const el = document.getElementById("engine");
    if (!s.ffmpeg) {
      el.innerHTML = "";
      el.append(h("span", { class: "text-alert font-bold" }, "ffmpeg not found."), " Set it in Settings.");
      return;
    }
    const enc = s.gpuChecked ? (s.gpu ? `${s.gpu} GPU` : "Processor") : "Checking...";
    const aiDev = s.ai && s.ai.available ? (s.ai.device === "gpu" ? (s.gpu ? `${s.gpu} GPU` : "GPU") : "Processor") : "Unavailable";
    el.innerHTML = "";
    el.append(
      h("div", { class: "flex justify-between gap-2" }, h("span", {}, "Saving"), h("span", { class: "text-ink font-semibold" }, enc)),
      h("div", { class: "flex justify-between gap-2 mt-0.5" }, h("span", {}, "AI search"), h("span", { class: "text-ink font-semibold" }, aiDev)));
  }

  // ---------------------------------------------------------------- drag and drop
  function setupDrop() {
    const overlay = document.getElementById("drop");
    document.getElementById("drop-fan").appendChild(SP.CardFan(0.7, "plus"));
    let depth = 0;
    const show = (on) => {
      overlay.classList.toggle("hidden", !on);
      overlay.classList.toggle("flex", on);
    };
    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (++depth === 1) {
        const where = { queue: ["Drop to add films", "Every scene of each film becomes a clip"], tv: ["Drop a show folder", "Seasons and episodes are found automatically"], ai: ["Drop to search", "Videos to search, or pictures of what you want"] }[current] || ["Drop to add films", "They go into the queue"];
        document.getElementById("drop-title").textContent = where[0];
        document.getElementById("drop-body").textContent = where[1];
        show(true);
      }
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => {
      if (--depth <= 0) (depth = 0), show(false);
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      show(false);
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      const page = pages[current];
      if (page && page.onDrop) page.onDrop(paths);
      else {
        pages.queue.onDrop(paths);
        SP.go("queue");
      }
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    buildNav();
    buildFooter();
    setupDrop();
    let init;
    for (let i = 0; i < 60; i++) {
      try {
        init = await api.call("app.init", {});
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!init) {
      document.getElementById("pages").appendChild(SP.Empty("The engine didn't start", "ScenePack's backend couldn't be started. Try reinstalling, or see the README for running from source."));
      return;
    }
    Object.assign(state, { settings: init.settings, options: init.options, status: init.status, jobs: init.jobs, version: init.version, repo: init.repo, appDir: init.appDir });
    const info = await api.appInfo();
    if (info.repo) state.repo = info.repo;
    state.packaged = info.packaged;
    if (info.justUpdated) setTimeout(() => toast(`Updated to version ${info.version}`, "Thanks for keeping ScenePack up to date.", "up"), 1200);
    SP.applyLook();
    const st = state.settings;
    api.setPrefs({ theme: st.theme, confirm_quit: st.confirm_quit, notify: st.notify, open_when_done: st.open_when_done, keep_in_tray: st.keep_in_tray, auto_update: st.auto_update, ui_scale: st.ui_scale });
    document.getElementById("version").textContent = `v${init.version}`;
    const host = document.getElementById("pages");
    for (const [key, factory] of Object.entries({ queue: SP.QueuePage, tv: SP.TVPage, ai: SP.AIPage, library: SP.LibraryPage, settings: SP.SettingsPage, about: SP.AboutPage })) {
      const page = factory();
      page.el.classList.add("absolute", "inset-0");
      page.el.hidden = true;
      host.appendChild(page.el);
      pages[key] = page;
    }
    renderFooter();
    renderEngine();
    SP.go("queue");
    fire("jobs", state.jobs);
    const files = await api.startupFiles();
    if (files.length) pages.queue.onDrop(files);
    setupShortcuts();
    renderUpdate(await api.update.get());
    if (!state.settings.welcome_done && !files.length) setTimeout(showWelcome, 500);
  }

  // ---------------------------------------------------------------- keyboard shortcuts
  SP.SHORTCUTS = [
    ["Ctrl + O", "Add films"],
    ["Space", "Start or pause the queue"],
    ["Ctrl + 1 to 6", "Switch pages"],
    ["Ctrl + plus / minus", "Make everything bigger or smaller"],
    ["Ctrl + F", "Search with AI"],
    ["Ctrl + ,", "Settings"],
  ];
  function setupShortcuts() {
    window.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.ctrlKey && /^[1-6]$/.test(e.key)) return e.preventDefault(), SP.go(PAGES[Number(e.key) - 1][0]);
      if (e.ctrlKey && e.key.toLowerCase() === "o") return e.preventDefault(), SP.go("queue"), pages.queue.pick("films");
      if (e.ctrlKey && e.key.toLowerCase() === "f") return e.preventDefault(), SP.go("ai"), setTimeout(() => pages.ai.focus(), 350);
      if (e.ctrlKey && e.key === ",") return e.preventDefault(), SP.go("settings");
      if (e.ctrlKey && ["=", "+", "-", "0"].includes(e.key)) {
        e.preventDefault();
        const sizes = SP.SCALES.map((x) => x[1]);
        const cur = sizes.indexOf(state.settings.ui_scale);
        const next = e.key === "0" ? 0.9 : sizes[Math.max(0, Math.min(sizes.length - 1, (cur < 0 ? 1 : cur) + (e.key === "-" ? -1 : 1)))];
        return SP.save({ ui_scale: next });
      }
      if (e.key === " " && !typing && !e.repeat && !document.activeElement.closest("button")) return e.preventDefault(), toggleQueue();
      if (e.key === "Escape") document.getElementById("welcome")?.remove();
    });
  }

  // ---------------------------------------------------------------- welcome (first launch only)
  function showWelcome() {
    const close = () => {
      SP.save({ welcome_done: true });
      wrap.classList.add("page-out");
      setTimeout(() => wrap.remove(), 180);
    };
    const step = (n, title, body, i) =>
      h("div", { class: "tile sticker p-5 anim-rise", style: { animationDelay: `${150 + i * 90}ms` } },
        h("span", { class: "w-9 h-9 rounded-full bg-accent text-on-accent font-display text-[17px] flex items-center justify-center sticker-sm" }, n),
        h("div", { class: "font-display text-[20px] mt-3 leading-tight" }, title),
        h("p", { class: "text-muted text-[14px] mt-1 leading-snug" }, body));
    const wrap = h("div", { id: "welcome", class: "fixed inset-0 z-50 flex items-center justify-center bg-[var(--c-scrim)]" },
      h("div", { class: "tile sticker-lg p-9 w-[760px] anim-pop" },
        h("div", { class: "flex items-center gap-6" }, SP.CardFan(0.6, "play"),
          h("div", {}, h("h2", { class: "font-display text-[34px] leading-none" }, "Welcome to ScenePack"),
            h("p", { class: "text-muted mt-2 text-[16px]" }, "Turn any film or show into a folder of clips, one per scene."))),
        h("div", { class: "grid grid-cols-3 gap-4 mt-7" },
          step("1", "Drop a film", "Drag videos onto the window, or right-click one in Explorer and choose Send to > ScenePack.", 0),
          step("2", "It starts by itself", "Every scene is found and saved as its own clip. Keep using your PC meanwhile.", 1),
          step("3", "Gather your clips", "Browse every clip in the Library, preview them, and export picks from several films into one folder.", 2)),
        h("div", { class: "flex items-center gap-3 mt-7" },
          h("span", { class: "text-muted text-[14px]" }, "TV shows and AI search are in the sidebar."),
          h("span", { class: "ml-auto" }),
          Button("Add films", () => (close(), pages.queue.pick("films")), { iconName: "plus" }),
          Button("Get started", close, { kind: "primary" }))));
    document.body.appendChild(wrap);
  }

  // ---------------------------------------------------------------- automatic updates
  function renderUpdate(u) {
    state.update = u;
    fire("update", u);
    const box = document.getElementById("update");
    box.innerHTML = "";
    if (!u || !["downloading", "ready", "available"].includes(u.state)) return (box.hidden = true);
    box.hidden = false;
    if (u.state === "ready") {
      box.append(h("div", { class: "tile sticker p-4 mb-3 anim-pop" },
        h("div", { class: "font-bold leading-tight" }, `Version ${u.version} is ready`),
        h("p", { class: "text-muted text-[13px] mt-1 leading-snug" }, "Restart to update. It also installs when you next close ScenePack."),
        Button("Restart now", () => api.update.install(), { kind: "primary", size: "sm", cls: "mt-3 w-full" })));
    } else if (u.state === "available") {
      box.append(h("div", { class: "tile sticker p-4 mb-3 anim-pop" },
        h("div", { class: "font-bold leading-tight" }, `Version ${u.version} is out`),
        Button("Download", () => api.update.download(), { kind: "primary", size: "sm", cls: "mt-3 w-full" })));
    } else {
      const bar = SP.Bar();
      bar.set((u.percent || 0) / 100, "", true);
      box.append(h("div", { class: "tile sticker p-4 mb-3" },
        h("div", { class: "text-[13px] text-muted mb-2" }, `Downloading update ${u.version || ""}  ${Math.round(u.percent || 0)}%`), bar));
    }
  }
  api.on("update", renderUpdate);
  api.on("restarting", () => toast("The engine restarted", "Something went wrong behind the scenes, so ScenePack restarted it. Your queue is safe.", "warn"));

  api.on("jobs", (data) => {
    state.jobs = data;
    renderFooter();
    fire("jobs", data);
  });
  api.on("status", (data) => {
    state.status = data;
    renderEngine();
    fire("status", data);
  });
  api.on("jobDone", (d) => {
    if (d.state === "done") toast(d.title, `${SP.plural(d.total, "clip")} saved`, "up");
    else if (d.state === "nocuts") toast(d.title, "No scene changes found.", "warn");
    else toast(d.title, "Couldn't be split. See its card for details.", "alert");
  });
  api.on("allDone", (d) => toast("All finished", `${SP.plural(d.count, "video")} split into clips.`, "up"));
  api.on("crashed", () => toast("The engine stopped", "Restart ScenePack. Details are in the log (Settings > Settings and logs).", "alert"));
  api.on("openFiles", (d) => (pages.queue.onDrop(d.paths), SP.go("queue")));
  SP.SCALES = [["Compact", 0.8], ["Small", 0.9], ["Normal", 1], ["Large", 1.15]];
  ["aiProgress", "tvDuration", "libraryProgress"].forEach((ev) => api.on(ev, (d) => fire(ev, d)));

  document.addEventListener("DOMContentLoaded", boot);
})(window.SP);
