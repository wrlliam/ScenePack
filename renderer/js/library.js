/* Library page: every clip you've made, grouped by film or season. Pick clips from anywhere and export them to one folder. */
(function (SP) {
  const { h, icon, Button, Seg, Switch, Bar, Spinner, toast, fileUrl, errorText, shortPath, plural } = SP;

  const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`);
  const store = {
    get: (k, d) => {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
  };

  SP.LibraryPage = function () {
    const { header, panelSection, row, sidePanel } = SP.parts;
    let groups = [], roots = [], loaded = false, stale = true, exporting = false, lastExport = null, doneMsg = "";
    const meta = {};
    const selected = new Map(); // path -> { path, group }
    const open = new Set(store.get("libOpen", []));
    let filter = "";
    let dest = store.get("libDest", "");
    let mode = "copy", perFilm = store.get("libPerFilm", false);
    const cards = new Map(); // path -> card element (for live updates)
    let sizes = new Map(); // path -> file size, for quick selection totals

    // ---------------------------------------------------------------- side panel
    const selCount = h("div", { class: "font-display text-[36px] leading-none" }, "0");
    const selDetail = h("div", { class: "text-muted text-[13px] mt-1.5 leading-snug" }, "Click clips to select them. Shift-click selects a run.");
    const destLbl = h("div", { class: "text-[13px] break-all leading-snug" });
    const rootsBox = h("div", { class: "flex flex-col gap-1.5" });
    const status = h("p", { class: "text-muted text-[13px] leading-snug mb-2.5" });
    const bar = Bar();
    const barWrap = h("div", { class: "mb-3", hidden: true }, bar);
    const exportBtn = Button("Export clips", exportSelected, { kind: "primary", iconName: "download", cls: "w-full" });
    const openBtn = Button("Open export folder", () => lastExport && window.sp.openPath(lastExport), { size: "sm", iconName: "folder", cls: "w-full mt-2" });
    openBtn.hidden = true;
    const panel = sidePanel([
      panelSection("Selected", selCount, selDetail,
        h("div", { class: "flex gap-2 mt-3" }, Button("Select none", () => (selected.clear(), refreshSelection()), { size: "sm" }))),
      panelSection("Export to", destLbl,
        h("div", { class: "flex gap-2 mt-2.5" }, Button("Choose folder", chooseDest, { size: "sm", iconName: "folder" }))),
      panelSection("Options",
        Seg([["Copy", "copy"], ["Move", "move"]], mode, (v) => (mode = v)),
        h("p", { class: "text-muted text-[12px] mt-2 leading-snug" }, "Copy keeps the originals in their scenepacks. Move takes them out."),
        row("A folder per film", Switch(perFilm, (v) => ((perFilm = v), store.set("libPerFilm", v))))),
      panelSection("Library folders", rootsBox,
        h("div", { class: "mt-2.5" }, Button("Add folder", addRoot, { size: "sm", iconName: "plus" }))),
    ], [status, barWrap, exportBtn, openBtn]);

    function paintDest() {
      destLbl.textContent = dest ? shortPath(dest, 56) : "Not chosen yet. You'll be asked when you export.";
      destLbl.className = `text-[13px] break-all leading-snug ${dest ? "" : "text-muted"}`;
    }
    paintDest();
    async function chooseDest() {
      const [p] = await window.sp.pick("folder");
      if (p) (dest = p), store.set("libDest", p), paintDest();
      return p;
    }
    function paintRoots() {
      rootsBox.innerHTML = "";
      roots.forEach((r, i) =>
        rootsBox.append(h("div", { class: "flex items-center gap-2 text-[13px]" },
          icon("folder", "w-4 h-4 text-muted"), h("span", { class: "truncate flex-1", title: r }, shortPath(r, 34)),
          i === 0 ? h("span", { class: "text-muted text-[12px]" }, "output")
            : h("button", { class: "link text-[12px]", onclick: () => removeRoot(r) }, "remove"))));
    }
    async function addRoot() {
      const [p] = await window.sp.pick("folder");
      if (!p) return;
      apply(await SP.call("library.addRoot", { path: p }));
      toast("Folder added to the Library", shortPath(p, 50));
    }
    async function removeRoot(p) {
      apply(await SP.call("library.removeRoot", { path: p }));
    }

    // ---------------------------------------------------------------- list
    const searchField = h("input", { class: "field w-full", placeholder: "Filter by film, show or clip name" });
    let filterTimer;
    searchField.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => ((filter = searchField.value.trim().toLowerCase()), render()), 180);
    });
    const summary = h("span", { class: "text-muted text-[14px] whitespace-nowrap" });
    const listInner = h("div", { class: "flex flex-col gap-3" });
    const list = h("div", { class: "flex-1 min-w-0 scroll pr-2 pb-4" },
      h("div", { class: "flex items-center gap-4 mb-4" }, searchField, summary), listInner);

    const refreshBtn = Button("Refresh", () => load(true), { iconName: "refresh" });
    const el = h("section", { class: "flex flex-col min-h-0" },
      header("Library", "Every clip you've made. Pick clips from any film and export them into one folder.", [refreshBtn]),
      h("div", { class: "flex gap-6 px-8 pb-6 flex-1 min-h-0" }, list, panel));

    async function load(force) {
      if (!force && !stale && loaded) return;
      refreshBtn.disabled = true;
      try {
        apply(await SP.call("library.scan"));
      } catch (e) {
        toast("Couldn't read the Library", errorText(e), "alert");
      }
      refreshBtn.disabled = false;
    }
    function apply(r) {
      roots = r.roots;
      groups = r.groups;
      loaded = true;
      stale = false;
      sizes = new Map(groups.flatMap((g) => g.clips.map((c) => [c.path, c.size])));
      [...selected.keys()].forEach((p) => !sizes.has(p) && selected.delete(p));
      paintRoots();
      render();
    }

    function matches(g) {
      if (!filter) return g.clips;
      if (g.title.toLowerCase().includes(filter) || g.sources.join(" ").toLowerCase().includes(filter)) return g.clips;
      return g.clips.filter((c) => c.name.toLowerCase().includes(filter));
    }

    // ---- infinite scroll: folders and clips are added in chunks as you near the bottom, so even a whole film
    // with thousands of clips only ever has a few dozen cards (and thumbnails) on the page at once.
    const CLIP_CHUNK = 48;
    const GROUP_CHUNK = 20;
    const moreObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && e.target._more) e.target._more();
    }, { root: list, rootMargin: "700px" });
    // A sentinel only fires when it starts intersecting, so after each chunk it is re-observed: if it is
    // still near the bottom (the chunk was short), the next chunk loads straight away.
    const rearm = (s) => (moreObserver.unobserve(s), moreObserver.observe(s));
    const loadingRow = (text) =>
      h("div", { class: "flex items-center justify-center gap-2.5 py-4 text-muted text-[13px]" }, Spinner(), h("span", {}, text));
    let groupTiles = [];

    function render() {
      listInner.innerHTML = "";
      cards.clear();
      groupTiles = [];
      const total = groups.reduce((a, g) => a + g.count, 0);
      summary.textContent = groups.length ? `${plural(total, "clip")} in ${plural(groups.length, "folder")}` : "";
      if (!groups.length) {
        listInner.append(SP.Empty("No clips yet", "Clips you make show up here, grouped by film. Add films on the Queue page, or add another folder to the Library.", [
          Button("Go to the Queue", () => SP.go("queue"), { kind: "primary" }),
          Button("Add folder", addRoot, { iconName: "folder" }),
        ]));
        return refreshSelection();
      }
      const visible = [];
      for (const g of groups) {
        const clips = matches(g);
        if (clips.length) visible.push([g, clips]);
      }
      if (!visible.length) {
        listInner.append(h("div", { class: "tile sticker p-8 text-center text-muted anim-rise" }, `Nothing matches "${filter}".`));
        return refreshSelection();
      }
      let shown = 0;
      const sentinel = loadingRow("Loading more folders...");
      const addGroups = () => {
        visible.slice(shown, shown + GROUP_CHUNK).forEach(([g, clips]) => listInner.insertBefore(Group(g, clips, shown++), sentinel));
        if (shown >= visible.length) return moreObserver.unobserve(sentinel), sentinel.remove();
        rearm(sentinel);
      };
      sentinel._more = addGroups;
      listInner.append(sentinel);
      addGroups();
      refreshSelection();
    }

    function Group(g, clips, index) {
      const isOpen = open.has(g.id) || !!filter;
      const chev = h("span", { class: `inline-flex transition-transform duration-300 ease-back ${isOpen ? "rotate-90" : ""}` }, icon("chevron", "w-5 h-5"));
      const selBtn = h("button", { class: "chip sticker-sm cursor-pointer hover:!bg-raised-2 transition-colors duration-200" });
      const paintSel = () => {
        const n = clips.filter((c) => selected.has(c.path)).length;
        selBtn.className = `chip sticker-sm cursor-pointer transition-colors duration-200 ${n === clips.length ? "!bg-accent !text-on-accent" : "hover:!bg-raised-2"}`;
        selBtn.textContent = n === clips.length ? "All selected" : n ? `${n} selected` : "Select all";
      };
      selBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const all = clips.every((c) => selected.has(c.path));
        clips.forEach((c) => (all ? selected.delete(c.path) : selected.set(c.path, { path: c.path, group: g.title })));
        refreshSelection();
      });
      const openFolder = h("button", { class: "w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-raised-2 cursor-pointer", title: "Open folder" }, icon("folder", "w-[18px] h-[18px]"));
      openFolder.addEventListener("click", (e) => (e.stopPropagation(), window.sp.openPath(g.path)));
      const head = h("div", { class: "flex items-center gap-3 px-4 py-3.5 cursor-pointer select-none" },
        chev,
        h("div", { class: "min-w-0 flex-1" },
          h("div", { class: "flex items-center gap-2.5 min-w-0" },
            h("span", { class: "font-display text-[18px] leading-tight truncate" }, g.title),
            h("span", { class: "chip sticker-sm !font-semibold !text-muted shrink-0" }, plural(clips.length, "clip")),
            h("span", { class: "text-muted text-[13px] shrink-0" }, fmtSize(g.size))),
          h("div", { class: "text-muted text-[12px] truncate mt-0.5" }, g.sources.length ? `From ${g.sources.join(", ")}` : shortPath(g.path, 80))),
        selBtn, openFolder);
      const body = h("div", { class: "overflow-hidden transition-[height] duration-300 ease-snap" });
      const tile = h("div", { class: "tile sticker anim-rise", style: { animationDelay: `${Math.min(index % GROUP_CHUNK, 10) * 35}ms` } }, head, body);
      tile._paintSel = paintSel;
      groupTiles.push(tile);
      paintSel();

      const fill = () => {
        const grid = h("div", { class: "grid gap-3 grid-cols-[repeat(auto-fill,minmax(176px,1fr))] px-4 pb-4" });
        body.append(grid);
        let rendered = 0;
        const more = clips.length > CLIP_CHUNK ? loadingRow("") : null;
        const addClips = () => {
          const chunk = clips.slice(rendered, rendered + CLIP_CHUNK);
          const frag = document.createDocumentFragment();
          chunk.forEach((c, k) => frag.append(Clip(c, g, clips, rendered + k)));
          grid.append(frag);
          rendered += chunk.length;
          loadMeta(chunk);
          if (!more) return;
          if (rendered >= clips.length) return moreObserver.unobserve(more), more.remove();
          more.lastChild.textContent = `Showing ${rendered} of ${clips.length} clips  ·  loading more as you scroll`;
          rearm(more);
        };
        if (more) {
          more._more = addClips;
          body.append(more);
        }
        addClips();
      };
      if (isOpen) fill();
      else body.style.height = "0px";
      head.addEventListener("click", () => {
        const opening = !open.has(g.id);
        opening ? open.add(g.id) : open.delete(g.id);
        store.set("libOpen", [...open]);
        chev.classList.toggle("rotate-90", opening);
        if (opening) {
          if (!body.firstChild) fill();
          body.style.height = "0px";
          requestAnimationFrame(() => (body.style.height = body.scrollHeight + "px"));
          setTimeout(() => (body.style.height = ""), 320);
        } else {
          body.style.height = body.scrollHeight + "px";
          requestAnimationFrame(() => (body.style.height = "0px"));
        }
      });
      return tile;
    }

    let lastClicked = null;
    function Clip(c, g, clips, i) {
      const img = h("img", { class: "absolute inset-0 w-full h-full object-cover opacity-0 transition-opacity duration-500", draggable: "false" });
      const check = h("span", { class: "absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center sticker-sm transition-colors duration-200" });
      const lenChip = h("span", { class: "absolute bottom-2 right-2 chip sticker-sm !text-[11px] !px-2 !py-0.5 hidden" });
      const thumb = h("div", { class: "relative aspect-video rounded-[10px] overflow-hidden bg-felt" },
        h("span", { class: "absolute inset-0 flex items-center justify-center" }, Spinner()), img, check, lenChip);
      const metaLine = h("div", { class: "text-muted text-[12px] truncate tabular-nums" });
      const card = h("div", { class: "rounded-[14px] bg-raised-2 p-2 cursor-pointer transition-[transform,outline-color] duration-200 hover:-translate-y-0.5", title: `${c.name}\nDouble-click to play` },
        thumb,
        h("div", { class: "px-1 pt-2 pb-0.5" },
          h("div", { class: "font-bold text-[14px] truncate" }, c.scene ? `Scene ${c.scene}` : c.name.replace(/\.[^.]+$/, ""),
            c.start ? h("span", { class: "text-muted font-semibold" }, `  ·  ${c.start}`) : null),
          metaLine));
      card.paint = (pop) => {
        const on = selected.has(c.path);
        if (on === card._on && !pop) return; // nothing changed: skip the DOM work
        card._on = on;
        card.style.outline = on ? "3px solid var(--c-accent)" : "3px solid transparent";
        card.style.outlineOffset = "-1px";
        check.className = `absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center sticker-sm transition-colors duration-200 ${on ? "bg-accent text-on-accent" : "bg-page/70 text-transparent"}`;
        check.innerHTML = "";
        check.append(h("span", { class: pop && on ? "anim-pop" : "" }, icon("check", "w-3.5 h-3.5")));
      };
      card.meta = () => {
        const m = meta[c.path];
        if (!m) return (metaLine.textContent = fmtSize(c.size));
        const res = m.height ? `${m.height}p` : "";
        metaLine.textContent = [m.length, res, m.fps ? `${Math.round(m.fps)} fps` : "", m.vcodec, fmtSize(c.size)].filter(Boolean).join("  ·  ");
        lenChip.textContent = m.length;
        lenChip.classList.remove("hidden");
      };
      card.paint(false);
      card.meta();
      cards.set(c.path, card);

      card.addEventListener("click", (e) => {
        if (e.shiftKey && lastClicked && lastClicked.g === g) {
          const [a, b] = [lastClicked.i, i].sort((x, y) => x - y);
          for (let k = a; k <= b; k++) selected.set(clips[k].path, { path: clips[k].path, group: g.title });
        } else if (selected.has(c.path)) selected.delete(c.path);
        else selected.set(c.path, { path: c.path, group: g.title });
        const range = e.shiftKey && lastClicked && lastClicked.g === g;
        lastClicked = { g, i };
        refreshSelection(range ? undefined : c.path);
      });
      card.addEventListener("dblclick", () => window.sp.openPath(c.path));

      // hover to play a silent preview
      let timer, video;
      thumb.addEventListener("mouseenter", () => {
        timer = setTimeout(() => {
          video = h("video", { class: "absolute inset-0 w-full h-full object-cover", src: fileUrl(c.path), muted: true, autoplay: true, loop: true, playsinline: true });
          video.muted = true;
          video.addEventListener("error", () => video && video.remove());
          thumb.insertBefore(video, check);
        }, 280);
      });
      thumb.addEventListener("mouseleave", () => {
        clearTimeout(timer);
        if (video) video.remove(), (video = null);
      });

      thumb._load = { img, c };
      observer.observe(thumb);
      return card;
    }

    // Thumbnails load as cards come near the screen, four at a time. The newest request goes first, and a card
    // scrolled away before its turn is skipped (and asked for again if it comes back), so fast scrolling through a
    // whole film fills in what you're looking at instead of everything you passed on the way.
    const queue = new Set();
    let loading = 0;
    function pump() {
      while (loading < 4 && queue.size) {
        const thumb = [...queue].pop();
        queue.delete(thumb);
        const { img, c } = thumb._load;
        if (!img.isConnected || !thumb._near) continue;
        observer.unobserve(thumb);
        loading++;
        SP.call("library.thumb", { path: c.path, duration: (meta[c.path] || {}).duration || 0 })
          .then((p) => p && ((img.src = fileUrl(p)), img.addEventListener("load", () => img.classList.remove("opacity-0"), { once: true })))
          .catch(() => {})
          .finally(() => (loading--, pump()));
      }
    }
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        e.target._near = e.isIntersecting;
        if (e.isIntersecting) queue.add(e.target);
        else queue.delete(e.target);
      }
      pump();
    }, { root: list, rootMargin: "300px" });

    async function loadMeta(clips) {
      const need = clips.map((c) => c.path).filter((p) => !(p in meta));
      for (let i = 0; i < need.length; i += 40) {
        try {
          const r = await SP.call("library.meta", { paths: need.slice(i, i + 40) });
          Object.assign(meta, r);
          Object.keys(r).forEach((p) => cards.get(p) && cards.get(p).meta());
          if (Object.keys(r).some((p) => selected.has(p))) paintSummary();
        } catch {}
      }
    }

    // ---------------------------------------------------------------- selection + export
    function refreshSelection(changed) {
      if (changed && cards.get(changed)) cards.get(changed).paint(true);
      else cards.forEach((card) => card.paint(false)); // cheap: cards skip work when nothing changed
      groupTiles.forEach((t) => t.isConnected && t._paintSel());
      paintSummary();
    }

    function paintSummary() {
      const items = [...selected.values()];
      const films = new Set(items.map((i) => i.group)).size;
      let secs = 0, bytes = 0, known = true;
      for (const i of items) {
        const m = meta[i.path];
        if (m) secs += m.duration || 0;
        else known = false; // details for clips not scrolled to yet aren't loaded: don't show a partial total
        bytes += sizes.get(i.path) || 0;
      }
      selCount.textContent = String(items.length);
      selDetail.textContent = items.length
        ? `${plural(items.length, "clip")} from ${plural(films, "film")}${known && secs ? `  ·  ${fmtDur(secs)}` : ""}  ·  ${fmtSize(bytes)}`
        : "Click clips to select them. Shift-click selects a run.";
      exportBtn.disabled = !items.length || exporting;
      exportBtn.setLabel(items.length ? `Export ${plural(items.length, "clip")}` : "Export clips");
      if (items.length) doneMsg = "";
      if (!exporting) status.textContent = items.length ? `Ready to ${mode} into ${dest ? shortPath(dest, 40) : "a folder you choose"}.` : doneMsg;
    }

    async function exportSelected() {
      const items = [...selected.values()];
      if (!items.length) return;
      if (!dest && !(await chooseDest())) return;
      exporting = true;
      exportBtn.disabled = true;
      openBtn.hidden = true;
      barWrap.hidden = false;
      bar.set(0, "", true);
      status.textContent = `Exporting ${plural(items.length, "clip")}...`;
      try {
        const r = await SP.call("library.export", { items, dest, mode, subfolders: perFilm });
        lastExport = r.dest;
        bar.set(1, "done", false);
        doneMsg = `${plural(r.done, "clip")} ${mode === "move" ? "moved" : "copied"} to ${shortPath(r.dest, 40)}.${r.skipped.length ? `  ${r.skipped.length} skipped.` : ""}`;
        toast(`${plural(r.done, "clip")} exported`, `Ready for editing in ${shortPath(r.dest, 46)}`, "up");
        openBtn.hidden = false;
        selected.clear();
        if (mode === "move") await load(true);
      } catch (e) {
        status.textContent = errorText(e);
        toast("Export failed", errorText(e), "alert");
      }
      exporting = false;
      setTimeout(() => (barWrap.hidden = true), 1500);
      refreshSelection();
    }
    SP.on("libraryProgress", (d) => {
      bar.set(d.done / d.total, "", true);
      status.textContent = `Exporting ${d.done} of ${d.total}  ·  ${d.name}`;
    });
    SP.on("jobs", (d) => {
      if (d.finished) stale = true;
    });

    return {
      el,
      onShow: () => load(false),
      focus: () => searchField.focus(),
      setDest: (p) => ((dest = p), store.set("libDest", p), paintDest(), refreshSelection()),
    };
  };
})(window.SP);
