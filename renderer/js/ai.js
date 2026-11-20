/* AI search page: describe what you want, see matching scenes, pick the ones to save. */
(function (SP) {
  const { h, icon, Button, Seg, Range, Bar, Spinner, toast, fileUrl, errorText } = SP;

  SP.AIPage = function () {
    const { header, panelSection, sidePanel } = SP.parts;
    let files = [], results = { videos: [], items: [], refs: [] }, busy = false;
    const selected = new Set();
    let strict = SP.state.settings.ai_strict ?? 0.5;
    let order = "match";

    // ---- search card
    const prompt = h("input", { class: "field flex-1 !h-12 !text-[17px]", placeholder: "Describe the scenes you want, e.g. a blue alien with a bow in a forest" });
    prompt.addEventListener("keydown", (e) => e.key === "Enter" && search());
    const searchBtn = Button("Search", () => search(), { kind: "primary", size: "big", iconName: "ai" });
    const filesLbl = h("div", { class: "flex-1 min-w-0 truncate text-[14px]" });
    const refsBox = h("div", { class: "flex-1 min-w-0 flex flex-wrap gap-2 items-center" });
    const statusText = h("span", { class: "text-[14px] text-muted" });
    const spin = Spinner();
    spin.hidden = true;
    const cancelBtn = Button("Cancel", () => SP.call("ai.cancel"), { size: "sm" });
    cancelBtn.hidden = true;
    // Pause: stop analysing and show what has been found so far. Continue picks up where it stopped
    // (videos already finished are remembered, so only the rest is analysed).
    const pauseBtn = Button("Pause & show results", () => {
      pauseBtn.disabled = true;
      pauseBtn.setLabel("Pausing...");
      SP.call("ai.pause");
    }, { size: "sm", iconName: "pause" });
    pauseBtn.hidden = true;
    const continueBtn = Button("Continue searching", () => search(true), { size: "sm", iconName: "play", kind: "primary" });
    continueBtn.hidden = true;
    const bar = Bar();
    const barWrap = h("div", { class: "mt-3", hidden: true }, bar);
    const modelBox = h("div", {});

    const searchCard = h("div", { class: "tile sticker p-5 mx-8 mb-5" },
      h("div", { class: "flex gap-3" }, prompt, searchBtn),
      h("div", { class: "flex items-center gap-3 mt-4" },
        h("span", { class: "label-caps w-24 shrink-0" }, "Search in"), filesLbl,
        Button("Add videos", () => pickFiles("films"), { size: "sm", iconName: "plus" }),
        Button("Add folder", () => pickFiles("folder"), { size: "sm", iconName: "folder" }),
        Button("Clear", () => ((files = []), renderFiles()), { size: "sm" })),
      h("div", { class: "flex items-center gap-3 mt-3" },
        h("span", { class: "label-caps w-24 shrink-0" }, "Looks like"), refsBox,
        Button("Add picture", addPictures, { size: "sm", iconName: "image" })),
      h("p", { class: "text-muted text-[13px] mt-3 leading-snug" },
        "Tip: for a particular character, add two or three pictures of them, or click \"More like this\" on a result. The AI recognises how things look, not names it has never seen."),
      modelBox,
      h("div", { class: "flex items-center gap-2.5 mt-3 min-h-[2rem]" }, spin, statusText, h("span", { class: "ml-auto" }), continueBtn, pauseBtn, cancelBtn),
      barWrap);

    // ---- results + panel
    const grid = h("div", { class: "grid gap-4 grid-cols-[repeat(auto-fill,minmax(212px,1fr))] content-start" });
    const resultsArea = h("div", { class: "flex-1 min-w-0 scroll pr-2 pb-4" });
    const strictLbl = h("div", { class: "font-display text-[40px] leading-none" });
    const selLbl = h("p", { class: "text-muted text-[14px] leading-snug mb-3" }, "No results yet.");
    const packField = h("input", { class: "field w-full", placeholder: "Pack name" });
    const exportBtn = Button("Add to queue", exportSelected, { kind: "primary", size: "big", iconName: "plus", cls: "w-full" });
    exportBtn.disabled = true;
    const range = Range(strict, (v) => ((strict = v), paintStrict()), (v) => (SP.save({ ai_strict: v }), renderGrid(false)));
    const panel = sidePanel([
      panelSection("Show matches above", strictLbl, h("div", { class: "mt-3" }, range),
        h("div", { class: "flex justify-between text-muted text-[12px] mt-0.5" }, h("span", {}, "More results"), h("span", {}, "Closer matches"))),
      panelSection("Order", Seg([["Best match", "match"], ["Film order", "time"]], order, (v) => ((order = v), renderGrid(false)))),
      panelSection("Selection", h("div", { class: "flex gap-2" },
        Button("Select all", () => selectAll(true), { size: "sm" }), Button("Select none", () => selectAll(false), { size: "sm" }))),
      panelSection("Pack name", packField),
    ], [selLbl, exportBtn]);
    const el = h("section", { class: "flex flex-col min-h-0" },
      header("AI search", "Describe what you're after, then pick from the scenes that match.", []),
      searchCard,
      h("div", { class: "flex gap-6 px-8 pb-6 flex-1 min-h-0" }, resultsArea, panel));

    function paintStrict() {
      strictLbl.textContent = `${Math.round(strict * 100)}%`;
    }
    paintStrict();

    // ---- inputs
    async function pickFiles(kind) {
      const p = await window.sp.pick(kind);
      if (p.length) addFiles(p);
    }
    function addFiles(p) {
      for (const f of p) if (!files.includes(f)) files.push(f);
      renderFiles();
    }
    function renderFiles() {
      if (!files.length) {
        filesLbl.className = "flex-1 min-w-0 truncate text-[14px] text-muted";
        filesLbl.textContent = "No videos yet. Add films, or a show folder to search every episode.";
      } else {
        filesLbl.className = "flex-1 min-w-0 truncate text-[14px]";
        const names = files.slice(0, 4).map((f) => f.split(/[\\/]/).pop()).join(",  ");
        filesLbl.textContent = `${SP.plural(files.length, "item")}:  ${names}${files.length > 4 ? `  and ${files.length - 4} more` : ""}`;
      }
    }
    async function addPictures(paths) {
      if (!Array.isArray(paths)) paths = await window.sp.pick("pictures");
      for (const p of paths) {
        try {
          setBusyText("Reading picture...");
          applyResults(await SP.call("ai.addRefImage", { path: p }));
        } catch (e) {
          toast("Couldn't use that picture", errorText(e), "alert");
        }
      }
      setBusyText("");
    }
    function renderRefs() {
      refsBox.innerHTML = "";
      if (!results.refs.length) {
        refsBox.append(h("span", { class: "text-muted text-[14px]" }, "Optional: pictures of the person or thing you want"));
        return;
      }
      results.refs.forEach((r) => {
        const x = h("button", { class: "w-5 h-5 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-raised-2 cursor-pointer" }, icon("x", "w-3.5 h-3.5"));
        x.addEventListener("click", async () => applyResults(await SP.call("ai.removeRef", { id: r.id })));
        refsBox.append(h("span", { class: "chip sticker-sm !pl-1 !pr-1.5 anim-pop" },
          r.thumb ? h("img", { src: fileUrl(r.thumb), class: "w-7 h-7 rounded-full object-cover" }) : icon("image", "w-4 h-4"),
          h("span", { class: "max-w-[160px] truncate" }, r.label), x));
      });
    }
    function setBusyText(t) {
      statusText.textContent = t;
      statusText.className = "text-[14px] text-muted";
    }

    // ---- model
    function renderModel() {
      const a = SP.state.status.ai || {};
      modelBox.innerHTML = "";
      if (!a.available) {
        modelBox.append(h("div", { class: "mt-4 rounded-mat bg-felt p-4 text-[14px]" }, "AI search needs extra libraries. Install them with ",
          h("code", { class: "font-bold" }, "pip install -r requirements.txt"), "."));
        return;
      }
      if (a.installed) return;
      const where = a.device === "gpu" ? "on your graphics card" : "on your processor";
      modelBox.append(h("div", { class: "mt-4 rounded-mat bg-felt p-4 flex items-center gap-4 anim-rise" },
        h("div", { class: "w-11 h-11 rounded-xl bg-accent text-on-accent flex items-center justify-center sticker-sm shrink-0" }, icon("download")),
        h("div", { class: "flex-1" }, h("div", { class: "font-bold" }, "Download the AI model first"),
          h("div", { class: "text-muted text-[14px]" }, `${a.label}, about ${a.size} MB, one time only. It runs ${where}; nothing is uploaded.`)),
        Button("Download", download, { kind: "primary", iconName: "download" })));
    }
    async function download() {
      startBusy("Starting download...");
      try {
        await SP.call("ai.download");
        toast("AI model ready", "Everything runs on your PC from now on.", "up");
        setBusyText("AI model ready. Type a prompt and press Search.");
      } catch (e) {
        if (e.message !== "cancelled") toast("Download failed", errorText(e), "alert");
        setBusyText(e.message === "cancelled" ? "Download cancelled." : "");
      }
      endBusy();
    }

    // ---- search
    function startBusy(text, pausable) {
      busy = true;
      searchBtn.disabled = true;
      spin.hidden = false;
      cancelBtn.hidden = false;
      continueBtn.hidden = true;
      pauseBtn.hidden = !pausable;
      pauseBtn.disabled = false;
      pauseBtn.setLabel("Pause & show results");
      barWrap.hidden = false;
      bar.set(0, "", true);
      setBusyText(text);
    }
    function endBusy() {
      busy = false;
      searchBtn.disabled = false;
      spin.hidden = true;
      cancelBtn.hidden = true;
      pauseBtn.hidden = true;
      barWrap.hidden = true;
    }
    SP.on("aiProgress", (d) => {
      bar.set(d.p, "", true);
      setBusyText(d.text);
    });

    async function search(resume = false) {
      if (busy) return;
      const q = prompt.value.trim();
      if (!files.length) return toast("Add some videos first", "Use Add videos, or drop films on this page.", "warn");
      if (!q && !results.refs.length) return toast("What are you looking for?", "Type a description or add a picture.", "warn"), prompt.focus();
      const a = SP.state.status.ai || {};
      if (!a.installed) return download();
      if (!packField.value.trim() || packField.dataset.auto === packField.value) {
        packField.value = (q || results.refs[0].label).slice(0, 40);
        packField.dataset.auto = packField.value;
      }
      startBusy("Starting...", true);
      try {
        applyResults(await SP.call("ai.search", { files, prompt: q }), !resume);
      } catch (e) {
        if (e.message === "cancelled") setBusyText("Search cancelled.");
        else (statusText.textContent = errorText(e)), (statusText.className = "text-[14px] text-alert");
      }
      endBusy();
    }

    function applyResults(r, fresh) {
      results = r;
      if (fresh) {
        selected.clear();
        r.items.forEach((i) => i.match >= Math.max(strict, 0.5) && selected.add(i.id));
      } else {
        const ids = new Set(r.items.map((i) => i.id));
        [...selected].forEach((id) => !ids.has(id) && selected.delete(id));
      }
      renderRefs();
      renderGrid(true);
      const p = r.progress || {};
      if (r.items.length) {
        const shown = r.items.filter((i) => i.match >= strict).length;
        statusText.textContent = p.paused
          ? `Paused after ${p.searched} of ${SP.plural(p.total, "video")}. Showing the ${SP.plural(shown, "match", "matches")} found so far.`
          : `${SP.plural(shown, "matching scene")} out of ${r.items.length} in ${SP.plural(r.videos.length, "video")}.`;
        statusText.className = "text-[14px] text-ink";
      } else if (p.paused) {
        statusText.textContent = "Paused before anything was analysed.";
        statusText.className = "text-[14px] text-muted";
      }
      // Continue keeps the scenes already ticked; finished videos are remembered, so it carries on quickly.
      continueBtn.hidden = !p.paused;
    }

    function visible() {
      const v = results.items.filter((i) => i.match >= strict);
      v.sort(order === "match" ? (a, b) => b.match - a.match : (a, b) => a.vi - b.vi || a.a - b.a);
      return v.slice(0, 400);
    }

    // thumbnails load as tiles scroll into view, two at a time
    const queue = [];
    let loading = 0;
    function pump() {
      while (loading < 2 && queue.length) {
        const { img, item } = queue.shift();
        if (!img.isConnected) continue;
        loading++;
        SP.call("ai.thumb", { vi: item.vi, t: item.t })
          .then((p) => p && ((img.src = fileUrl(p)), img.addEventListener("load", () => img.classList.remove("opacity-0"), { once: true })))
          .catch(() => {})
          .finally(() => (loading--, pump()));
      }
    }
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        queue.push(e.target._load);
        pump();
      }
    }, { root: resultsArea, rootMargin: "300px" });

    function Tile(item, i, animate) {
      const v = results.videos[item.vi];
      const img = h("img", { class: "absolute inset-0 w-full h-full object-cover opacity-0 transition-opacity duration-500" });
      const pct = Math.round(item.match * 100);
      const tone = item.match >= 0.75 ? "!bg-up !text-page" : item.match >= 0.5 ? "!bg-accent !text-on-accent" : "";
      const check = h("span", { class: "absolute top-2.5 left-2.5 w-7 h-7 rounded-full flex items-center justify-center sticker-sm transition-colors duration-300" });
      const frame = h("button", { class: "relative block w-full aspect-video rounded-[12px] overflow-hidden bg-felt cursor-pointer" },
        h("span", { class: "absolute inset-0 flex items-center justify-center" }, Spinner()), img, check,
        h("span", { class: `absolute top-2.5 right-2.5 chip sticker-sm ${tone}` }, `${pct}%`));
      const card = h("div", { class: `tile sticker p-2.5 transition-[box-shadow,transform] duration-200 ease-snap hover:-translate-y-0.5 ${animate ? "anim-rise" : ""}`, style: animate ? { animationDelay: `${Math.min(i, 24) * 22}ms` } : {} },
        frame,
        h("div", { class: "px-1.5 pt-2.5 pb-1" },
          h("div", { class: "font-bold truncate" }, v.label),
          h("div", { class: "text-muted text-[13px] tabular-nums" }, `${item.start}  ·  ${item.len} s`),
          h("div", { class: "flex gap-4 mt-2 text-[13px]" },
            h("span", { class: "link", onclick: () => SP.call("preview", { vi: item.vi, a: item.a, b: item.b }).catch((e) => toast("Can't preview", errorText(e), "warn")) }, "Preview"),
            h("span", { class: "link", onclick: () => moreLike(item) }, "More like this"))));
      const paint = (pop) => {
        const on = selected.has(item.id);
        card.style.outline = on ? "3px solid var(--c-accent)" : "3px solid transparent";
        card.style.outlineOffset = "-1px";
        check.className = `absolute top-2.5 left-2.5 w-7 h-7 rounded-full flex items-center justify-center sticker-sm transition-colors duration-300 ${on ? "bg-accent text-on-accent" : "bg-page/70 text-transparent"}`;
        check.innerHTML = "";
        check.append(h("span", { class: pop ? "anim-pop" : "" }, icon("check", "w-4 h-4")));
      };
      frame.addEventListener("click", () => {
        selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id);
        paint(true);
        updateSelection();
      });
      card.style.transition = "outline-color .24s, transform .2s";
      paint(false);
      frame._load = { img, item };
      observer.observe(frame);
      return card;
    }

    function renderGrid(animate) {
      grid.innerHTML = "";
      resultsArea.innerHTML = "";
      if (!results.items.length) {
        resultsArea.append(SP.Empty("Find scenes by describing them",
          "Add films or episodes above, type something like \"two people arguing in a kitchen\", then press Search."));
      } else {
        const vis = visible();
        if (!vis.length) resultsArea.append(h("div", { class: "tile sticker p-8 text-center text-muted anim-rise" }, "Nothing matches that closely. Drag the slider towards More results."));
        vis.forEach((item, i) => grid.append(Tile(item, i, animate)));
        resultsArea.append(grid);
        resultsArea.scrollTop = 0;
      }
      updateSelection();
    }

    function selectAll(on) {
      visible().forEach((i) => (on ? selected.add(i.id) : selected.delete(i.id)));
      renderGrid(false);
    }
    function chosen() {
      return results.items.filter((i) => selected.has(i.id) && i.match >= strict);
    }
    function updateSelection() {
      const c = chosen();
      exportBtn.disabled = !c.length || busy;
      if (!results.items.length) return (selLbl.textContent = "No results yet.");
      const secs = c.reduce((a, i) => a + (i.b - i.a), 0);
      selLbl.textContent = `${SP.plural(c.length, "scene")} selected  ·  ${(secs / 60).toFixed(1)} min of footage`;
    }

    async function moreLike(item) {
      try {
        applyResults(await SP.call("ai.addRefScene", { vi: item.vi, t: item.t }));
        toast("Added as a reference", "Results now favour scenes that look like that one.");
      } catch (e) {
        toast("Couldn't use that scene", errorText(e), "alert");
      }
    }

    async function exportSelected() {
      const c = chosen();
      if (!c.length) return;
      try {
        const r = await SP.call("ai.queue", { pack: packField.value.trim(), items: c.map((i) => ({ vi: i.vi, n: i.n, a: i.a, b: i.b })) });
        if (r.added) toast(`${SP.plural(c.length, "scene")} added to the queue`, "Press Start when you're ready.");
        else toast("Already in the queue", "Those scenes are queued already.", "warn");
        SP.go("queue");
      } catch (e) {
        toast("Couldn't add those", errorText(e), "alert");
      }
    }

    function onDrop(paths) {
      const pics = paths.filter((p) => /\.(jpe?g|png|webp|bmp)$/i.test(p));
      const vids = paths.filter((p) => !pics.includes(p));
      if (vids.length) addFiles(vids);
      if (pics.length) addPictures(pics);
    }

    SP.aiDownload = () => !busy && download();
    SP.on("status", renderModel);
    renderFiles();
    renderRefs();
    renderModel();
    renderGrid(false);
    return { el, onDrop, focus: () => prompt.focus(), onShow: () => setTimeout(() => prompt.focus(), 300), search: (f, q) => ((files = f), renderFiles(), (prompt.value = q), search()) };
  };
})(window.SP);
