/* Settings page. Every change saves straight away. */
(function (SP) {
  const { h, Button, Seg, Stepper, Switch, toast, errorText } = SP;

  SP.SettingsPage = function () {
    const { header } = SP.parts;
    const s = SP.state.settings;
    const o = SP.state.options;
    const save = (k) => (v) => SP.save({ [k]: v });

    function group(title, ...rows) {
      return h("div", { class: "mb-7" }, h("div", { class: "label-caps mb-2.5" }, title),
        h("div", { class: "tile sticker overflow-hidden" }, rows.map((r, i) => (i ? [h("div", { class: "border-t border-line mx-5" }), r] : r))));
    }
    function row(label, hint, control, wide) {
      const hintEl = h("div", { class: "text-muted text-[13px] mt-0.5 leading-snug" }, hint || "");
      const r = h("div", { class: "flex items-center gap-6 px-5 py-4" },
        h("div", { class: "min-w-0 shrink-0" + (wide ? " w-[300px]" : " flex-1") }, h("div", { class: "text-[15px] font-semibold" }, label), hintEl),
        h("div", { class: wide ? "flex-1 min-w-0" : "shrink-0" }, control));
      r.hint = hintEl;
      return r;
    }

    // ---- export
    const format = h("select", { class: "field w-full cursor-pointer" }, o.formats.map((f) => h("option", { value: f, selected: f === s.format }, f.replace(/ {2}- {2}/, "  ·  "))));
    format.addEventListener("change", () => SP.save({ format: format.value }));
    const res = Object.entries(o.resolutions);
    const gpuSwitch = Switch(s.gpu, save("gpu"));
    const gpuRow = row("Use graphics card for saving", "Checking...", gpuSwitch);

    // ---- names
    const tpl = h("input", { class: "field w-full font-semibold", value: s.name_template, spellcheck: "false" });
    const preview = h("div", { class: "text-[13px] mt-2 leading-relaxed text-muted" });
    let tplTimer;
    async function refreshPreview(saveIt) {
      try {
        const r = await SP.call("settings.namePreview", { template: tpl.value });
        if (r.problem) {
          preview.className = "text-[13px] mt-2 leading-relaxed text-alert";
          preview.textContent = `Not saved: ${r.problem}`;
          return;
        }
        preview.className = "text-[13px] mt-2 leading-relaxed text-muted";
        preview.innerHTML = "";
        preview.append(h("div", {}, "Film:  ", h("span", { class: "text-ink" }, r.film)), h("div", {}, "Episode:  ", h("span", { class: "text-ink" }, r.episode)));
        if (saveIt) SP.save({ name_template: tpl.value });
      } catch {}
    }
    tpl.addEventListener("input", () => (clearTimeout(tplTimer), (tplTimer = setTimeout(() => refreshPreview(true), 300))));
    const tags = h("div", { class: "flex flex-wrap gap-1.5 mt-2.5" }, ["name", "num", "time", "show", "season", "episode", "code"].map((t) => {
      const c = h("button", { class: "chip sticker-sm !text-[12px] cursor-pointer hover:!bg-raised-2" }, `{${t}}`);
      c.addEventListener("click", () => {
        const at = tpl.selectionStart ?? tpl.value.length;
        tpl.value = tpl.value.slice(0, at) + `{${t}}` + tpl.value.slice(tpl.selectionEnd ?? at);
        tpl.dispatchEvent(new Event("input"));
        tpl.focus();
      });
      return c;
    }));

    // ---- AI
    const aiStatus = h("div", {});
    const aiDeviceRow = row("Run AI on", "", Seg([["Automatic", "auto"], ["Graphics card", "gpu"], ["Processor", "cpu"]], s.ai_device, save("ai_device")), true);
    const modelRow = row("Model files", "", aiStatus);
    const cacheRow = row("Search memory", "", Button("Clear", async () => {
      await SP.call("ai.clearCache");
      toast("Search memory cleared", "Videos will be analysed again next time.");
    }, { size: "sm" }));

    // ---- app
    const ffRow = row("ffmpeg", "", Button("Change", async () => {
      const [p] = await window.sp.pick("ffmpeg");
      if (!p) return;
      try {
        SP.state.status = await SP.call("ffmpeg.locate", { path: p });
        renderStatus();
        toast("ffmpeg found", p, "up");
      } catch (e) {
        toast("That isn't ffmpeg", errorText(e), "alert");
      }
    }, { size: "sm" }));

    // ---- updates
    const updRow = row("Automatic updates", "", Switch(s.auto_update, save("auto_update")));
    const updCheck = Button("Check now", async () => {
      updCheck.setLabel("Checking...");
      const u = await window.sp.update.check();
      updCheck.setLabel("Check now");
      if (u.state === "current") toast("You're up to date", `Version ${SP.state.version} is the newest.`, "up");
      else if (u.state === "error") toast("Couldn't check for updates", u.message || "", "warn");
    }, { size: "sm", iconName: "refresh" });
    const updNowRow = row("Version", "", updCheck);
    function renderUpdate(u) {
      const st = (u && u.state) || "unavailable";
      updCheck.hidden = st === "unavailable";
      updNowRow.hint.textContent = {
        unavailable: `ScenePack ${SP.state.version}. Updates arrive through GitHub Releases once this copy is installed from one.`,
        idle: `ScenePack ${SP.state.version}.`,
        checking: "Checking for updates...",
        current: `ScenePack ${SP.state.version} is the newest version.`,
        available: `Version ${u.version} is available.`,
        downloading: `Downloading version ${u.version}  ${Math.round(u.percent || 0)}%`,
        ready: `Version ${u.version} is ready. Restart ScenePack to finish updating.`,
        error: `Couldn't check for updates: ${u.message || "unknown error"}`,
      }[st];
      updRow.hint.textContent = "Download new versions in the background and install them when ScenePack restarts.";
    }
    SP.on("update", renderUpdate);

    // Simple by default: only the settings most people change. The rest appear with "Show advanced".
    const basic = [
      group("Export",
        row("Format", "MP4 plays anywhere. Instant is fastest. ProRes and DNxHR are best for editing.", format, true),
        row("Quality", "Applies to H.264. Higher means bigger files.", Seg(o.qualities.map((q) => [q, q]), s.quality, save("quality")), true),
        row("Keep audio", "Turn off for silent clips.", Switch(s.audio, save("audio")))),
      group("While working",
        row("Start as soon as videos are added", "No need to press Start.", SP.bind(Switch(s.auto_start, save("auto_start")), "auto_start")),
        row("Keep working when the window is closed", "ScenePack stays in the tray until the queue is done.", Switch(s.keep_in_tray, save("keep_in_tray"))),
        row("Notify me when it's done", "A Windows notification, if ScenePack is in the background.", Switch(s.notify, save("notify"))),
        row("Open the output folder when done", "", Switch(s.open_when_done, save("open_when_done")))),
      group("Appearance",
        row("Theme", "", Seg([["Dark", "dark"], ["Light", "light"]], s.theme || "dark", (v) => (SP.save({ theme: v }), (SP.state.settings.theme = v), SP.applyLook())), true),
        row("Interface size", "Makes every button, panel and piece of text bigger or smaller. Ctrl + plus / minus works anywhere.",
          SP.bind(Seg(SP.SCALES, s.ui_scale, (v) => SP.save({ ui_scale: v })), "ui_scale"), true),
        row("Animations", "Turn off for a calmer, instant interface.", Switch(s.animations, (v) => (SP.save({ animations: v }), (SP.state.settings.animations = v), SP.applyLook())))),
      group("Updates", updRow, updNowRow),
    ];
    const advanced = h("div", { class: "anim-rise" },
      group("Export (advanced)",
        row("Maximum resolution", "Shrinks bigger videos. Smaller ones are never enlarged.", Seg(res, s.max_height, save("max_height")), true),
        gpuRow),
      group("File names",
        h("div", { class: "px-5 py-4" },
          h("div", { class: "flex gap-3" }, tpl, Button("Reset", () => ((tpl.value = "{name}_scene_{num}_{time}"), refreshPreview(true)), { size: "sm", cls: "!h-10" })),
          tags, preview)),
      group("Clips",
        row("Trim frames off each end", "Removes flash frames right at a cut.", Stepper(s.trim_frames, { min: 0, max: 10 }, save("trim_frames"))),
        row("Don't save clips shorter than (seconds)", "0 saves every scene, however short.", Stepper(s.min_save, { min: 0, max: 30, step: 0.5, decimals: 1 }, save("min_save")))),
      group("AI search",
        row("Model", "Accurate spots small details better but searches about 3x slower.", Seg([["Fast", "fast"], ["Accurate", "accurate"]], s.ai_model, save("ai_model")), true),
        aiDeviceRow,
        row("Frames checked", "More frames finds brief moments but takes longer.", Seg([["1 every 2 s", "fast"], ["1 per second", "normal"], ["2 per second", "detailed"]], s.ai_detail, save("ai_detail")), true),
        modelRow, cacheRow),
      group("App",
        row("Remember the queue", "Unfinished videos come back next time you open ScenePack.", Switch(s.remember_queue, save("remember_queue"))),
        row("Ask before quitting while working", "Only when keeping working in the tray is off.", Switch(s.confirm_quit, save("confirm_quit"))),
        ffRow,
        row("Settings and logs", SP.state.appDir || "", Button("Open", () => window.sp.openPath(SP.state.appDir), { size: "sm", iconName: "folder" })),
        row("Reset all settings", "Puts every option back to how it was on first launch. Your queue is kept.", Button("Reset", async () => {
          if (!confirm("Reset every setting? ScenePack will reload.")) return;
          SP.state.settings = await SP.call("settings.reset");
          location.reload();
        }, { size: "sm" }))));
    let showAdv = false;
    try {
      showAdv = localStorage.getItem("advanced") === "1";
    } catch {}
    advanced.hidden = !showAdv;
    const advToggle = h("label", { class: "flex items-center gap-3 text-[15px] font-semibold cursor-pointer mb-6" },
      Switch(showAdv, (v) => {
        advanced.hidden = !v;
        try {
          localStorage.setItem("advanced", v ? "1" : "0");
        } catch {}
      }), "Show advanced settings");
    const body = h("div", { class: "max-w-[920px]" }, basic, advToggle, advanced);
    function renderStatus() {
      const st = SP.state.status;
      gpuRow.hint.textContent = !st.gpuChecked ? "Checking for a graphics card..." : st.gpu ? `${st.gpu} graphics card found. Faster, and keeps the processor free.` : "No supported graphics card found, so the processor is used.";
      gpuSwitch.disable(st.gpuChecked && !st.gpu);
      ffRow.hint.textContent = st.ffmpeg || "Not found. ScenePack can't split videos without it.";
      const a = st.ai || {};
      aiDeviceRow.hint.textContent = !a.available ? "AI libraries are missing." : a.gpu ? `Graphics card available (about 3x faster). Using: ${a.device === "gpu" ? "graphics card" : "processor"}.` : "No graphics card support found, so the processor is used.";
      aiStatus.innerHTML = "";
      if (!a.available) modelRow.hint.textContent = "Install the AI libraries to use AI search (see README).";
      else if (a.installed) {
        modelRow.hint.textContent = `${a.label} for the ${a.device === "gpu" ? "graphics card" : "processor"} is installed (${a.size} MB).`;
        aiStatus.append(Button("Remove", async () => SP.call("ai.removeModel"), { size: "sm" }));
      } else {
        modelRow.hint.textContent = `Not downloaded yet (${a.size} MB, one time).`;
        aiStatus.append(Button("Download", () => (SP.go("ai"), SP.aiDownload()), { size: "sm", iconName: "download" }));
      }
      cacheRow.hint.textContent = `Remembers analysed videos so searching them again is instant. Using ${a.cacheMB || 0} MB.`;
    }
    SP.on("status", renderStatus);
    renderStatus();
    window.sp.update.get().then(renderUpdate);
    refreshPreview(false);

    const el = h("section", { class: "flex flex-col min-h-0" },
      header("Settings", "Saved automatically. Changes apply to clips saved from now on.", []),
      h("div", { class: "flex-1 min-h-0 scroll px-8 pb-8" }, body));
    return { el, onShow: () => SP.call("app.status").then((st) => ((SP.state.status = st), renderStatus())).catch(() => {}) };
  };
})(window.SP);
